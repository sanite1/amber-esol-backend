/**
 * Stage 5 read service — brief Function 17 (frontend support).
 *
 * Three flows:
 *
 *   GET /api/esol/stage5/pending           — learner's open reviews
 *   GET /api/esol/stage5/:reviewId         — learner-scoped detail
 *   GET /api/org-admin/stage5/:reviewId    — org-admin-scoped detail
 *
 * Authorisation is enforced at the service boundary, NOT inferred
 * from the route. Each function takes both a `caller_id` and a
 * `caller_org_id` and re-checks ownership before returning data.
 * The route layer adds `isAuthenticated + isOrgAdmin/requireOrgContext`
 * as a defence-in-depth gate, but the service is the authority.
 *
 * Response shape carries the firstname of the learner only when the
 * caller is an org admin — learners reading their own review see
 * their own name without server lookup needed.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Stage5Review from "../models/Stage5Review";
import User from "../models/User";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface Stage5ReviewSummary {
  _id: string;
  learner_id: string;
  org_id: string;
  level_completed: string;
  stage3_objectives: Array<{
    id: string;
    skill_domain: string;
    description: string;
    target_level: string | null;
  }>;
  learner_self_assessment: unknown;
  ai_tutor_summary: unknown;
  org_admin_confirmed_at: string | null;
  org_admin_confirmed_by: string | null;
  next_steps: string | null;
  org_admin_advance_to_level: string | null;
  createdAt: string;
}

export interface LearnerStage5DetailResponse extends Stage5ReviewSummary {
  /** Learner-side payload includes the learner's own L1 language so
   *  the UI can render localised labels without a separate /me fetch. */
  learner_l1_language: string | null;
  learner_firstname: string | null;
}

export interface OrgAdminStage5DetailResponse extends Stage5ReviewSummary {
  learner_firstname: string | null;
  learner_lastname: string | null;
  /** ULN is shown in the org-admin view; never sent to the learner. */
  learner_uln: string | null;
}

