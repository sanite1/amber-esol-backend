/**
 * Stage 5 org-admin confirmation service — brief Function 17.
 *
 *   POST /api/org-admin/stage5/:reviewId/confirm
 *
 * Single-shot terminator for the Stage 5 RARPA flow. After this
 * resolves, the review is read-only — the row carries the full
 * audit story (learner self-assessment, AI tutor summary, org admin
 * sign-off, optional override).
 *
 * Privacy invariants
 * ==================
 *
 *   1. `org_id` on the Stage5Review MUST match the caller's
 *      `req.esol_context.org_id`. The route layer applies
 *      `requireOrgContext + isOrgAdmin` but the service re-checks
 *      so a misconfigured route can never leak cross-org data.
 *   2. Both `learner_self_assessment` AND `ai_tutor_summary` must
 *      be populated. Signing off without either is meaningless and
 *      gets a 409 with a clear next-action message.
 *   3. Re-confirmation is refused (`org_admin_confirmed_at !== null`
 *      → 409). The audit trail is append-only; reopening a review
 *      is a separate Phase-18 admin endpoint.
 *
 * `advance_to_level` semantics
 * ============================
 *
 * The level change has ALREADY happened — Amber admin confirmed it
 * before the Stage 5 review opened, via /api/admin/level-change/confirm.
 * This field captures the org admin's documented final call at
 * sign-off time (e.g. "I agree with E3" or "should have stayed at
 * E2"). It is INFORMATIONAL: stored on the Stage5Review row + the
 * audit log; it does NOT create another LevelChange row. A genuine
 * level reversal goes through the Amber-admin level-change route.
 */

import { Types } from "mongoose";
import { Request } from "express";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Stage5Review from "../models/Stage5Review";
import User from "../models/User";
import { writeAuditLog } from "./auditLog.service";
import { createNotification } from "./notification.service";
import { normaliseEsolLevel } from "./esolSkills";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface ConfirmStage5ReviewBody {
  next_steps: string;
  advance_to_level?: string;
}

export interface ConfirmStage5ReviewInput {
  review_id: string;
  caller_id: string;
  caller_org_id: string;
  body: ConfirmStage5ReviewBody;
  req?: Request;
}

