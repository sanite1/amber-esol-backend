/**
 * Admin level-change services — brief Function 11 To-Do 2.
 *
 * Two operations:
 *
 *   confirmLevelChangeService — Amber admin promotes a learner who has
 *     met all five progression criteria. Writes the append-only
 *     LevelChange row, flips User.esolLevel, seeds fresh Stage 3
 *     objectives at the new level, stubs the Stage 5 review, dispatches
 *     a learner congratulations email in their L1, and audit-logs the
 *     transition.
 *
 *   rejectLevelChangeService — Amber admin declines a flagged learner
 *     (e.g. the readiness flag was a false positive, or the org admin
 *     hasn't completed the in-person review). No LevelChange row is
 *     written — the brief is explicit that rejection is a record of
 *     intent, not a state change. The org admin gets a Nodemailer
 *     explaining why so they can intervene.
 *
 * Both functions enforce the same access invariants:
 *   - Learner must exist and be a student
 *   - Learner must have an orgId (must be an ESOL learner)
 *   - Caller must be an Amber admin (gated at the route layer)
 *
 * Adjacency rule (confirm only): new_level must be the IMMEDIATE next
 * step above current — e1→e2, e2→e3, e3→l1, l1→l2. No skipping (e1→e3
 * rejected). No demotions through this endpoint — demotions go through
 * a separate teacher-override route that doesn't run readiness gating.
 *
 * Idempotency: the confirm flow re-runs `checkLevelProgression` at
 * service time, NOT against a cached "ready" flag. A learner who was
 * flagged ready yesterday but had a poor session this morning will
 * have ready_for_progression go back to false; the confirm refuses
 * with 409. This stops the dashboard from confirming stale readiness.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Organisation from "../models/Organisation";
import LevelChange from "../models/LevelChange";
import AuditLog from "../models/AuditLog";
import { createNotification } from "./notification.service";
import { notificationsQueue } from "../queues";
import {
  checkLevelProgression,
  triggerStage5Review,
} from "./levelProgression.service";
import { createStage3ObjectivesOnLevelChange } from "./rarpa.service";
import { EsolLevel, IlrSkillCode, normaliseEsolLevel } from "./esolSkills";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Level adjacency
// ─────────────────────────────────────────────────────────────────────

/**
 * The five valid levels in ascending order. The promotion path is
 * strictly one step up — no skipping.
 *
 * If the framework ever adds a level (e.g. "l3" or "pre_e1"), this
 * array is the single edit point.
 */
export const LEVEL_LADDER: readonly EsolLevel[] = [
  "e1",
  "e2",
  "e3",
  "l1",
  "l2",
] as const;

export const isAdjacentLevelUp = (
  fromLevel: EsolLevel,
  toLevel: EsolLevel,
): boolean => {
  const fromIdx = LEVEL_LADDER.indexOf(fromLevel);
  const toIdx = LEVEL_LADDER.indexOf(toLevel);
  if (fromIdx < 0 || toIdx < 0) return false;
  return toIdx === fromIdx + 1;
};

// ─────────────────────────────────────────────────────────────────────
// Confirm
// ─────────────────────────────────────────────────────────────────────

export interface ConfirmLevelChangeBody {
  learner_id: string;
  new_level: string;
}

export interface ConfirmLevelChangeResult {
  learner_id: string;
  old_level: string;
  new_level: string;
  level_change_id: string;
}

