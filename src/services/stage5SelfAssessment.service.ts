/**
 * Stage 5 learner self-assessment service — brief Function 17.
 *
 *   POST /api/esol/stage5/:reviewId/self-assessment
 *
 * Single-shot: the learner submits exactly once. Resubmitting is
 * blocked at the service layer (a 409). If the learner needs to
 * revise their answers, an org admin re-opens the review via a
 * separate Phase-18 admin endpoint — that mutation carries its own
 * audit trail.
 *
 * Privacy invariants enforced here, not at the controller
 * ======================================================
 *
 *   1. `learner_id` on the Stage5Review MUST equal `req.user.id`.
 *      The controller cannot relax this — a learner viewing another
 *      learner's review id can never write to it.
 *   2. `learner_self_assessment` is a one-way write. Once non-null
 *      this service refuses with 409. The model field is typed
 *      `unknown` so a future schema can add fields without changing
 *      this guard.
 *   3. `objective_ratings` keys are validated against the SNAPSHOT
 *      stored on the Stage5Review (not the live User doc). The
 *      snapshot is the source of truth for "what was assessed when
 *      this level was completed".
 */

import { Types } from "mongoose";
import { Request } from "express";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Stage5Review from "../models/Stage5Review";
import { writeAuditLog } from "./auditLog.service";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export type ConfidenceRating = "low" | "medium" | "high";
export type ObjectiveRating = "struggling" | "progressing" | "confident";
export type NextStepsPreference =
  | "more_practice"
  | "advance_level"
  | "specific_focus"
  | "unsure";

export interface SubmitStage5SelfAssessmentBody {
  confidence_rating: ConfidenceRating;
  objective_ratings: Record<string, ObjectiveRating>;
  next_steps_preference: NextStepsPreference;
}

export interface SubmitStage5SelfAssessmentInput {
  review_id: string;
  /** Authenticated caller id from req.user.id. */
  caller_id: string;
  /** Required for the writeAuditLog impersonation breadcrumb. */
  caller_org_id: string;
  body: SubmitStage5SelfAssessmentBody;
  req?: Request;
}

export interface SubmitStage5SelfAssessmentResult {
  review_id: string;
  submitted_at: string;
  next_steps_preference: NextStepsPreference;
  confidence_rating: ConfidenceRating;
  /** Count of rated objectives (sanity-check echo for the UI). */
  rated_objectives: number;
}

// ─────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────

const VALID_CONFIDENCE: ReadonlyArray<ConfidenceRating> = [
  "low",
  "medium",
  "high",
];
const VALID_OBJECTIVE: ReadonlyArray<ObjectiveRating> = [
  "struggling",
  "progressing",
  "confident",
];
const VALID_NEXT_STEPS: ReadonlyArray<NextStepsPreference> = [
  "more_practice",
  "advance_level",
  "specific_focus",
  "unsure",
];

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Pull the array of `id` strings out of the Stage5Review's snapshot
 * `stage3_objectives` array. Defensive — the snapshot is stored as
 * `Schema.Types.Mixed` so we narrow at the access boundary rather
 * than trusting the type system.
 */
const extractObjectiveIds = (snapshot: unknown): string[] => {
  if (!Array.isArray(snapshot)) return [];
  const ids: string[] = [];
  for (const item of snapshot) {
    if (isObject(item) && typeof item.id === "string") {
      ids.push(item.id);
    }
  }
  return ids;
};

// ─────────────────────────────────────────────────────────────────────
// Top-level service
// ─────────────────────────────────────────────────────────────────────

