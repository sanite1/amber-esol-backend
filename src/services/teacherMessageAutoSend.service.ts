/**
 * System-driven teacher messaging — Final Addendum §11.
 *
 * Sends a TeacherMessage on a teacher's behalf from a system
 * trigger (the daily re-engagement cron is the only caller today).
 * Mirrors the per-message side effects of `sendTeacherMessageService`
 * but with two deliberate differences:
 *
 *   1. The audit row uses `actor_type: "system"` plus
 *      `acting_as_teacher_id` rather than `actor_type: "teacher"`.
 *      A learner reading "your tutor Sarah said…" should be able
 *      to tell from the audit trail whether Sarah actually clicked
 *      Send (manual) or whether the cron auto-sent on her behalf.
 *   2. No assignment-gate check at this layer — the cron already
 *      filters by `assigned_teacher_id` and a system actor isn't
 *      bound by the route-layer teacher middleware. The caller
 *      MUST guarantee teacher/learner assignment up front; this
 *      service trusts it.
 *
 * Everything else — Gemini translation, TeacherMessage.create,
 * content-free notification enqueue, placeholder-email skip —
 * matches the manual-send path. The two flows share the same
 * `translateTeacherMessage` helper so a learner receives the same
 * translation regardless of who pressed Send.
 *
 * Failure semantics
 * =================
 *
 * Unlike the manual path (which throws ApiError to the route),
 * this service NEVER throws. Cron callers want to know "did it
 * succeed?" without try/catch around every learner — so the
 * result envelope carries `{ status: "ok" | "translation_failed"
 * | "create_failed" }` and the cron caller tallies.
 *
 * Translation failure is logged + the learner is SKIPPED for the
 * current run. The next cron firing will retry; learners who
 * stay dormant past the 14-day re-engagement gate keep their
 * spot in the queue.
 */

import { Types } from "mongoose";
import User from "../models/User";
import TeacherMessage from "../models/TeacherMessage";
import { writeAuditLog } from "./auditLog.service";
import { translateTeacherMessage } from "./teacherMessageTranslate.service";
import { notificationsQueue } from "../queues";
import logger from "../config/logger";
import type { TeacherMessageTrigger } from "../interfaces/teacherMessage.interface";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface AutoSendInput {
  /** Teacher id whose voice/identity the message carries. */
  teacher_id: string;
  /** Recipient learner id. Caller guarantees assignment to teacher_id. */
  learner_id: string;
  /** Org id (shared between teacher and learner; passed to skip the lookup). */
  org_id: string;
  /** Resolved English text (template renderer ran upstream). */
  message_text: string;
  /** Whether the auto-translate to L1 path should fire. */
  translate_to_l1: boolean;
  /** Trigger axis — the cron passes `"re_engagement_cron"`. */
  trigger: TeacherMessageTrigger;
  /** Pre-fetched learner email + l1 to avoid a second User lookup. */
  learner_email: string | null;
  learner_l1_language: string | null;
}

export type AutoSendStatus = "ok" | "translation_failed" | "create_failed";

