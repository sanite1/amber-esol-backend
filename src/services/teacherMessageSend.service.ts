/**
 * Teacher messaging service — Final Addendum §11, Phase 24.
 *
 *   POST /api/teacher/learners/:id/message
 *
 * Sends a short (1-300 char) message from a teacher to a learner.
 * The message lands as a TeacherMessage row (the durable in-
 * product inbox) and triggers a content-free "you have a message"
 * email if the learner has a real (non-placeholder) email on file.
 *
 * Pipeline
 * ========
 *
 *   1. Validate (defensive — Joi runs at the route).
 *   2. Assignment gate: learner exists, is a student, is assigned
 *      to this teacher, has an orgId (same 404-vs-403 disambiguation
 *      as the other teacher endpoints).
 *   3. Optional translation. When `translate_to_l1: true` AND the
 *      learner's `l1Language` is not English, call Gemini with
 *      `responseMimeType: "application/json"` requesting
 *      `{ translated: string }`. Use the translated text as the
 *      learner-facing `message_text` and preserve the English
 *      original in `original_text`. Translation failure is HARD
 *      (502) — the teacher asked for L1 delivery; silently
 *      sending English would defeat the purpose. The error
 *      message tells the teacher how to retry.
 *   4. Create the TeacherMessage row.
 *   5. AuditLog `teacher_message_sent`.
 *   6. If the learner has a real (non-placeholder) email, enqueue
 *      a CONTENT-FREE alert on the notifications queue. The email
 *      payload carries the recipient id + sender name + message
 *      id only — never the message body. The body is read from the
 *      TeacherMessage row when the learner lands in-product.
 *   7. Return the created row.
 *
 * Atomicity
 * =========
 *
 *   - TeacherMessage.create is the durable artefact. Audit + email
 *     enqueue are best-effort downstream (writeAuditLog swallows
 *     persist failures with a logger.error; the email enqueue is
 *     try/catch'd here for the same reason).
 *   - If the email enqueue fails after the row is created, the
 *     teacher still sees a 201 — the message IS in the learner's
 *     in-product inbox. The email is the secondary channel; the
 *     primary surface (the in-product feed) is the source of truth.
 *
 * Privacy invariants
 * ==================
 *
 *   1. Translation goes only one way (teacher's English → learner's
 *      L1). We never call Gemini on learner-originated content.
 *   2. The Nodemailer payload NEVER carries `message_text` or
 *      `original_text`. Email recipients see "you have a new
 *      tutor message" with a sign-in link; the body lives only
 *      in-product behind auth.
 */

import { Types } from "mongoose";
import { Request } from "express";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import TeacherMessage from "../models/TeacherMessage";
import TeacherReview from "../models/TeacherReview";
import {
  glhContributionHours,
  MESSAGE_CONTACT_DURATION_MINS,
} from "./teacherGlhContribution";
import { writeAuditLog } from "./auditLog.service";
import { notificationsQueue } from "../queues";
import { translateTeacherMessage } from "./teacherMessageTranslate.service";
import logger from "../config/logger";
import type { TeacherMessageTrigger } from "../interfaces/teacherMessage.interface";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface SendTeacherMessageBody {
  message_text: string;
  translate_to_l1: boolean;
  trigger?: TeacherMessageTrigger;
}

export interface SendTeacherMessageInput {
  learner_id: string;
  teacher_id: string;
  body: SendTeacherMessageBody;
  /** Passed through for impersonation context on the audit row. */
  req?: Request;
}