export interface PendingStage5Response {
  reviews: Array<{
    _id: string;
    level_completed: string;
    createdAt: string;
    learner_self_assessment_submitted: boolean;
  }>;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const projectObjectives = (
  raw: unknown,
): Stage5ReviewSummary["stage3_objectives"] => {
  if (!Array.isArray(raw)) return [];
  const out: Stage5ReviewSummary["stage3_objectives"] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const it = item as Record<string, unknown>;
      if (typeof it.id === "string") {
        out.push({
          id: it.id,
          skill_domain:
            typeof it.skill_domain === "string" ? it.skill_domain : "",
          description: typeof it.description === "string" ? it.description : "",
          target_level:
            typeof it.target_level === "string" ? it.target_level : null,
        });
      }
    }
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/esol/stage5/pending — learner's open reviews
// ─────────────────────────────────────────────────────────────────────

export const getPendingStage5ForLearnerService = async (
  callerId: string,
): Promise<ApiResponse> => {
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  // "Pending" means org-admin sign-off is still null. We don't filter
  // on learner_self_assessment — the page surface differentiates
  // "still to submit" from "submitted, awaiting AI / admin".
  const reviews = await Stage5Review.find({
    learner_id: new Types.ObjectId(callerId),
    org_admin_confirmed_at: null,
  })
    .sort({ createdAt: -1 })
    .select("_id level_completed learner_self_assessment createdAt")
    .lean();

  const payload: PendingStage5Response = {
    reviews: reviews.map((r) => ({
      _id: (r._id as Types.ObjectId).toString(),
      level_completed: r.level_completed,
      createdAt: r.createdAt.toISOString(),
      learner_self_assessment_submitted: r.learner_self_assessment !== null,
    })),
  };
  return new ApiResponse(200, "Pending Stage 5 reviews", payload);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/esol/stage5/:reviewId — learner-scoped detail
// ─────────────────────────────────────────────────────────────────────

export const getStage5ForLearnerService = async (
  reviewId: string,
  callerId: string,
): Promise<ApiResponse> => {
  if (!reviewId || !Types.ObjectId.isValid(reviewId)) {
    throw new ApiError(400, "reviewId must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }

  const review = await Stage5Review.findById(reviewId).lean();
  if (!review) throw new ApiError(404, "Stage 5 review not found");

  // **Critical** — same guard the submit endpoint applies. A learner
  // can only ever read their own review.
  if (review.learner_id.toString() !== callerId) {
    throw new ApiError(
      403,
      "Forbidden — this Stage 5 review belongs to another learner",
    );
  }

  // Learner profile — firstname for the banner, L1 for localisation.
  const learner = await User.findById(callerId)
    .select("firstname l1Language")
    .lean();

  const payload: LearnerStage5DetailResponse = {
    _id: (review._id as Types.ObjectId).toString(),
    learner_id: review.learner_id.toString(),
    org_id: review.org_id.toString(),
    level_completed: review.level_completed,
    stage3_objectives: projectObjectives(review.stage3_objectives),
    learner_self_assessment: review.learner_self_assessment,
    ai_tutor_summary: review.ai_tutor_summary,
    org_admin_confirmed_at: review.org_admin_confirmed_at
      ? (review.org_admin_confirmed_at as Date).toISOString()
      : null,
    org_admin_confirmed_by: review.org_admin_confirmed_by
      ? (review.org_admin_confirmed_by as Types.ObjectId).toString()
      : null,
    next_steps: review.next_steps ?? null,
    org_admin_advance_to_level: review.org_admin_advance_to_level ?? null,
    createdAt: review.createdAt.toISOString(),
    learner_l1_language:
      (learner as { l1Language?: string | null })?.l1Language ?? null,
    learner_firstname: learner?.firstname ?? null,
  };
  return new ApiResponse(200, "Stage 5 review", payload);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/stage5/:reviewId — org-admin-scoped detail
// ─────────────────────────────────────────────────────────────────────

export const getStage5ForOrgAdminService = async (
  reviewId: string,
  callerOrgId: string,
): Promise<ApiResponse> => {
  if (!reviewId || !Types.ObjectId.isValid(reviewId)) {
    throw new ApiError(400, "reviewId must be a valid ObjectId");
  }
  if (!callerOrgId || !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(400, "Organisation context is required");
  }

  const review = await Stage5Review.findById(reviewId).lean();
  if (!review) throw new ApiError(404, "Stage 5 review not found");

  if (review.org_id.toString() !== callerOrgId) {
    throw new ApiError(
      403,
      "Forbidden — this Stage 5 review belongs to another organisation",
    );
  }

  const learner = await User.findById(review.learner_id)
    .select("firstname lastname uln")
    .lean();

  const payload: OrgAdminStage5DetailResponse = {
    _id: (review._id as Types.ObjectId).toString(),
    learner_id: review.learner_id.toString(),
    org_id: review.org_id.toString(),
    level_completed: review.level_completed,
    stage3_objectives: projectObjectives(review.stage3_objectives),
    learner_self_assessment: review.learner_self_assessment,
    ai_tutor_summary: review.ai_tutor_summary,
    org_admin_confirmed_at: review.org_admin_confirmed_at
      ? (review.org_admin_confirmed_at as Date).toISOString()
      : null,
    org_admin_confirmed_by: review.org_admin_confirmed_by
      ? (review.org_admin_confirmed_by as Types.ObjectId).toString()
      : null,
    next_steps: review.next_steps ?? null,
    org_admin_advance_to_level: review.org_admin_advance_to_level ?? null,
    createdAt: review.createdAt.toISOString(),
    learner_firstname: learner?.firstname ?? null,
    learner_lastname: learner?.lastname ?? null,
    learner_uln: (learner as { uln?: string | null })?.uln ?? null,
  };
  return new ApiResponse(200, "Stage 5 review (org admin)", payload);
};