export const confirmLevelChangeService = async (
  body: ConfirmLevelChangeBody,
  callerId: string,
): Promise<ApiResponse> => {
  // ── 1. Input validation ───────────────────────────────────────────
  if (!body?.learner_id || !Types.ObjectId.isValid(body.learner_id)) {
    throw new ApiError(400, "learner_id must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  const newLevel = normaliseEsolLevel(body?.new_level);
  if (!newLevel) {
    throw new ApiError(400, "new_level must be one of e1, e2, e3, l1, l2");
  }

  // ── 2. Load learner — must be ESOL student with org context ──────
  const learner = await User.findById(body.learner_id);
  if (!learner) {
    throw new ApiError(404, "Learner not found");
  }
  if (learner.role !== "student") {
    throw new ApiError(403, "Target user is not a student");
  }
  if (!learner.orgId) {
    throw new ApiError(
      400,
      "Learner has no org assignment — not an ESOL learner",
    );
  }

  // ── 3. Adjacency rule ─────────────────────────────────────────────
  const oldLevel = normaliseEsolLevel(learner.esolLevel);
  if (!oldLevel) {
    throw new ApiError(
      400,
      "Learner has no current esol_level — run placement before confirming a level change",
    );
  }
  if (!isAdjacentLevelUp(oldLevel, newLevel)) {
    throw new ApiError(
      400,
      `Invalid level transition ${oldLevel} → ${newLevel}: only adjacent promotions allowed (e1→e2→e3→l1→l2)`,
    );
  }

  // ── 4. Live readiness re-check (NOT a cached flag) ────────────────
  // The daily cron's progression_notification_sent_at marker is just a
  // dedupe hint for the email — the source of truth is the five-
  // criteria evaluation, re-run now. A learner whose readiness has
  // since lapsed gets a 409, not a silent promotion on stale signal.
  const readiness = await checkLevelProgression(body.learner_id);
  if (!readiness.ready_for_progression) {
    throw new ApiError(
      409,
      "Learner is no longer ready for progression — re-run the readiness check",
    );
  }

  // ── 5. Append-only LevelChange row ───────────────────────────────
  const now = new Date();
  const levelChange = await LevelChange.create({
    learnerId: learner._id,
    orgId: learner.orgId,
    fromLevel: oldLevel,
    toLevel: newLevel,
    changedBy: new Types.ObjectId(callerId),
    reason: "Amber admin confirmed progression",
    evidenceSummary: JSON.stringify({
      criteria_met: readiness.criteria_met,
      checked_at: readiness.checked_at,
    }),
    effectiveDate: now,
    triggerEvent: "progression_criteria_met",
  });

  // ── 6. Flip learner level + reset progression-notification cursor ─
  // Resetting the cursor means the next time the daily cron runs, a
  // learner who lands on the new level WILL get re-notified when they
  // meet the criteria at the new level (the dedupe key is per-level).
  await User.updateOne(
    { _id: learner._id },
    {
      $set: {
        esolLevel: newLevel,
        progression_notification_sent_at: null,
        progression_notification_level: null,
      },
    },
  );

  // ── 7. Append fresh Stage 3 objectives at the new level ───────────
  // Reuse the placement template builder but APPEND rather than
  // strip-and-replace (createStage3ObjectivesOnLevelChange preserves
  // history — the older level's objectives stay on record for the
  // Stage 5 / ILR audit trail).
  const skillFlags = (learner.skillWeaknessFlags ?? []) as IlrSkillCode[];
  try {
    await createStage3ObjectivesOnLevelChange(
      learner._id.toString(),
      newLevel,
      skillFlags,
    );
  } catch (err) {
    // Don't roll back the LevelChange — the brief intent is that the
    // level transition is the user-visible event. Objective seeding
    // failure logs loudly so it can be re-run manually.
    logger.error(
      { err: (err as Error).message, learnerId: learner._id.toString() },
      "confirmLevelChange: createStage3ObjectivesOnLevelChange failed — level flipped but Stage 3 not seeded",
    );
  }

  // ── 8. Stage 5 review trigger (brief Function 11 / Function 17) ───
  // Delegated to levelProgression.service so the level-change flow
  // and the future Phase 18 self-assessment flow share one entry
  // point. The stub creates the Stage5Review row pinned to the level
  // just completed and fires the learner's L1-localised reflection
  // notification. Phase 18 will populate self-assessment + AI summary
  // via a dedicated learner-facing form + Gemini batch.
  await triggerStage5Review(learner._id.toString(), oldLevel, newLevel).catch(
    (err) =>
      logger.error(
        { err: (err as Error).message, learnerId: learner._id.toString() },
        "confirmLevelChange: triggerStage5Review failed — level change still committed",
      ),
  );

  // ── 9. In-app notification + celebration email to LEARNER ─────────
  const learnerName =
    `${learner.firstname ?? ""} ${learner.lastname ?? ""}`.trim() ||
    "(unnamed learner)";

  await createNotification({
    userId: learner._id,
    type: "progression_confirmed",
    title: `Welcome to ${newLevel.toUpperCase()}`,
    message: `Congratulations — your ESOL level has been confirmed at ${newLevel.toUpperCase()}.`,
    data: {
      learner_id: learner._id.toString(),
      old_level: oldLevel,
      new_level: newLevel,
      level_change_id: levelChange._id.toString(),
    },
  });

  // Only fire the email when the learner has a real (non-CSV-placeholder)
  // email. CSV-imported learners with synthetic emails would bounce.
  const hasRealEmail =
    typeof learner.email === "string" &&
    learner.email.length > 0 &&
    !/csv-placeholder/i.test(learner.email);
  if (hasRealEmail) {
    notificationsQueue
      .add(
        "progression-confirmed-email",
        {
          channel: "email",
          recipientId: learner._id.toString(),
          type: "progression_confirmed",
          payload: {
            learner_id: learner._id.toString(),
            learner_email: learner.email,
            learner_name: learnerName,
            l1_language: learner.l1Language ?? "english",
            old_level: oldLevel,
            new_level: newLevel,
          },
        },
        { priority: 1 },
      )
      .catch((err) =>
        logger.error(
          { err: (err as Error).message, learnerId: learner._id.toString() },
          "confirmLevelChange: failed to enqueue progression-confirmed-email",
        ),
      );
  } else {
    logger.info(
      { learnerId: learner._id.toString() },
      "confirmLevelChange: learner has no real email — celebration email skipped",
    );
  }

  // ── 10. AuditLog — required by brief Function 11 ──────────────────
  await AuditLog.create({
    timestamp: now,
    actor_type: "amber_admin",
    actor_id: new Types.ObjectId(callerId),
    org_id: learner.orgId as Types.ObjectId,
    learner_id: learner._id,
    action: "level_change_confirmed",
    before_state: { esol_level: oldLevel },
    after_state: {
      esol_level: newLevel,
      level_change_id: levelChange._id.toString(),
      criteria_met: readiness.criteria_met,
    },
    reason: "Amber admin confirmed progression",
    compliance_config_version: null,
  }).catch((err) =>
    logger.error(
      { err: (err as Error).message, learnerId: learner._id.toString() },
      "confirmLevelChange: AuditLog write failed",
    ),
  );

  const result: ConfirmLevelChangeResult = {
    learner_id: learner._id.toString(),
    old_level: oldLevel,
    new_level: newLevel,
    level_change_id: levelChange._id.toString(),
  };

  logger.info(result, "Level change confirmed");
  return new ApiResponse(200, "Level change confirmed", result);
};

// ─────────────────────────────────────────────────────────────────────
// Reject
// ─────────────────────────────────────────────────────────────────────

export interface RejectLevelChangeBody {
  learner_id: string;
  reason: string;
}

export const rejectLevelChangeService = async (
  body: RejectLevelChangeBody,
  callerId: string,
): Promise<ApiResponse> => {
  if (!body?.learner_id || !Types.ObjectId.isValid(body.learner_id)) {
    throw new ApiError(400, "learner_id must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  const reason = (body?.reason ?? "").toString().trim();
  if (!reason) {
    throw new ApiError(400, "reason is required");
  }
  if (reason.length > 4_000) {
    throw new ApiError(400, "reason must be 4000 characters or fewer");
  }

  const learner = await User.findById(body.learner_id)
    .select("_id firstname lastname email orgId esolLevel role")
    .lean();
  if (!learner) {
    throw new ApiError(404, "Learner not found");
  }
  if (learner.role !== "student") {
    throw new ApiError(403, "Target user is not a student");
  }
  if (!learner.orgId) {
    throw new ApiError(400, "Learner has no org assignment");
  }

  // No LevelChange row — the brief is explicit that rejection records
  // intent, not a state change. The state stays exactly as it was.
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "amber_admin",
    actor_id: new Types.ObjectId(callerId),
    org_id: learner.orgId as Types.ObjectId,
    learner_id: learner._id,
    action: "level_change_rejected",
    before_state: { esol_level: learner.esolLevel ?? null },
    after_state: { esol_level: learner.esolLevel ?? null, reason },
    reason: "Amber admin rejected level change",
    compliance_config_version: null,
  });

  // Notify the org admin. We look up the org owner here rather than
  // emailing every org-admin role-bearer because the brief specifies
  // a single recipient — the org's primary admin (adminUserId).
  const org = await Organisation.findById(learner.orgId)
    .select("name adminUserId")
    .lean();
  const learnerName =
    `${learner.firstname ?? ""} ${learner.lastname ?? ""}`.trim() ||
    "(unnamed learner)";

  if (org?.adminUserId) {
    await createNotification({
      userId: org.adminUserId,
      type: "progression_rejected",
      title: `Level change rejected: ${learnerName}`,
      message: `Amber declined the level change for ${learnerName}. Reason: ${reason}`,
      data: {
        learner_id: learner._id.toString(),
        current_level: learner.esolLevel ?? null,
        reason,
      },
    });

    notificationsQueue
      .add(
        "progression-rejected-email",
        {
          channel: "email",
          recipientId: org.adminUserId.toString(),
          type: "progression_rejected",
          payload: {
            org_id: learner.orgId.toString(),
            org_name: org.name ?? "your organisation",
            org_admin_user_id: org.adminUserId.toString(),
            learner_id: learner._id.toString(),
            learner_name: learnerName,
            current_level: learner.esolLevel ?? "unknown",
            reason,
          },
        },
        { priority: 1 },
      )
      .catch((err) =>
        logger.error(
          { err: (err as Error).message, learnerId: learner._id.toString() },
          "rejectLevelChange: failed to enqueue progression-rejected-email",
        ),
      );
  } else {
    logger.warn(
      { orgId: learner.orgId.toString() },
      "rejectLevelChange: org has no adminUserId — in-app notification + email skipped",
    );
  }

  return new ApiResponse(200, "Level change rejected", {
    learner_id: learner._id.toString(),
    current_level: learner.esolLevel ?? null,
    reason,
  });
};