export interface SendTeacherMessageResult {
  message: {
    _id: string;
    teacher_id: string;
    learner_id: string;
    org_id: string;
    message_text: string;
    original_text: string | null;
    language: string;
    sent_at: string;
    read_at: null;
    trigger: TeacherMessageTrigger;
  };
  /** True when an alert email was enqueued; false when skipped (placeholder email). */
  email_enqueued: boolean;
  /** True when translation was applied; false when sent untranslated. */
  translated: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * The CSV bulk-importer mints synthetic emails of the shape
 * `…csv-placeholder…@…` when a learner record arrives without one.
 * Those addresses don't reach a human; sending Nodemailer to them
 * pollutes our bounce rate and wastes a queue slot.
 *
 * The check mirrors `isPlaceholderEmail` in learnerNudge.service.ts —
 * keeping the predicate identical means a placeholder learner is
 * consistently invisible to outbound email across the platform.
 */
const isPlaceholderEmail = (email: string | null | undefined): boolean => {
  if (typeof email !== "string") return true;
  if (email.trim().length === 0) return true;
  return /csv-placeholder/i.test(email);
};

const isEnglish = (lang: string | null | undefined): boolean => {
  if (!lang) return true; // null / missing → treat as English (safest default)
  return lang.toString().trim().toLowerCase() === "english";
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const sendTeacherMessageService = async (
  input: SendTeacherMessageInput,
): Promise<ApiResponse> => {
  // ── Input validation (defensive — Joi has run) ────────────────
  if (!input.learner_id || !Types.ObjectId.isValid(input.learner_id)) {
    throw new ApiError(400, "learner id must be a valid ObjectId");
  }
  if (!input.teacher_id || !Types.ObjectId.isValid(input.teacher_id)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }
  const body = input.body;
  const messageText =
    typeof body?.message_text === "string" ? body.message_text.trim() : "";
  if (messageText.length === 0) {
    throw new ApiError(400, "message_text is required");
  }
  if (messageText.length > 300) {
    throw new ApiError(400, "message_text must be 300 characters or fewer");
  }
  if (typeof body.translate_to_l1 !== "boolean") {
    throw new ApiError(400, "translate_to_l1 is required (boolean)");
  }
  const trigger: TeacherMessageTrigger = body.trigger ?? "manual";

  const learnerObjectId = new Types.ObjectId(input.learner_id);
  const teacherObjectId = new Types.ObjectId(input.teacher_id);

  // ── 1. Assignment gate ────────────────────────────────────────
  const learner = await User.findById(learnerObjectId)
    .select(
      "_id firstname lastname email role assigned_teacher_id orgId l1Language",
    )
    .lean();
  if (!learner || learner.role !== "student") {
    throw new ApiError(404, "Learner not found");
  }
  const assignedTo = (
    learner as { assigned_teacher_id?: Types.ObjectId | null }
  ).assigned_teacher_id;
  if (!assignedTo || assignedTo.toString() !== input.teacher_id) {
    throw new ApiError(403, "Forbidden — this learner is not assigned to you.");
  }
  const orgId = (learner as { orgId?: Types.ObjectId | null }).orgId;
  if (!orgId) {
    throw new ApiError(
      500,
      "Learner has no org assignment — cannot send message without one",
    );
  }
  const l1Language =
    (learner as { l1Language?: string | null }).l1Language ?? "english";

  // ── 2. Optional translation ──────────────────────────────────
  // The brief: translate only when both `translate_to_l1` is true
  // AND the learner's L1 isn't English. Skip translation for
  // English-L1 learners even when the flag is on — translating
  // English-to-English wastes a Gemini call and risks subtle
  // rewording the teacher didn't authorise.
  let finalText = messageText;
  let originalText: string | null = null;
  let outputLanguage = "en";
  let translated = false;

  if (body.translate_to_l1 && !isEnglish(l1Language)) {
    try {
      finalText = await translateTeacherMessage(messageText, l1Language);
      originalText = messageText;
      // Store the requested L1 string verbatim — language tags
      // live on the User record and we don't reinvent ISO mapping
      // here (Phase 19 ships a single source-of-truth helper).
      outputLanguage = l1Language;
      translated = true;
    } catch (err) {
      logger.error(
        {
          err: (err as Error).message,
          learner_id: input.learner_id,
          teacher_id: input.teacher_id,
          target_language: l1Language,
        },
        "sendTeacherMessage: translation failed — refusing to silently send English",
      );
      throw new ApiError(
        502,
        "Translation service unavailable. Try again in a moment, or untick " +
          "'translate to learner's language' to send the message in English.",
      );
    }
  }

  // ── 3. Create the TeacherMessage row ──────────────────────────
  const sentAt = new Date();
  const messageDoc = await TeacherMessage.create({
    teacher_id: teacherObjectId,
    learner_id: learnerObjectId,
    org_id: orgId,
    message_text: finalText,
    original_text: originalText,
    language: outputLanguage,
    sent_at: sentAt,
    read_at: null,
    trigger,
  });

  // ── 3b. TeacherReview + GLH credit (Final Addendum §11) ──────
  // A written message IS documented teacher contact: the addendum
  // specifies a contact_session review at a standard 5 minutes,
  // which also feeds glh_teacher_contact (and therefore the ILR
  // claim) and refreshes teacher_last_reviewed_at. Best-effort —
  // the message row above is the durable artefact; a failure here
  // is logged loudly but doesn't roll the message back.
  try {
    await TeacherReview.create({
      learner_id: learnerObjectId,
      teacher_id: teacherObjectId,
      org_id: orgId,
      review_type: "contact_session",
      duration_mins: MESSAGE_CONTACT_DURATION_MINS,
      notes: `Sent a written message (${outputLanguage}); trigger=${trigger}.`,
      ai_recommendation_acted_on: trigger === "priority_queue",
      created_at: sentAt,
    });
    await User.updateOne(
      { _id: learnerObjectId },
      {
        $inc: {
          glh_teacher_contact: glhContributionHours(
            "contact_session",
            MESSAGE_CONTACT_DURATION_MINS,
          ),
        },
        $set: { teacher_last_reviewed_at: sentAt },
      },
    );
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        learnerId: input.learner_id,
        messageId: (messageDoc._id as Types.ObjectId).toString(),
      },
      "teacherMessageSend: TeacherReview/GLH write failed — message sent but contact not credited",
    );
  }