export const submitStage5SelfAssessmentService = async (
  input: SubmitStage5SelfAssessmentInput,
): Promise<ApiResponse> => {
  // ── 1. Shape validation ────────────────────────────────────────
  // Joi already catches the gross-shape failures at the route
  // layer; these checks defend the service boundary so a direct
  // caller (test, future job) can't smuggle bad data in.
  if (!input.review_id || !Types.ObjectId.isValid(input.review_id)) {
    throw new ApiError(400, "reviewId must be a valid ObjectId");
  }
  if (!input.caller_id || !Types.ObjectId.isValid(input.caller_id)) {
    throw new ApiError(400, "Authenticated caller id required");
  }

  const body = input.body;
  if (!VALID_CONFIDENCE.includes(body.confidence_rating)) {
    throw new ApiError(
      400,
      `confidence_rating must be one of ${VALID_CONFIDENCE.join(", ")}`,
    );
  }
  if (!VALID_NEXT_STEPS.includes(body.next_steps_preference)) {
    throw new ApiError(
      400,
      `next_steps_preference must be one of ${VALID_NEXT_STEPS.join(", ")}`,
    );
  }
  if (!isObject(body.objective_ratings)) {
    throw new ApiError(400, "objective_ratings must be an object");
  }

  // ── 2. Load + privacy-check the Stage5Review ───────────────────
  const review = await Stage5Review.findById(input.review_id);
  if (!review) throw new ApiError(404, "Stage 5 review not found");

  // **Critical access control** — the brief calls this out as the
  // most important check on the platform. The learner can ONLY write
  // to their own review. We compare ObjectId via toString to avoid
  // any "ObjectId vs string equality" footguns.
  if (review.learner_id.toString() !== input.caller_id) {
    throw new ApiError(
      403,
      "Forbidden — this Stage 5 review belongs to another learner",
    );
  }

  // ── 3. Single-shot — refuse resubmission ───────────────────────
  if (review.learner_self_assessment !== null) {
    throw new ApiError(
      409,
      "This Stage 5 self-assessment has already been submitted and cannot be resubmitted. " +
        "Ask your org admin if you need to revise your answers.",
    );
  }

  // ── 4. Validate every objective rating key + value ─────────────
  // The keys must be IDs that exist on the snapshot. Orphan keys
  // (typo, stale UI, malicious probe) are rejected so we don't
  // store ratings against objectives that weren't assessed at
  // level-completion time.
  const validIds = new Set(extractObjectiveIds(review.stage3_objectives));
  if (validIds.size === 0) {
    logger.warn(
      { review_id: input.review_id, caller_id: input.caller_id },
      "submitStage5SelfAssessment: review has no stage3_objectives snapshot — accepting empty objective_ratings",
    );
  }

  const ratings = body.objective_ratings as Record<string, unknown>;
  const ratedKeys = Object.keys(ratings);
  for (const key of ratedKeys) {
    if (validIds.size > 0 && !validIds.has(key)) {
      throw new ApiError(
        400,
        `objective_ratings key "${key}" does not match any stage3_objective on this review`,
      );
    }
    const value = ratings[key];
    if (typeof value !== "string" || !VALID_OBJECTIVE.includes(value as ObjectiveRating)) {
      throw new ApiError(
        400,
        `objective_ratings["${key}"] must be one of ${VALID_OBJECTIVE.join(", ")}`,
      );
    }
  }

  // ── 5. Persist the self-assessment ─────────────────────────────
  // We store the submission as a typed object so the Phase 18 AI
  // summary worker, the org-admin sign-off endpoint, and the
  // evidence-report renderer can all read it as a single payload.
  const submitted_at = new Date().toISOString();
  const submission = {
    confidence_rating: body.confidence_rating,
    objective_ratings: ratings,
    next_steps_preference: body.next_steps_preference,
    submitted_at,
  };

  review.learner_self_assessment = submission;
  await review.save();

  // ── 6. AuditLog ────────────────────────────────────────────────
  // `actor_type: "learner"` — the learner is the one taking the
  // action. `before_state: null` because the prior value was always
  // null by the single-shot rule (the resubmit guard above).
  await writeAuditLog(
    {
      actor_type: "learner",
      actor_id: input.caller_id,
      org_id: input.caller_org_id,
      learner_id: input.caller_id,
      action: "stage5_self_assessment_submitted",
      before_state: null,
      after_state: submission,
      reason: `Learner submitted Stage 5 self-assessment: confidence=${body.confidence_rating}, next_steps=${body.next_steps_preference}, ${ratedKeys.length} objective rating(s).`,
    },
    { req: input.req },
  );

  logger.info(
    {
      review_id: input.review_id,
      caller_id: input.caller_id,
      rated_objectives: ratedKeys.length,
      confidence: body.confidence_rating,
      next_steps: body.next_steps_preference,
    },
    "submitStage5SelfAssessment: complete",
  );

  const result: SubmitStage5SelfAssessmentResult = {
    review_id: input.review_id,
    submitted_at,
    next_steps_preference: body.next_steps_preference,
    confidence_rating: body.confidence_rating,
    rated_objectives: ratedKeys.length,
  };
  return new ApiResponse(200, "Stage 5 self-assessment submitted", result);
};

// Re-export internals for tests
export const __internals__ = { extractObjectiveIds };