export interface ConfirmStage5ReviewResult {
  review_id: string;
  level_completed: string;
  confirmed_at: string;
  confirmed_by: string;
  next_steps: string;
  /** Echoed back when the caller recorded an override; otherwise null. */
  advance_to_level: string | null;
  /** True when the recorded override differs from the system's level. */
  override_recorded: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const confirmStage5ReviewService = async (
  input: ConfirmStage5ReviewInput,
): Promise<ApiResponse> => {
  // ── 1. Shape validation ────────────────────────────────────────
  if (!input.review_id || !Types.ObjectId.isValid(input.review_id)) {
    throw new ApiError(400, "reviewId must be a valid ObjectId");
  }
  if (!input.caller_id || !Types.ObjectId.isValid(input.caller_id)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  if (!input.caller_org_id || !Types.ObjectId.isValid(input.caller_org_id)) {
    throw new ApiError(400, "Organisation context is required");
  }

  const body = input.body;
  const nextSteps = (body?.next_steps ?? "").trim();
  if (!nextSteps) {
    throw new ApiError(
      400,
      "next_steps is required — describe the agreed plan for this learner.",
    );
  }
  if (nextSteps.length > 2000) {
    throw new ApiError(400, "next_steps must be 2000 characters or fewer");
  }

  // advance_to_level is optional. When provided it MUST be a valid
  // EsolLevel literal — we don't accept arbitrary strings.
  let advanceToLevel: string | null = null;
  if (body.advance_to_level !== undefined && body.advance_to_level !== null) {
    const normalised = normaliseEsolLevel(body.advance_to_level);
    if (!normalised) {
      throw new ApiError(
        400,
        "advance_to_level must be one of e1, e2, e3, l1, l2",
      );
    }
    advanceToLevel = normalised;
  }

  // ── 2. Load + privacy-check the Stage5Review ───────────────────
  const review = await Stage5Review.findById(input.review_id);
  if (!review) throw new ApiError(404, "Stage 5 review not found");

  if (review.org_id.toString() !== input.caller_org_id) {
    throw new ApiError(
      403,
      "Forbidden — this Stage 5 review belongs to another organisation",
    );
  }

  // ── 3. Pre-conditions: both halves must be ready ──────────────
  if (review.learner_self_assessment === null) {
    throw new ApiError(
      409,
      "Cannot confirm — the learner has not yet submitted their self-assessment.",
    );
  }
  if (review.ai_tutor_summary === null) {
    throw new ApiError(
      409,
      "Cannot confirm — the AI tutor summary has not yet been generated. " +
        "Wait a few minutes or contact support if this persists.",
    );
  }

  // ── 4. Single-shot — refuse re-confirmation ────────────────────
  if (review.org_admin_confirmed_at !== null) {
    throw new ApiError(
      409,
      "This Stage 5 review has already been confirmed and cannot be re-confirmed. " +
        "If the decision needs to change, contact Amber admin to reopen.",
    );
  }

  // ── 5. Persist ────────────────────────────────────────────────
  const confirmedAt = new Date();
  review.org_admin_confirmed_at = confirmedAt;
  review.org_admin_confirmed_by = new Types.ObjectId(input.caller_id);
  review.next_steps = nextSteps;
  review.org_admin_advance_to_level = advanceToLevel;
  await review.save();

  // ── 6. Audit log ──────────────────────────────────────────────
  // `before_state` mirrors the pre-confirm state (always
  // `org_admin_confirmed_at: null` by the single-shot guard above).
  // `after_state` carries everything material — including the
  // override-recorded flag so a future reader sees the intent at a
  // glance.
  const overrideRecorded =
    advanceToLevel !== null && advanceToLevel !== review.level_completed;

  await writeAuditLog(
    {
      actor_type: "org_admin",
      actor_id: input.caller_id,
      org_id: review.org_id,
      learner_id: review.learner_id,
      action: "stage5_review_confirmed",
      before_state: {
        org_admin_confirmed_at: null,
        next_steps: null,
        org_admin_advance_to_level: null,
      },
      after_state: {
        review_id: input.review_id,
        level_completed: review.level_completed,
        confirmed_at: confirmedAt.toISOString(),
        next_steps: nextSteps,
        advance_to_level: advanceToLevel,
        override_recorded: overrideRecorded,
      },
      reason: overrideRecorded
        ? `Org admin confirmed Stage 5 review for ${review.level_completed} with recorded override to ${advanceToLevel}.`
        : `Org admin confirmed Stage 5 review for ${review.level_completed}.`,
    },
    { req: input.req },
  );

  // ── 7. Notify learner (best-effort) ────────────────────────────
  // The learner sees a quick acknowledgement that their reflection
  // was reviewed. Notification failure mustn't roll back the confirm.
  try {
    await createNotification({
      userId: review.learner_id,
      type: "progression_confirmed",
      title: "Your Stage 5 review is complete",
      message:
        "Your Stage 5 reflection has been reviewed and confirmed. Check your next steps to see what's recommended.",
      data: {
        stage5_review_id: input.review_id,
        next_steps: nextSteps,
      },
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, stage5_review_id: input.review_id },
      "confirmStage5Review: learner notification failed — confirm still committed",
    );
  }

  // Resolve confirmer name for the response envelope. Lookup
  // failure → fall back to "Org admin" so the response still
  // populates cleanly; the audit log already has the id.
  let confirmedByName = "Org admin";
  try {
    const admin = await User.findById(input.caller_id)
      .select("firstname lastname")
      .lean();
    if (admin) {
      const candidate =
        `${admin.firstname ?? ""} ${admin.lastname ?? ""}`.trim();
      if (candidate) confirmedByName = candidate;
    }
  } catch {
    /* fall back to the default */
  }

  logger.info(
    {
      stage5_review_id: input.review_id,
      caller_id: input.caller_id,
      level_completed: review.level_completed,
      advance_to_level: advanceToLevel,
      override_recorded: overrideRecorded,
    },
    "confirmStage5Review: complete",
  );

  const result: ConfirmStage5ReviewResult = {
    review_id: input.review_id,
    level_completed: review.level_completed,
    confirmed_at: confirmedAt.toISOString(),
    confirmed_by: confirmedByName,
    next_steps: nextSteps,
    advance_to_level: advanceToLevel,
    override_recorded: overrideRecorded,
  };
  return new ApiResponse(200, "Stage 5 review confirmed", result);
};
