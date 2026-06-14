/**
 * Teacher RARPA Stage 5 sign-off service — Final Addendum §9, Todo 22.7.
 *
 *   POST /api/teacher/learners/:id/rarpa-signoff
 *
 * The teacher signs off a learner's Stage 5 RARPA review. This is
 * the *pedagogical* sign-off: the teacher confirms the AI-tutor
 * summary and the learner's self-assessment together make a
 * defensible record of the level just completed.
 *
 * It precedes (and is required for) the org-admin's compliance
 * confirmation, which lives on the same Stage5Review row as
 * `org_admin_confirmed_at` / `org_admin_confirmed_by`.
 *
 * Pipeline
 * ========
 *
 *   1. Assignment gate — learner exists AND is assigned to this
 *      teacher. Same 404-vs-403 rule as the other teacher
 *      endpoints (404 only when the learner truly doesn't exist).
 *   2. Stage5Review lookup — the row exists AND its `learner_id`
 *      matches the path's `:id`. This guards against a teacher
 *      submitting one learner's review id against another
 *      learner's URL (defence-in-depth: Joi already validated the
 *      ObjectId shape; this is the cross-reference).
 *   3. Pre-condition gates:
 *        a. `learner_self_assessment` populated (non-null).
 *        b. `ai_tutor_summary` populated (non-null).
 *        c. `teacher_signed_off_at` still null (single-shot —
 *           re-signing would clobber the audit story).
 *      Each fails with a 409 carrying a clear "why".
 *   4. Append-only TeacherReview row with
 *      `review_type: "rarpa_signoff"` + `duration_mins: 0`. The
 *      notes carry `teacher_assessment + " | " + next_steps_recommendation`
 *      per the brief — the combined string fits inside the
 *      TeacherReview.notes 500-char schema cap (Joi caps each
 *      half at 240).
 *   5. Stage5Review.findByIdAndUpdate `$set` for
 *      `teacher_signed_off_at` + `teacher_id`. No `$set` on
 *      `next_steps` — that field is the org-admin's free-text
 *      box reserved for the confirmation form; the teacher's
 *      next-steps land in the TeacherReview row instead.
 *   6. AuditLog `rarpa_stage5_teacher_signed_off` with before /
 *      after snapshots of the relevant Stage5Review fields.
 *
 * Atomicity
 * =========
 *
 * Same staged ordering as the review-log / pathway-override
 * services. TeacherReview is the durable artefact (append-only —
 * survives any downstream failure), Stage5Review update second,
 * audit row third. A failure between TeacherReview and
 * Stage5Review leaves a stray review row without the sign-off
 * timestamp — surfaces in the org-admin UI as "teacher review
 * present, no sign-off recorded" and is recoverable by
 * re-running the endpoint (the single-shot guard in step 3c
 * will then refuse the second TeacherReview, and the operator
 * can manually patch Stage5Review).
 *
 * Why no queue dispatch
 * =====================
 *
 * Unlike review-log (which fires a priority recalc), the Stage 5
 * sign-off is a one-time per-level event — it doesn't change the
 * teacher-priority signal in a way the daily cron won't pick up
 * naturally. Adding a recalc here would be cosmetic.
 */

import { Types } from "mongoose";
import { Request } from "express";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Stage5Review from "../models/Stage5Review";
import TeacherReview from "../models/TeacherReview";
import { glhContributionHours } from "./teacherGlhContribution";
import { writeAuditLog } from "./auditLog.service";
import { enqueueLearnerPriorityRecalc } from "./priorityQueueRecalc.service";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface SignOffStage5ReviewBody {
  stage5_review_id: string;
  teacher_assessment: string;
  next_steps_recommendation: string;
}

export interface SignOffStage5ReviewInput {
  learner_id: string;
  teacher_id: string;
  body: SignOffStage5ReviewBody;
  /** Passed through to writeAuditLog for impersonation context. */
  req?: Request;
}

