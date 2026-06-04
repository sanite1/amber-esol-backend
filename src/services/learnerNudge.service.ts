/**
 * Learner nudge service — brief Function 12 To-Do 4.
 *
 * Backs POST /api/org-admin/learners/:id/nudge — the one-tap "we
 * miss you" email the org admin sends to a quiet learner from the
 * cohort table or the learner detail page.
 *
 * Composition:
 *   - Reuses `assertLearnerAccess` so the ACL invariant is identical
 *     to every other learner-scoped org-admin endpoint.
 *   - Skips the email when the learner has no real address (CSV
 *     imports use a `csv-placeholder-…` synthetic email that would
 *     bounce). Returns 200 with `email_sent: false` so the dashboard
 *     can render "Nudge skipped — no email on file" rather than an
 *     error toast.
 *   - The email body is localised to the learner's L1 via a
 *     handlebars context map; the static English copy stays as a
 *     fallback for unrecognised L1s, matching the pattern used by
 *     the Stage 5 reflection prompt.
 *   - An optional `custom_message` from the org admin is appended
 *     verbatim to the email body. Trimmed + length-capped so a
 *     careless admin can't paste 100KB.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { notificationsQueue } from "../queues";
import { assertLearnerAccess } from "./esolLearner.service";
import logger from "../config/logger";

const MAX_CUSTOM_MESSAGE_LENGTH = 1_000;

const isPlaceholderEmail = (email: string | null | undefined): boolean => {
  if (typeof email !== "string") return true;
  if (email.trim().length === 0) return true;
  return /csv-placeholder/i.test(email);
};

export interface NudgeLearnerBody {
  custom_message?: string;
}

export interface NudgeLearnerResult {
  learner_id: string;
  email_sent: boolean;
  reason?: string;
  l1_language_used: string;
}

export const sendLearnerNudgeService = async (
  learnerId: string,
  callerRole: string,
  callerOrgId: string | null | undefined,
  callerId: string,
  body: NudgeLearnerBody
): Promise<ApiResponse> => {
  // ── 1. ACL gate (404/403 disambiguation handled by helper) ───────
  const { learnerObjectId } = await assertLearnerAccess(
    learnerId,
    callerRole,
    callerOrgId
  );

  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }

  // ── 2. Custom message validation ──────────────────────────────────
  let customMessage: string | null = null;
  if (body?.custom_message !== undefined && body?.custom_message !== null) {
    const trimmed = String(body.custom_message).trim();
    if (trimmed.length > MAX_CUSTOM_MESSAGE_LENGTH) {
      throw new ApiError(
        400,
        `custom_message must be ${MAX_CUSTOM_MESSAGE_LENGTH} characters or fewer`
      );
    }
    if (trimmed.length > 0) customMessage = trimmed;
  }

  // ── 3. Load learner — full doc for email composition ──────────────
  const learner = await User.findById(learnerObjectId)
    .select("_id firstname lastname email l1Language orgId esolLevel")
    .lean();
  if (!learner) {
    // assertLearnerAccess already verified existence; defensive in
    // case of a race between assertion and projection.
    throw new ApiError(404, "Learner not found");
  }

  const learnerName =
    `${learner.firstname ?? ""} ${learner.lastname ?? ""}`.trim() ||
    "(unnamed learner)";
  const l1Language = (learner.l1Language ?? "english").toString();

  // ── 4. Skip email when there's no real address ────────────────────
  if (isPlaceholderEmail(learner.email)) {
    logger.info(
      { learner_id: learner._id.toString(), org_id: callerOrgId },
      "sendLearnerNudge: skipped — learner has no real email on file"
    );

    // Still audit the intent — the org admin clicked "nudge"; that
    // action should be recoverable from the trail.
    await AuditLog.create({
      timestamp: new Date(),
      actor_type: callerRole === "admin" ? "amber_admin" : "org_admin",
      actor_id: new Types.ObjectId(callerId),
      org_id: (learner.orgId as Types.ObjectId) ?? null,
      learner_id: learner._id,
      action: "learner_nudge_sent",
      before_state: null,
      after_state: {
        email_sent: false,
        reason: "no_real_email",
        custom_message_provided: customMessage !== null,
      },
      reason: "Org admin clicked nudge but learner has no email on file",
      compliance_config_version: null,
    }).catch((err) =>
      logger.error(
        { err: (err as Error).message, learnerId: learner._id.toString() },
        "sendLearnerNudge: AuditLog write failed"
      )
    );

    return new ApiResponse(200, "Nudge skipped — learner has no email on file", {
      learner_id: learner._id.toString(),
      email_sent: false,
      reason: "no_real_email",
      l1_language_used: l1Language,
    });
  }

  // ── 5. Enqueue the L1 email ───────────────────────────────────────
  try {
    await notificationsQueue.add(
      "learner-nudge-email",
      {
        channel: "email",
        recipientId: learner._id.toString(),
        type: "system",
        payload: {
          learner_id: learner._id.toString(),
          learner_email: learner.email,
          learner_name: learnerName,
          l1_language: l1Language,
          esol_level: learner.esolLevel ?? null,
          custom_message: customMessage,
          sent_by_user_id: callerId,
        },
      },
      { priority: 5 }
    );
  } catch (err) {
    logger.error(
      { err: (err as Error).message, learnerId: learner._id.toString() },
      "sendLearnerNudge: failed to enqueue learner-nudge-email"
    );
    throw new ApiError(502, "Failed to enqueue nudge — please retry");
  }

  // ── 6. AuditLog the intent ────────────────────────────────────────
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: callerRole === "admin" ? "amber_admin" : "org_admin",
    actor_id: new Types.ObjectId(callerId),
    org_id: (learner.orgId as Types.ObjectId) ?? null,
    learner_id: learner._id,
    action: "learner_nudge_sent",
    before_state: null,
    after_state: {
      email_sent: true,
      custom_message_provided: customMessage !== null,
      l1_language: l1Language,
    },
    reason: "Org admin sent nudge email",
    compliance_config_version: null,
  }).catch((err) =>
    logger.error(
      { err: (err as Error).message, learnerId: learner._id.toString() },
      "sendLearnerNudge: AuditLog write failed"
    )
  );

  return new ApiResponse(200, "Nudge email enqueued", {
    learner_id: learner._id.toString(),
    email_sent: true,
    l1_language_used: l1Language,
  });
};

export const __internals__ = {
  isPlaceholderEmail,
  MAX_CUSTOM_MESSAGE_LENGTH,
};
