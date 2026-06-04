/**
 * Amber-admin teacher-utilisation analytics — Final Addendum §4.
 *
 * Two flows:
 *
 *   GET /api/admin/teacher-utilisation              getTeacherUtilisationService
 *     One row per teacher (User where role: "tutor"). Each row carries:
 *       - identity (teacher_id, teacher_name, email)
 *       - org_ids — every Organisation whose assigned_teacher_ids
 *         contains this teacher
 *       - learner_count — Users with assigned_teacher_id == teacher._id
 *       - max_learners_capacity — MIN of `max_learners_per_teacher`
 *         across this teacher's orgs (most conservative cap)
 *       - utilisation_percent — learner_count / capacity * 100
 *       - this-month aggregates from TeacherReview: count, avg duration
 *         (mins), and total GLH contributed (mins / 60).
 *
 *   GET /api/admin/teacher-utilisation/:teacherId/history
 *                                                  getTeacherHistoryService
 *     Drill-down — recent TeacherReview rows for a single teacher,
 *     newest first.
 *
 * Design notes
 *
 * - Single aggregation pipeline rooted on the User collection. Three
 *   $lookup sub-pipelines (orgs, learners, reviews-this-month). N is
 *   bounded — a typical platform has hundreds of teachers, not
 *   millions — so the JS-layer rollup of headlines is cheaper than
 *   another $facet.
 * - "This month" is the calendar month in UTC. Same approach as
 *   adminOrgsOverview — Europe/London DST drift is within tolerance
 *   for a headline.
 * - `glh_contributed_this_month` is computed FROM TeacherReview rows
 *   in the period (not from `User.glh_teacher_contact`, which is a
 *   running total since onboarding and so doesn't isolate "this
 *   month"). The brief calls this out explicitly.
 * - Capacity defaults to 150 (the Organisation schema default) when
 *   a teacher has no org assignments — that's the rare-but-real case
 *   of a teacher who has logged in but isn't yet attached to an org.
 *   Surfaced with `org_ids: []`; capacity 150 keeps the
 *   utilisation_percent denominator non-zero.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Organisation from "../models/Organisation";
import TeacherReview from "../models/TeacherReview";

// ─────────────────────────────────────────────────────────────────────
// Public response shapes
// ─────────────────────────────────────────────────────────────────────

export interface TeacherUtilisationRow {
  teacher_id: string;
  teacher_name: string;
  email: string | null;
  org_ids: string[];
  org_names: string[];
  learner_count: number;
  max_learners_capacity: number;
  utilisation_percent: number;
  total_reviews_this_month: number;
  avg_review_duration_mins: number;
  glh_contributed_this_month: number;
}

export interface TeacherUtilisationResponse {
  generated_at: string;
  period: { month_start: string; month_end: string };
  teachers: TeacherUtilisationRow[];
}

export interface TeacherReviewHistoryRow {
  _id: string;
  learner_id: string;
  learner_uln: string | null;
  org_id: string | null;
  review_type: string;
  duration_mins: number;
  notes: string;
  ai_recommendation_acted_on: boolean;
  created_at: string;
}

export interface TeacherHistoryResponse {
  teacher_id: string;
  teacher_name: string;
  reviews: TeacherReviewHistoryRow[];
}

// ─────────────────────────────────────────────────────────────────────
// Date helpers
// ─────────────────────────────────────────────────────────────────────

const monthBoundsUtc = (now: Date): { monthStart: Date; monthEnd: Date } => {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const monthEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0) - 1,
  );
  return { monthStart, monthEnd };
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

// Default capacity for a teacher with no org assignments. Matches
// the Organisation schema default so a "floating" teacher isn't a
// divide-by-zero.
const DEFAULT_CAPACITY = 150;

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/teacher-utilisation
// ─────────────────────────────────────────────────────────────────────

interface PipelineRow {
  _id: Types.ObjectId;
  firstname: string | null;
  lastname: string | null;
  email: string | null;
  org_ids: Types.ObjectId[];
  org_names: string[];
  org_caps: number[];
  learner_count: number;
  total_reviews_this_month: number;
  total_review_mins_this_month: number;
}

export const getTeacherUtilisationService = async (
  orgIdFilter?: string,
): Promise<ApiResponse> => {
  if (orgIdFilter && !Types.ObjectId.isValid(orgIdFilter)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }
  const orgObjectId = orgIdFilter
    ? new Types.ObjectId(orgIdFilter)
    : null;

  const now = new Date();
  const { monthStart, monthEnd } = monthBoundsUtc(now);

  const orgsColl = Organisation.collection.name;
  const usersColl = User.collection.name;
  const reviewsColl = TeacherReview.collection.name;

  // The match on the User collection picks every tutor. When an org
  // filter is set, we narrow at the OUTER pipeline AFTER the orgs
  // sub-lookup so we can keep the teacher in the result only if
  // they're in the filtered org. Cheaper than per-row .find filtering
  // in JS.
  const rows: PipelineRow[] = await User.aggregate([
    { $match: { role: "tutor" } },

    // ── Orgs this teacher belongs to ──────────────────────────────
    {
      $lookup: {
        from: orgsColl,
        let: { teacherId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: { $in: ["$$teacherId", { $ifNull: ["$assigned_teacher_ids", []] }] },
            },
          },
          {
            $project: {
              _id: 1,
              name: 1,
              max_learners_per_teacher: {
                $ifNull: ["$max_learners_per_teacher", DEFAULT_CAPACITY],
              },
            },
          },
        ],
        as: "orgs",
      },
    },

    // ── Optional org filter — drop teachers not in the requested org
    ...(orgObjectId
      ? [
          {
            $match: {
              "orgs._id": orgObjectId,
            },
          },
        ]
      : []),

    // ── Count of learners assigned to this teacher ───────────────
    {
      $lookup: {
        from: usersColl,
        let: { teacherId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$assigned_teacher_id", "$$teacherId"] },
                  { $eq: ["$role", "student"] },
                ],
              },
            },
          },
          { $count: "n" },
        ],
        as: "learners",
      },
    },

    // ── TeacherReview rollup for this month ──────────────────────
    {
      $lookup: {
        from: reviewsColl,
        let: { teacherId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$teacher_id", "$$teacherId"] },
                  { $gte: ["$created_at", monthStart] },
                  { $lte: ["$created_at", monthEnd] },
                ],
              },
            },
          },
          {
            $group: {
              _id: null,
              total_reviews: { $sum: 1 },
              total_mins: { $sum: { $ifNull: ["$duration_mins", 0] } },
            },
          },
        ],
        as: "reviews",
      },
    },

    // ── Flatten to a row shape ──────────────────────────────────
    {
      $project: {
        _id: 1,
        firstname: 1,
        lastname: 1,
        email: 1,
        org_ids: "$orgs._id",
        org_names: "$orgs.name",
        org_caps: "$orgs.max_learners_per_teacher",
        learner_count: {
          $ifNull: [{ $arrayElemAt: ["$learners.n", 0] }, 0],
        },
        total_reviews_this_month: {
          $ifNull: [{ $arrayElemAt: ["$reviews.total_reviews", 0] }, 0],
        },
        total_review_mins_this_month: {
          $ifNull: [{ $arrayElemAt: ["$reviews.total_mins", 0] }, 0],
        },
      },
    },

    // Sort: highest utilisation first by default (no caller override
    // — the frontend re-sorts client-side). The pipeline can't sort
    // by computed utilisation without a $addFields, so we sort by
    // learner_count desc as a cheap proxy that doesn't lie far.
    { $sort: { learner_count: -1 } },
  ]);

  const teachers: TeacherUtilisationRow[] = rows.map((r) => {
    const capacity =
      r.org_caps && r.org_caps.length > 0
        ? Math.min(...r.org_caps)
        : DEFAULT_CAPACITY;
    const utilisation_percent =
      capacity > 0 ? Math.round((r.learner_count / capacity) * 1000) / 10 : 0;
    const avg_review_duration_mins =
      r.total_reviews_this_month > 0
        ? round1(r.total_review_mins_this_month / r.total_reviews_this_month)
        : 0;
    const glh_contributed_this_month = round1(
      (r.total_review_mins_this_month ?? 0) / 60,
    );

    const name = `${r.firstname ?? ""} ${r.lastname ?? ""}`.trim();
    return {
      teacher_id: r._id.toString(),
      teacher_name: name || "(unnamed)",
      email: r.email ?? null,
      org_ids: (r.org_ids ?? []).map((id) => id.toString()),
      org_names: r.org_names ?? [],
      learner_count: r.learner_count,
      max_learners_capacity: capacity,
      utilisation_percent,
      total_reviews_this_month: r.total_reviews_this_month,
      avg_review_duration_mins,
      glh_contributed_this_month,
    };
  });

  const payload: TeacherUtilisationResponse = {
    generated_at: now.toISOString(),
    period: {
      month_start: monthStart.toISOString(),
      month_end: monthEnd.toISOString(),
    },
    teachers,
  };
  return new ApiResponse(200, "Teacher utilisation", payload);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/teacher-utilisation/:teacherId/history
// ─────────────────────────────────────────────────────────────────────

/**
 * Default page-size for the drilldown. The brief doesn't paginate
 * this; the typical teacher has dozens-not-thousands of reviews and
 * the modal renders them as a single scrollable list.
 */