export interface SignOffStage5ReviewResult {
  stage5_review: {
    _id: string;
    learner_id: string;
    org_id: string;
    level_completed: string;
    teacher_signed_off_at: string;
    teacher_id: string;
    org_admin_confirmed_at: string | null;
  };
  teacher_review_id: string;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const signOffStage5ReviewService = async (
  input: SignOffStage5ReviewInput,
): Promise<ApiResponse> => {
  // ── Input validation (defensive — Joi has run at the route) ───
  if (!input.learner_id || !Types.ObjectId.isValid(input.learner_id)) {
    throw new ApiError(400, "learner id must be a valid ObjectId");
  }
  if (!input.teacher_id || !Types.ObjectId.isValid(input.teacher_id)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }
  const body = input.body;
  if (
    !body?.stage5_review_id ||
    !Types.ObjectId.isValid(body.stage5_review_id)
  ) {
    throw new ApiError(400, "stage5_review_id must be a valid ObjectId");
  }
  const teacher_assessment =
    typeof body.teacher_assessment === "string"
      ? body.teacher_assessment.trim()
      : "";
  const next_steps_recommendation =
    typeof body.next_steps_recommendation === "string"
      ? body.next_steps_recommendation.trim()
      : "";
  if (!teacher_assessment) {
    throw new ApiError(400, "teacher_assessment is required");
  }
  if (!next_steps_recommendation) {
    throw new ApiError(400, "next_steps_recommendation is required");
  }

  const learnerObjectId = new Types.ObjectId(input.learner_id);
  const teacherObjectId = new Types.ObjectId(input.teacher_id);
  const reviewObjectId = new Types.ObjectId(body.stage5_review_id);

  // ── 1. Assignment gate ────────────────────────────────────────
  const learner = await User.findById(learnerObjectId)
    .select("_id role assigned_teacher_id orgId")
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
      "Learner has no org assignment — cannot pin Stage 5 sign-off without one",
    );
  }

  // ── 2. Stage5Review lookup + cross-reference ──────────────────
  // We pull the full doc rather than .lean() so the read can act
  // as the "before snapshot" without a second round-trip.
  const review = await Stage5Review.findById(reviewObjectId).lean();
  if (!review) {
    throw new ApiError(404, "Stage 5 review not found");
  }
  if (review.learner_id.toString() !== input.learner_id) {
    // Opaque 404 (not 403) — leaking "this review exists but
    // belongs to a different learner" would let a teacher
    // enumerate Stage5Review ids across the system.
    throw new ApiError(404, "Stage 5 review not found");
  }

  // ── 3. Pre-condition gates ────────────────────────────────────
  if (
    review.learner_self_assessment === null ||
    review.learner_self_assessment === undefined
  ) {
    throw new ApiError(
      409,
      "Cannot sign off — learner has not yet submitted their self-assessment.",
    );
  }
  if (
    review.ai_tutor_summary === null ||
    review.ai_tutor_summary === undefined
  ) {
    throw new ApiError(
      409,
      "Cannot sign off — AI tutor summary has not yet been generated.",
    );
  }
  if (review.teacher_signed_off_at) {
    throw new ApiError(
      409,
      "This Stage 5 review has already been signed off by a teacher.",
    );
  }

  // ── 4. Append-only TeacherReview row ──────────────────────────
  // notes = `${teacher_assessment} | ${next_steps_recommendation}`
  // per the brief. Each half is capped at 240 chars by Joi so the
  // concatenation fits inside the schema-level 500-char limit on
  // TeacherReview.notes.
  const signed_at = new Date();
  const notes = `${teacher_assessment} | ${next_steps_recommendation}`;
  const reviewDoc = await TeacherReview.create({
    learner_id: learnerObjectId,
    teacher_id: teacherObjectId,
    org_id: orgId,
    review_type: "rarpa_signoff",
    duration_mins: 0,
    notes,
    ai_recommendation_acted_on: false,
    created_at: signed_at,
  });

  // GLH credit — Final Addendum §4.3 sets rarpa_signoff at a fixed
  // 0.5h regardless of duration (duration_mins stays 0: there's no
  // wall-clock contact to measure).
  await User.updateOne(
    { _id: learnerObjectId },
    {
      $inc: {
        glh_teacher_contact: glhContributionHours("rarpa_signoff", 0),
      },
      $set: { teacher_last_reviewed_at: signed_at },
    },
  );

  // ── 5. Stage5Review update ────────────────────────────────────
  // Only the two fields the brief specifies — `next_steps` is the
  // org-admin's free-text box and stays untouched by the teacher
  // sign-off. Teacher's recommendation is preserved on the
  // TeacherReview row above.
  const updatedReview = await Stage5Review.findByIdAndUpdate(
    reviewObjectId,
    {
      $set: {
        teacher_signed_off_at: signed_at,
        teacher_id: teacherObjectId,
      },
    },
    { new: true },
  ).lean();

  if (!updatedReview) {
    // The Stage5Review vanished between the gate read and the
    // update — vanishingly unlikely (no other write path deletes
    // it) but we have a stray TeacherReview now. Surface in the
    // log; the failed-jobs dashboard sweep can reconcile.
    logger.error(
      {
        teacher_review_id: (reviewDoc._id as Types.ObjectId).toString(),
        stage5_review_id: body.stage5_review_id,
        learner_id: input.learner_id,
        teacher_id: input.teacher_id,
      },
      "signOffStage5Review: Stage5Review vanished between gate and update — orphan TeacherReview row created",
    );
    throw new ApiError(
      500,
      "Stage 5 review disappeared mid-sign-off — operations team notified.",
    );
  }

  // ── 6. AuditLog row ───────────────────────────────────────────
  await writeAuditLog(
    {
      actor_type: "teacher",
      actor_id: input.teacher_id,
      org_id: orgId,
      learner_id: input.learner_id,
      action: "rarpa_stage5_teacher_signed_off",
      before_state: {
        stage5_review_id: body.stage5_review_id,
        level_completed: review.level_completed,
        teacher_signed_off_at: null,
        teacher_id: null,
      },
      after_state: {
        stage5_review_id: body.stage5_review_id,
        level_completed: review.level_completed,
        teacher_signed_off_at: signed_at.toISOString(),
        teacher_id: input.teacher_id,
        teacher_review_id: (reviewDoc._id as Types.ObjectId).toString(),
      },
      reason:
        `Teacher signed off Stage 5 review for level ${review.level_completed}. ` +
        `Assessment: ${teacher_assessment}`,
    },
    { req: input.req },
  );

  // Todo 23.4 — enqueue single-learner priority recalc. A
  // Stage 5 sign-off changes downstream priority signals
  // (progression-ready trigger no longer fires for this level;
  // dormancy clock effectively resets). Per-minute dedupe; queue
  // failures are swallowed inside the helper.
  await enqueueLearnerPriorityRecalc(
    input.learner_id,
    "rarpa_stage5_signed_off",
  );

  logger.info(
    {
      stage5_review_id: body.stage5_review_id,
      teacher_review_id: (reviewDoc._id as Types.ObjectId).toString(),
      learner_id: input.learner_id,
      teacher_id: input.teacher_id,
      level_completed: review.level_completed,
      signed_at: signed_at.toISOString(),
    },
    "signOffStage5Review: complete",
  );

  const result: SignOffStage5ReviewResult = {
    stage5_review: {
      _id: body.stage5_review_id,
      learner_id: input.learner_id,
      org_id: orgId.toString(),
      level_completed: review.level_completed,
      teacher_signed_off_at: signed_at.toISOString(),
      teacher_id: input.teacher_id,
      org_admin_confirmed_at: updatedReview.org_admin_confirmed_at
        ? new Date(updatedReview.org_admin_confirmed_at).toISOString()
        : null,
    },
    teacher_review_id: (reviewDoc._id as Types.ObjectId).toString(),
  };

  return new ApiResponse(200, "Stage 5 review signed off", result);
};
