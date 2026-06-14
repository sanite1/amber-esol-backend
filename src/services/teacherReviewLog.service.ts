/**
 * Teacher review-log service — Final Addendum §9, Todo 22.5.
 *
 *   POST /api/teacher/learners/:id/review
 *
 * Pipeline:
 *
 *   1. Assignment gate — learner exists AND is assigned to this
 *      teacher (else 403 / 404 per the disambiguation rule).
 *   2. Capture before-state for the audit row (running totals from
 *      the User doc).
 *   3. Create the TeacherReview (append-only — the schema's
 *      pre-save hook blocks any future mutation; the .create()
 *      call is the only ever-permitted write to this row).
 *   4. Atomically increment `User.glh_teacher_contact` and set
 *      `User.teacher_last_reviewed_at`. `$inc` is the right
 *      primitive — two simultaneous reviews from different
 *      teachers (post-Phase 21 multi-teacher orgs) compose
 *      cleanly without a read-modify-write race.
 *   5. Write an AuditLog row (`teacher_review_logged`) with
 *      before/after snapshots so an auditor can see exactly
 *      what changed.
 *   6. Enqueue a priority recalc on the `priority-queue` queue
 *      with `triggerEvent: "review_logged"`. The Phase 23
 *      scoring consumer (currently stubbed) reads this and
 *      adjusts the recency signal. Enqueue is best-effort —
 *      a queue failure is logged but does NOT roll back the
 *      review write.
 *   7. Return the created review.
 *
 * Atomicity note
 * ==============
 *
 * Steps 3, 4, 5, and 6 each touch a different store
 * (TeacherReview collection, User collection, AuditLog
 * collection, Redis queue). A real two-phase commit is overkill
 * for an MVP that processes a few thousand reviews per month.
 * Order matters instead:
 *
 *   - Review write FIRST. If it fails, nothing else happens and
 *     the caller sees the error.
 *   - User update SECOND. If it fails, we have a TeacherReview
 *     row without the running-total update — surfaces in the
 *     existing GLH drift log in `buildMisRecord` (>0.5h gap
 *     warning). Acceptable for MVP.
 *   - AuditLog THIRD. Best-effort via writeAuditLog (helper
 *     swallows persist failures with an error log; underlying
 *     op stays committed).
 *   - Queue enqueue LAST. Best-effort; logged on failure.
 *
 * Each failure window is small and observable. The post-MVP
 * tightening (Mongo transaction or change-stream-driven repair)
 * is tracked as a P3 in the operations backlog.
 */

import { Types } from "mongoose";
import { Request } from "express";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import TeacherReview from "../models/TeacherReview";
import { glhContributionHours } from "./teacherGlhContribution";
import { writeAuditLog } from "./auditLog.service";
import { enqueueLearnerPriorityRecalc } from "./priorityQueueRecalc.service";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export type TeacherReviewType =
  | "async_review"
  | "contact_session"
  | "pathway_adjustment"
  | "rarpa_signoff";

export interface LogTeacherReviewBody {
  review_type: TeacherReviewType;
  duration_mins: number;
  notes?: string;
  ai_recommendation_acted_on: boolean;
}

export interface LogTeacherReviewInput {
  learner_id: string;
  teacher_id: string;
  body: LogTeacherReviewBody;
  /** Optional — passed through to writeAuditLog for impersonation context. */
  req?: Request;
}