const HISTORY_DEFAULT_LIMIT = 100;

export const getTeacherHistoryService = async (
  teacherId: string,
  limit: number = HISTORY_DEFAULT_LIMIT,
): Promise<ApiResponse> => {
  if (!teacherId || !Types.ObjectId.isValid(teacherId)) {
    throw new ApiError(400, "teacherId must be a valid ObjectId");
  }
  const teacher = await User.findById(teacherId)
    .select("firstname lastname role")
    .lean();
  if (!teacher) throw new ApiError(404, "Teacher not found");
  if (teacher.role !== "tutor") {
    throw new ApiError(400, "User is not a tutor / teacher");
  }

  const reviews = await TeacherReview.find({
    teacher_id: new Types.ObjectId(teacherId),
  })
    .sort({ created_at: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))
    .populate("learner_id", "uln")
    .lean();

  const rows: TeacherReviewHistoryRow[] = reviews.map((r) => ({
    _id: (r._id as Types.ObjectId).toString(),
    learner_id: (r as { learner_id: { _id: Types.ObjectId } }).learner_id._id?.toString() ?? "",
    learner_uln:
      ((r as { learner_id?: { uln?: string | null } }).learner_id?.uln ??
        null),
    org_id: (r as { org_id?: Types.ObjectId | null }).org_id?.toString() ?? null,
    review_type: (r as { review_type: string }).review_type,
    duration_mins: (r as { duration_mins: number }).duration_mins,
    notes: (r as { notes?: string }).notes ?? "",
    ai_recommendation_acted_on: Boolean(
      (r as { ai_recommendation_acted_on?: boolean }).ai_recommendation_acted_on,
    ),
    created_at: (r as { created_at: Date }).created_at.toISOString(),
  }));

  const payload: TeacherHistoryResponse = {
    teacher_id: teacherId,
    teacher_name:
      `${teacher.firstname ?? ""} ${teacher.lastname ?? ""}`.trim() || "(unnamed)",
    reviews: rows,
  };
  return new ApiResponse(200, "Teacher review history", payload);
};