export interface AutoSendResult {
  status: AutoSendStatus;
  /** TeacherMessage._id when status === "ok". */
  message_id: string | null;
  /** True when the message was translated; false when sent untranslated. */
  translated: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const isPlaceholderEmail = (email: string | null | undefined): boolean => {
  if (typeof email !== "string") return true;
  if (email.trim().length === 0) return true;
  return /csv-placeholder/i.test(email);
};

const isEnglish = (lang: string | null | undefined): boolean => {
  if (!lang) return true;
  return lang.toString().trim().toLowerCase() === "english";
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const autoSendTeacherMessage = async (
  input: AutoSendInput,
): Promise<AutoSendResult> => {
  // ── Validate the bare minimum the cron should have already done.
  // We don't throw — we return an error status so the cron can
  // tally and continue with the next learner.
  if (
    !Types.ObjectId.isValid(input.teacher_id) ||
    !Types.ObjectId.isValid(input.learner_id) ||
    !Types.ObjectId.isValid(input.org_id) ||
    input.message_text.trim().length === 0
  ) {
    logger.warn({ input }, "autoSendTeacherMessage: invalid input — skipping");
    return { status: "create_failed", message_id: null, translated: false };
  }

  // ── Translation (same path as the manual send) ────────────────
  let finalText = input.message_text.trim();
  let originalText: string | null = null;
  let outputLanguage = "en";
  let translated = false;

  if (input.translate_to_l1 && !isEnglish(input.learner_l1_language)) {
    try {
      finalText = await translateTeacherMessage(
        finalText,
        input.learner_l1_language ?? "",
      );
      originalText = input.message_text.trim();
      outputLanguage = input.learner_l1_language ?? "en";
      translated = true;
    } catch (err) {
      // Cron path: log and skip. Don't auto-fall-back to English —
      // the next cron firing will retry; a one-off Gemini hiccup
      // shouldn't deliver an English nudge to a non-English speaker.
      logger.error(
        {
          err: (err as Error).message,
          teacher_id: input.teacher_id,
          learner_id: input.learner_id,
          target_language: input.learner_l1_language,
          trigger: input.trigger,
        },
        "autoSendTeacherMessage: translation failed — skipping this learner for the current run",
      );
      return {
        status: "translation_failed",
        message_id: null,
        translated: false,
      };
    }
  }

  // ── Create the TeacherMessage row ────────────────────────────
  const sentAt = new Date();
  let messageDoc;
  try {
    messageDoc = await TeacherMessage.create({
      teacher_id: new Types.ObjectId(input.teacher_id),
      learner_id: new Types.ObjectId(input.learner_id),
      org_id: new Types.ObjectId(input.org_id),
      message_text: finalText,
      original_text: originalText,
      language: outputLanguage,
      sent_at: sentAt,
      read_at: null,
      trigger: input.trigger,
    });
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        teacher_id: input.teacher_id,
        learner_id: input.learner_id,
        trigger: input.trigger,
      },
      "autoSendTeacherMessage: TeacherMessage.create failed",
    );
    return { status: "create_failed", message_id: null, translated };
  }

  // ── AuditLog — `actor_type: "system"` + `acting_as_teacher_id` ─
  // The brief's exact pattern. The audit-log UI's rendering for
  // system rows already treats actor_id as null and the message
  // as describing a system event; the new `acting_as_teacher_id`
  // field carries the on-behalf-of attribution so the row reads
  // "system (acting as Sarah Chen) sent an auto re-engagement
  // message to Ahmed Al-Khaled."
  await writeAuditLog({
    actor_type: "system",
    actor_id: null,
    org_id: input.org_id,
    learner_id: input.learner_id,
    acting_as_teacher_id: input.teacher_id,
    action: "teacher_message_sent",
    before_state: null,
    after_state: {
      message_id: (messageDoc._id as Types.ObjectId).toString(),
      length: finalText.length,
      language: outputLanguage,
      translated,
      trigger: input.trigger,
    },
    reason:
      `System auto-sent a ${input.trigger} message on the teacher's behalf ` +
      `(${finalText.length} chars, ${outputLanguage}${translated ? ", translated from en" : ""}).`,
  });

  // ── Email alert (content-free) ───────────────────────────────
  if (!isPlaceholderEmail(input.learner_email)) {
    try {
      await notificationsQueue.add(
        "teacher-message-arrived",
        {
          channel: "email",
          recipientId: input.learner_id,
          type: "teacher_message_arrived",
          payload: {
            learner_id: input.learner_id,
            learner_email: input.learner_email,
            teacher_id: input.teacher_id,
            org_id: input.org_id,
            message_id: (messageDoc._id as Types.ObjectId).toString(),
            sent_at: sentAt.toISOString(),
            // No message_text — content-free per the §11 privacy rule.
          },
        },
        { priority: 5 },
      );
    } catch (err) {
      logger.error(
        {
          err: (err as Error).message,
          message_id: (messageDoc._id as Types.ObjectId).toString(),
        },
        "autoSendTeacherMessage: notification enqueue failed — message committed, email skipped",
      );
    }
  }

  return {
    status: "ok",
    message_id: (messageDoc._id as Types.ObjectId).toString(),
    translated,
  };
};

// Silences unused-import warning when the cron caller doesn't need
// the User model directly. Kept as an import marker so a future
// in-line learner re-fetch path is one require away.
export const __unused_keepalive__ = User.modelName;