export interface LogTeacherReviewResult {
  review: {
    _id: string;
    learner_id: string;
    teacher_id: string;
    org_id: string;
    review_type: TeacherReviewType;
    duration_mins: number;
    notes: string;
    ai_recommendation_acted_on: boolean;
    created_at: string;
  };
  /** Updated running total after the $inc. Useful for the UI's "your contribution" line. */
  learner_glh_teacher_contact: number;
  /** Echo of the new last-reviewed timestamp. */
  teacher_last_reviewed_at: string;
  /** BullMQ id of the priority-recalc job, when successfully enqueued. */
  priority_recalc_job_id: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level entry — logTeacherReviewService
// ─────────────────────────────────────────────────────────────────────

export const logTeacherReviewService = async (
  input: LogTeacherReviewInput,
): Promise<ApiResponse> => {
  // ── Input validation ───────────────────────────────────────────
  if (!input.learner_id || !Types.ObjectId.isValid(input.learner_id)) {
    throw new ApiError(400, "learner id must be a valid ObjectId");
  }
  if (!input.teacher_id || !Types.ObjectId.isValid(input.teacher_id)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }
  // Joi at the route layer has already validated the body shape;
  // the service re-checks the critical fields defensively so a
  // direct caller (test, future job) can't smuggle bad data in.
  const body = input.body;
  if (typeof body?.duration_mins !== "number" || body.duration_mins <= 0) {
    throw new ApiError(400, "duration_mins must be a positive number");
  }

  const learnerObjectId = new Types.ObjectId(input.learner_id);
  const teacherObjectId = new Types.ObjectId(input.teacher_id);

  // ── 1. Assignment gate ────────────────────────────────────────
  // Narrow projection: just the fields needed for the gate +
  // before-state snapshot. The full learner doc isn't needed
  // here — the response echoes the new running totals only.
  const learner = await User.findById(learnerObjectId)
    .select(
      "_id assigned_teacher_id role orgId glh_teacher_contact teacher_last_reviewed_at",
    )
    .lean();
  if (!learner || learner.role !== "student") {
    // Same 404-on-non-student rule as the detail endpoint — keeps
    // the existence of a non-student user opaque.
    throw new ApiError(404, "Learner not found");
  }
  const assignedTo = (
    learner as { assigned_teacher_id?: Types.ObjectId | null }
  ).assigned_teacher_id;
  if (!assignedTo || assignedTo.toString() !== input.teacher_id) {
    throw new ApiError(403, "Forbidden — this learner is not assigned to you.");
  }
  // A learner without an org shouldn't reach this gate (every
  // learner is org-scoped) but defend against the edge case so a
  // future schema drift doesn't crash the audit log write.
  const orgId = (learner as { orgId?: Types.ObjectId | null }).orgId;
  if (!orgId) {
    throw new ApiError(
      500,
      "Learner has no org assignment — cannot pin TeacherReview without one",
    );
  }

  // ── 2. Before-state snapshot ──────────────────────────────────
  const before_glh =
    (learner as { glh_teacher_contact?: number }).glh_teacher_contact ?? 0;
  const before_last_reviewed =
    (learner as { teacher_last_reviewed_at?: Date | null })
      .teacher_last_reviewed_at ?? null;

  // ── 3. Create the TeacherReview (append-only) ─────────────────
  // The schema's pre-save hook blocks any future mutation; this
  // .create() is the only write that will ever land on this row.
  const created_at = new Date();
  const reviewDoc = await TeacherReview.create({
    learner_id: learnerObjectId,
    teacher_id: teacherObjectId,
    org_id: orgId,
    review_type: body.review_type,
    duration_mins: body.duration_mins,
    notes: typeof body.notes === "string" ? body.notes.trim() : "",
    ai_recommendation_acted_on: Boolean(body.ai_recommendation_acted_on),
    created_at,
  });

  // ── 4. Atomic User update ─────────────────────────────────────
  // $inc composes cleanly with any other concurrent review write
  // — no read-modify-write race even if two teachers log reviews
  // on the same learner in the same millisecond.
  //
  // GLH credit is per review TYPE (Final Addendum §4.3), not raw
  // duration: async 0.25h / pathway 0.25h / sign-off 0.5h /
  // contact duration÷60. See teacherGlhContribution.ts.
  const hoursToAdd = glhContributionHours(body.review_type, body.duration_mins);
  const updateRes = await User.findByIdAndUpdate(
    learnerObjectId,
    {
      $inc: { glh_teacher_contact: hoursToAdd },
      $set: { teacher_last_reviewed_at: created_at },
    },
    { new: true, projection: "glh_teacher_contact teacher_last_reviewed_at" },
  ).lean();

  // Defensive: if the User vanished between the gate read and the
  // update (very unlikely), we already have a TeacherReview row
  // pointing at a missing user. Surface in the log; the
  // failed-jobs dashboard sweep covers reconciliation.
  if (!updateRes) {
    logger.error(
      {
        review_id: (reviewDoc._id as Types.ObjectId).toString(),
        learner_id: input.learner_id,
        teacher_id: input.teacher_id,
      },
      "logTeacherReview: User vanished between gate read and update — orphan review row created",
    );
  }
  const after_glh = updateRes?.glh_teacher_contact ?? before_glh + hoursToAdd;
  const after_last_reviewed = updateRes?.teacher_last_reviewed_at ?? created_at;

  // ── 5. AuditLog row ───────────────────────────────────────────
  // Plain-English `reason` so an org admin reading the audit-log
  // UI sees what the teacher actually did.
  await writeAuditLog(
    {
      actor_type: "teacher",
      actor_id: input.teacher_id,
      org_id: orgId,
      learner_id: input.learner_id,
      action: "teacher_review_logged",
      before_state: {
        glh_teacher_contact: before_glh,
        teacher_last_reviewed_at: before_last_reviewed
          ? before_last_reviewed instanceof Date
            ? before_last_reviewed.toISOString()
            : new Date(before_last_reviewed).toISOString()
          : null,
      },
      after_state: {
        review_id: (reviewDoc._id as Types.ObjectId).toString(),
        review_type: body.review_type,
        duration_mins: body.duration_mins,
        ai_recommendation_acted_on: Boolean(body.ai_recommendation_acted_on),
        glh_teacher_contact: after_glh,
        teacher_last_reviewed_at:
          after_last_reviewed instanceof Date
            ? after_last_reviewed.toISOString()
            : new Date(after_last_reviewed).toISOString(),
      },
      reason: `Teacher review logged: ${body.review_type} for ${body.duration_mins} mins.`,
    },
    { req: input.req },
  );

  // ── 6. Enqueue single-learner priority recalc — best-effort ──
  // Todo 23.4 — `enqueueLearnerPriorityRecalc` dedupes via a
  // per-minute jobId (`recalc:${learner_id}:${YYYY-MM-DDTHH:mm}`),
  // so a teacher firing several actions on the same learner
  // within the same minute (e.g. reviewing, then immediately
  // logging a pathway adjustment) collapses onto one recalc job.
  //
  // The helper SWALLOWS queue write failures — the review is the
  // durable artefact; the daily per-org recalc will catch any
  // staleness within 24h. Never roll back the review on a Redis
  // hiccup.
  const recalcResult = await enqueueLearnerPriorityRecalc(
    input.learner_id,
    "review_logged",
  );
  const priority_recalc_job_id = recalcResult?.jobId ?? null;

  logger.info(
    {
      review_id: (reviewDoc._id as Types.ObjectId).toString(),
      learner_id: input.learner_id,
      teacher_id: input.teacher_id,
      review_type: body.review_type,
      duration_mins: body.duration_mins,
      before_glh,
      after_glh,
      priority_recalc_job_id,
    },
    "logTeacherReview: complete",
  );

  // ── 7. Response ───────────────────────────────────────────────
  const result: LogTeacherReviewResult = {
    review: {
      _id: (reviewDoc._id as Types.ObjectId).toString(),
      learner_id: input.learner_id,
      teacher_id: input.teacher_id,
      org_id: orgId.toString(),
      review_type: body.review_type,
      duration_mins: body.duration_mins,
      notes: typeof body.notes === "string" ? body.notes.trim() : "",
      ai_recommendation_acted_on: Boolean(body.ai_recommendation_acted_on),
      created_at: created_at.toISOString(),
    },
    learner_glh_teacher_contact: Math.round(after_glh * 100) / 100,
    teacher_last_reviewed_at:
      after_last_reviewed instanceof Date
        ? after_last_reviewed.toISOString()
        : new Date(after_last_reviewed).toISOString(),
    priority_recalc_job_id,
  };

  return new ApiResponse(201, "Teacher review logged", result);
};