  // ── 4. AuditLog ───────────────────────────────────────────────
  // The reason carries length + language + trigger so an org admin
  // reading the audit log gets the shape of the message without
  // the content. Content lives only on the TeacherMessage row,
  // which is org-scoped to begin with.
  await writeAuditLog(
    {
      actor_type: "teacher",
      actor_id: input.teacher_id,
      org_id: orgId,
      learner_id: input.learner_id,
      action: "teacher_message_sent",
      before_state: null,
      after_state: {
        message_id: (messageDoc._id as Types.ObjectId).toString(),
        length: finalText.length,
        language: outputLanguage,
        translated,
        trigger,
      },
      reason:
        `Teacher sent a ${finalText.length}-char message (${outputLanguage}` +
        `${translated ? `, translated from en` : ""}); trigger=${trigger}.`,
    },
    { req: input.req },
  );

  // ── 5. Email alert (content-free) ────────────────────────────
  // Best-effort enqueue — a Redis hiccup must not roll back the
  // message. The learner can still see the message in-product;
  // the email is a secondary "you have something waiting" ping.
  let emailEnqueued = false;
  const learnerEmail = (learner as { email?: string | null }).email ?? null;
  if (!isPlaceholderEmail(learnerEmail)) {
    try {
      await notificationsQueue.add(
        "teacher-message-arrived",
        {
          channel: "email",
          recipientId: input.learner_id,
          // Type drives template selection in processNotifications.
          // Add `teacher_message_arrived` to the worker's switch
          // when this lands; until then it falls through to the
          // generic email path with the payload below.
          type: "teacher_message_arrived",
          payload: {
            learner_id: input.learner_id,
            learner_email: learnerEmail,
            teacher_id: input.teacher_id,
            org_id: orgId.toString(),
            message_id: (messageDoc._id as Types.ObjectId).toString(),
            sent_at: sentAt.toISOString(),
            // NO message_text / original_text in the payload.
            // The brief's privacy invariant: alert tells the
            // learner there's a message waiting; the content
            // lives only in-product behind auth.
          },
        },
        { priority: 5 },
      );
      emailEnqueued = true;
    } catch (err) {
      logger.error(
        {
          err: (err as Error).message,
          message_id: (messageDoc._id as Types.ObjectId).toString(),
          learner_id: input.learner_id,
        },
        "sendTeacherMessage: notification enqueue failed — message committed, email skipped",
      );
    }
  }

  logger.info(
    {
      message_id: (messageDoc._id as Types.ObjectId).toString(),
      teacher_id: input.teacher_id,
      learner_id: input.learner_id,
      length: finalText.length,
      language: outputLanguage,
      translated,
      trigger,
      email_enqueued: emailEnqueued,
    },
    "sendTeacherMessage: complete",
  );

  const result: SendTeacherMessageResult = {
    message: {
      _id: (messageDoc._id as Types.ObjectId).toString(),
      teacher_id: input.teacher_id,
      learner_id: input.learner_id,
      org_id: orgId.toString(),
      message_text: finalText,
      original_text: originalText,
      language: outputLanguage,
      sent_at: sentAt.toISOString(),
      read_at: null,
      trigger,
    },
    email_enqueued: emailEnqueued,
    translated,
  };

  return new ApiResponse(201, "Message sent", result);
};

// ─────────────────────────────────────────────────────────────────────
// Test exports
// ─────────────────────────────────────────────────────────────────────

export const __internals__ = {
  isPlaceholderEmail,
  isEnglish,
};
