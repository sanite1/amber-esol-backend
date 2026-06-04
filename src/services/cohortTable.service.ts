/**
 * Org-admin cohort table service — brief Function 12 To-Do 1
 * (with addendum: teacher GLH column + assigned teacher join).
 *
 * Backs GET /api/org-admin/learners — the paginated table that drives
 * the org admin's day-to-day "where do I spend my attention" view.
 *
 * Architecture — single aggregation pipeline, not N+1:
 *
 *   1. $match learners by org + role + search + level + aim filters.
 *      These prune the candidate set before the expensive joins.
 *   2. $lookup AISession by learnerId with a sub-pipeline that emits
 *      one row per learner carrying the four derived session
 *      aggregates (live hours, imported hours, scenarios passed,
 *      last active). One lookup per learner; sums computed Mongo-side.
 *   3. $lookup LevelChange to resolve `starting_level` — the earliest
 *      LevelChange's `fromLevel`, or fall back to User.starting_level
 *      (the placement-derived value).
 *   4. $lookup User for the assigned teacher's display name.
 *   5. $addFields: derive `status` (prefer cron-precomputed
 *      cohort_status, fall back to live computation), `uln_status`,
 *      and `total_glh`.
 *   6. Optional second $match if a `status` filter was supplied — must
 *      run after the derive step because `status` doesn't exist on the
 *      raw User document.
 *   7. $facet for { rows + total } in a single round-trip.
 *
 * The whole thing is ONE Mongo call. For a typical cohort (~100
 * learners per org) this stays sub-100ms even with the joins. We
 * deliberately don't pre-aggregate AISession sums onto User —
 * historical session imports (Function 5) and real-time AI session
 * writes (Function 7) both touch this, and a precomputed sum would
 * drift without careful invalidation. Aggregation at read time keeps
 * the source of truth single.
 */

import { PipelineStage, Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/**
 * Pagination bounds — brief Function 12 refinement.
 *
 *   DEFAULT_PAGE_SIZE  50   what the cohort table renders by default
 *   MIN_PAGE_SIZE      10   below this is operationally noisy (forces
 *                           the client into a lot of round-trips for
 *                           little benefit)
 *   MAX_PAGE_SIZE     200   protects the backend from runaway responses;
 *                           also the upper bound on a single $facet
 *                           sub-pipeline limit so memory stays bounded
 */
const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

/**
 * Minimum trimmed search length. A one-character search produces a
 * regex that matches most learners — noise on the dashboard and a
 * full-collection scan on the backend until the text index lands.
 * Silently drop anything shorter (the UI behaves as if no search
 * was entered).
 */
const MIN_SEARCH_LENGTH = 2;

/**
 * Live cohort-band thresholds — only used when User.cohort_status was
 * not pre-computed by the daily cron (cohort_status falls back to
 * `null` for freshly enrolled learners the cron hasn't swept yet).
 *
 * Aligned with Function 12 To-Do 4 cron bands:
 *   active     0–4 days
 *   inactive   5–14 days (covers both inactive_mild and inactive_moderate)
 *   dormant    15+ days
 *
 * The cron writes the finer-grained 5-band cohort_status on User;
 * this endpoint surfaces them as three buckets because the cohort
 * table only has one "status" column.
 */
const LIVE_STATUS_THRESHOLDS = {
  ACTIVE_MAX_DAYS: 4,
  INACTIVE_MAX_DAYS: 14,
} as const;

/** Map User.cohort_status (5-band) onto the cohort-table 3-band view. */
const COHORT_TO_TABLE_STATUS: Record<string, "active" | "inactive" | "dormant"> = {
  active: "active",
  new: "active",
  inactive_mild: "inactive",
  inactive_moderate: "inactive",
  dormant: "dormant",
};

/**
 * Reverse — given a status filter from the query, the cohort_status
 * values that match. Used as a PRE-LOOKUP filter so the Mongo planner
 * can use the `(orgId, cohort_status)` compound index instead of
 * scanning every learner and computing `status` post-lookup.
 *
 * Brief Function 12 refinement: this filter PLUS a null/unset escape
 * (for learners the daily cron hasn't yet swept) is the candidate
 * narrowing. The post-derive $match on `status` then catches the
 * null-cohort-status learners whose live last_active still places
 * them in the requested band.
 */
const TABLE_TO_COHORT_STATUS: Record<string, string[]> = {
  active: ["active", "new"],
  inactive: ["inactive_mild", "inactive_moderate"],
  dormant: ["dormant"],
};

// ─────────────────────────────────────────────────────────────────────
// Query shape + result shape
// ─────────────────────────────────────────────────────────────────────

export interface CohortTableQuery {
  status?: string;
  level?: string;
  aim_type?: string;
  search?: string;
  page?: string;
  limit?: string;
}

export interface CohortTableRow {
  _id: string;
  firstname: string;
  lastname: string;
  starting_level: string | null;
  esol_level: string | null;
  total_ai_hours: number;
  imported_hours: number;
  teacher_contact_hours: number;
  total_glh: number;
  scenarios_passed: number;
  last_active: string | null;
  status: "active" | "inactive" | "dormant" | "unknown";
  uln_status: "recorded" | "missing";
  esol_aim_type: string | null;
  assigned_teacher_id: string | null;
  assigned_teacher_name: string | null;
  /**
   * Brief Final Addendum §12 — sortable "Last Reviewed" column on the
   * cohort table. Sourced from User.teacher_last_reviewed_at; null when
   * no teacher has reviewed the learner yet. The frontend renders this
   * as "X days ago" so the org admin can spot learners with no teacher
   * attention at a glance.
   */
  teacher_last_reviewed_at: string | null;
}

const VALID_LEVELS = new Set(["e1", "e2", "e3", "l1", "l2"]);
const VALID_AIM_TYPES = new Set(["regulated", "non_regulated"]);
const VALID_STATUS_FILTERS = new Set(["active", "inactive", "dormant"]);

// ─────────────────────────────────────────────────────────────────────
// Pipeline build
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the aggregation pipeline for ONE org. Exported for tests so we
 * can inspect the pipeline shape without running it.
 */
export const buildCohortPipeline = (
  orgId: Types.ObjectId,
  query: CohortTableQuery,
  pagination: { skip: number; limit: number }
): PipelineStage[] => {
  // ── 1. Pre-lookup match — narrows the candidate set BEFORE the
  //       expensive AISession + LevelChange + Organisation lookups.
  //       Hits the (orgId, cohort_status) and (orgId, esolLevel)
  //       compound indexes on User; see User.ts indexes block.
  const preMatch: Record<string, unknown> = {
    orgId,
    role: "student",
    isActive: true,
  };

  // Level filter — direct compound-index hit on (orgId, esolLevel).
  if (query.level && VALID_LEVELS.has(query.level)) {
    preMatch.esolLevel = query.level;
  }
  // Aim type — straightforward equality, no special index needed.
  if (query.aim_type && VALID_AIM_TYPES.has(query.aim_type)) {
    preMatch.esol_aim_type = query.aim_type;
  }

  // Status + search both want top-level $or; combine via $and so
  // they can coexist without one clobbering the other.
  const andClauses: Record<string, unknown>[] = [];

  // Status filter — pre-narrow on cohort_status, plus a null/unset
  // escape for learners the daily cron hasn't yet swept. The
  // post-derive $match on the computed `status` field then resolves
  // the null-cohort-status learners via their live last_active.
  if (query.status && VALID_STATUS_FILTERS.has(query.status)) {
    const cohortValues = TABLE_TO_COHORT_STATUS[query.status];
    andClauses.push({
      $or: [
        { cohort_status: { $in: cohortValues } },
        { cohort_status: null },
        { cohort_status: { $exists: false } },
      ],
    });
  }

  // Search — case-insensitive partial match on firstname OR lastname.
  // Regex specials are escaped so a learner with the surname "O'Brien"
  // or a stray "." in input doesn't act as a wildcard. Sub-2-character
  // searches are dropped silently (matches everyone, full collection
  // scan).
  if (query.search && query.search.trim().length >= MIN_SEARCH_LENGTH) {
    const rx = new RegExp(
      query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i"
    );
    andClauses.push({
      $or: [{ firstname: rx }, { lastname: rx }],
    });
  }

  if (andClauses.length === 1) {
    // Single $or — keep it top-level so the planner can use indexes
    // without the extra $and indirection.
    Object.assign(preMatch, andClauses[0]);
  } else if (andClauses.length > 1) {
    preMatch.$and = andClauses;
  }

  // ── 2. AISession aggregates (live + imported hours, scenarios, last_active) ──
  const sessionsLookup: PipelineStage.Lookup = {
    $lookup: {
      from: "aisessions",
      let: { learnerId: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$learnerId", "$$learnerId"] } } },
        {
          $group: {
            _id: null,
            total_ai_mins: {
              $sum: {
                $cond: [
                  // session_source in {ai_tutor, teacher_consolidation}
                  // counts as "live" platform contact; pre_platform is
                  // the imported bucket.
                  {
                    $in: [
                      "$session_source",
                      ["ai_tutor", "teacher_consolidation"],
                    ],
                  },
                  { $ifNull: ["$duration_mins", 0] },
                  0,
                ],
              },
            },
            imported_mins: {
              $sum: {
                $cond: [
                  { $eq: ["$session_source", "pre_platform"] },
                  { $ifNull: ["$duration_mins", 0] },
                  0,
                ],
              },
            },
            scenarios_passed: {
              $sum: {
                $cond: [{ $eq: ["$passed", true] }, 1, 0],
              },
            },
            last_active: { $max: "$createdAt" },
          },
        },
      ],
      as: "_session_agg",
    },
  };

  // ── 3. LevelChange for starting_level — earliest LevelChange.fromLevel ──
  const levelChangeLookup: PipelineStage.Lookup = {
    $lookup: {
      from: "levelchanges",
      let: { learnerId: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$learnerId", "$$learnerId"] } } },
        { $sort: { effectiveDate: 1, createdAt: 1 } },
        { $limit: 1 },
        { $project: { fromLevel: 1 } },
      ],
      as: "_first_level_change",
    },
  };

  // ── 4. Assigned teacher name ─────────────────────────────────────
  const teacherLookup: PipelineStage.Lookup = {
    $lookup: {
      from: "users",
      let: { teacherId: "$assigned_teacher_id" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $ne: ["$$teacherId", null] },
                { $eq: ["$_id", "$$teacherId"] },
              ],
            },
          },
        },
        { $project: { firstname: 1, lastname: 1 } },
      ],
      as: "_teacher",
    },
  };

  // ── 5. Derived fields ────────────────────────────────────────────
  const addDerivedFields: PipelineStage.AddFields = {
    $addFields: {
      _agg: { $arrayElemAt: ["$_session_agg", 0] },
      _first_change: { $arrayElemAt: ["$_first_level_change", 0] },
      _teacher_doc: { $arrayElemAt: ["$_teacher", 0] },
    },
  };

  /**
   * Live status computation when User.cohort_status is null.
   *
   *   days since last_active <= 7   → active
   *   8 ≤ days <= 14                → inactive
   *   15+ days                      → dormant
   *   no session at all             → "unknown" (we don't presume)
   *
   * Pre-computed cohort_status (set by the Function 11 daily cron) is
   * preferred when present so the table stays stable between cron
   * runs.
   */
  const addProjectedFields: PipelineStage.AddFields = {
    $addFields: {
      total_ai_hours: {
        $divide: [{ $ifNull: ["$_agg.total_ai_mins", 0] }, 60],
      },
      imported_hours: {
        $divide: [{ $ifNull: ["$_agg.imported_mins", 0] }, 60],
      },
      teacher_contact_hours: { $ifNull: ["$glh_teacher_contact", 0] },
      scenarios_passed: { $ifNull: ["$_agg.scenarios_passed", 0] },
      last_active: "$_agg.last_active",
      // starting_level: prefer the earliest LevelChange.fromLevel; fall
      // back to User.starting_level (placement-set). A learner whose
      // level never changed has only the placement value.
      starting_level: {
        $ifNull: ["$_first_change.fromLevel", "$starting_level"],
      },
      assigned_teacher_name: {
        $cond: [
          { $ifNull: ["$_teacher_doc", false] },
          {
            $concat: [
              { $ifNull: ["$_teacher_doc.firstname", ""] },
              " ",
              { $ifNull: ["$_teacher_doc.lastname", ""] },
            ],
          },
          null,
        ],
      },
      uln_status: {
        $cond: [
          {
            $and: [
              { $ne: ["$uln", null] },
              { $ne: ["$uln", ""] },
            ],
          },
          "recorded",
          "missing",
        ],
      },
      // Live status — used ONLY when cohort_status is null. The
      // expression takes ($$NOW - last_active) in ms and divides into
      // days. No session → "unknown".
      _live_status: {
        $cond: [
          { $eq: [{ $ifNull: ["$_agg.last_active", null] }, null] },
          "unknown",
          {
            $let: {
              vars: {
                daysAgo: {
                  $divide: [
                    { $subtract: ["$$NOW", "$_agg.last_active"] },
                    1000 * 60 * 60 * 24,
                  ],
                },
              },
              in: {
                $switch: {
                  branches: [
                    {
                      case: { $lte: ["$$daysAgo", LIVE_STATUS_THRESHOLDS.ACTIVE_MAX_DAYS] },
                      then: "active",
                    },
                    {
                      case: { $lte: ["$$daysAgo", LIVE_STATUS_THRESHOLDS.INACTIVE_MAX_DAYS] },
                      then: "inactive",
                    },
                  ],
                  default: "dormant",
                },
              },
            },
          },
        ],
      },
    },
  };

  // Now collapse cohort_status (5-band) onto the table's 3-band view.
  const collapseStatus: PipelineStage.AddFields = {
    $addFields: {
      status: {
        $switch: {
          branches: [
            { case: { $in: ["$cohort_status", ["active", "new"]] }, then: "active" },
            {
              case: { $in: ["$cohort_status", ["inactive_mild", "inactive_moderate"]] },
              then: "inactive",
            },
            { case: { $eq: ["$cohort_status", "dormant"] }, then: "dormant" },
          ],
          // cohort_status was null/unknown — defer to live calculation
          default: "$_live_status",
        },
      },
      total_glh: {
        $add: [
          { $divide: [{ $ifNull: ["$_agg.total_ai_mins", 0] }, 60] },
          { $divide: [{ $ifNull: ["$_agg.imported_mins", 0] }, 60] },
          { $ifNull: ["$glh_teacher_contact", 0] },
        ],
      },
    },
  };

  // ── 6. Optional post-derive status filter ────────────────────────
  const postMatchStages: PipelineStage[] = [];
  if (query.status && VALID_STATUS_FILTERS.has(query.status)) {
    postMatchStages.push({ $match: { status: query.status } });
  }

  // ── 7. Final projection — strip internal helper fields ───────────
  const finalProjection: PipelineStage.Project = {
    $project: {
      _id: 1,
      firstname: 1,
      lastname: 1,
      starting_level: 1,
      esol_level: "$esolLevel",
      total_ai_hours: 1,
      imported_hours: 1,
      teacher_contact_hours: 1,
      total_glh: 1,
      scenarios_passed: 1,
      last_active: 1,
      status: 1,
      uln_status: 1,
      esol_aim_type: 1,
      assigned_teacher_id: 1,
      assigned_teacher_name: 1,
      // Brief Final Addendum §12 — for the sortable "Last Reviewed"
      // column. Sourced directly from the User document (no lookup);
      // null when no teacher has touched the learner yet.
      teacher_last_reviewed_at: 1,
    },
  };

  // ── 8. $facet for paginate + total ──────────────────────────────
  const facet: PipelineStage.Facet = {
    $facet: {
      rows: [
        { $sort: { lastname: 1, firstname: 1 } },
        { $skip: pagination.skip },
        { $limit: pagination.limit },
        finalProjection,
      ],
      total: [{ $count: "value" }],
    },
  };

  return [
    { $match: preMatch },
    sessionsLookup,
    levelChangeLookup,
    teacherLookup,
    addDerivedFields,
    addProjectedFields,
    collapseStatus,
    ...postMatchStages,
    facet,
  ];
};

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const getCohortTableService = async (
  callerOrgId: string,
  query: CohortTableQuery
): Promise<ApiResponse> => {
  if (!callerOrgId || !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(400, "Organisation context is required and must be a valid id");
  }

  // Per-field validation. Joi at the route layer catches most of this;
  // service-layer checks are defence-in-depth so a misconfigured route
  // can't bypass filters.
  if (query.status && !VALID_STATUS_FILTERS.has(query.status)) {
    throw new ApiError(400, "status must be one of active, inactive, dormant");
  }
  if (query.level && !VALID_LEVELS.has(query.level)) {
    throw new ApiError(400, "level must be one of e1, e2, e3, l1, l2");
  }
  if (query.aim_type && !VALID_AIM_TYPES.has(query.aim_type)) {
    throw new ApiError(400, "aim_type must be one of regulated, non_regulated");
  }

  // ── Pagination — brief Function 12 refinement ──────────────────
  //   page  ≥ 1       (default 1)
  //   limit 10–200    (default 50)
  //
  // The Joi schema at the route layer enforces the same; this is the
  // defence-in-depth so a misconfigured caller (or an internal service
  // calling the function directly) still lands in the safe range.
  // Out-of-range values throw rather than silently clamp — silent
  // clamping hides client bugs (the client asks for 5000 and never
  // sees that it got 200 back).
  const rawPage = parseInt(query.page ?? "1", 10);
  const rawLimit = parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10);

  if (query.page !== undefined && (!Number.isFinite(rawPage) || rawPage < 1)) {
    throw new ApiError(400, "page must be an integer ≥ 1");
  }
  if (query.limit !== undefined) {
    if (
      !Number.isFinite(rawLimit) ||
      rawLimit < MIN_PAGE_SIZE ||
      rawLimit > MAX_PAGE_SIZE
    ) {
      throw new ApiError(
        400,
        `limit must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`
      );
    }
  }

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Math.min(
    Math.max(
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE,
      MIN_PAGE_SIZE
    ),
    MAX_PAGE_SIZE
  );
  const skip = (page - 1) * limit;

  const pipeline = buildCohortPipeline(
    new Types.ObjectId(callerOrgId),
    query,
    { skip, limit }
  );

  const [facetResult] = await User.aggregate(pipeline);
  const rows = ((facetResult?.rows ?? []) as Array<Record<string, unknown>>).map(
    (r) => normaliseRow(r)
  );
  const total = (facetResult?.total?.[0]?.value as number | undefined) ?? 0;

  return new ApiResponse(200, "Cohort table retrieved", {
    rows,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────
// Response shaping
// ─────────────────────────────────────────────────────────────────────

/**
 * Mongo aggregation returns BSON values; the API contract is JSON
 * (string ObjectIds, ISO dates, numbers rounded to 1dp for hours).
 * Done in Node rather than in the pipeline so a future field addition
 * has one place to land.
 */
const normaliseRow = (row: Record<string, unknown>): CohortTableRow => {
  const roundHour = (v: unknown): number => {
    const n = typeof v === "number" ? v : 0;
    return Math.round(n * 10) / 10;
  };

  const teacherName = (row.assigned_teacher_name ?? null) as string | null;
  return {
    _id: String(row._id),
    firstname: (row.firstname as string) ?? "",
    lastname: (row.lastname as string) ?? "",
    starting_level: (row.starting_level as string | null) ?? null,
    esol_level: (row.esol_level as string | null) ?? null,
    total_ai_hours: roundHour(row.total_ai_hours),
    imported_hours: roundHour(row.imported_hours),
    teacher_contact_hours: roundHour(row.teacher_contact_hours),
    total_glh: roundHour(row.total_glh),
    scenarios_passed: (row.scenarios_passed as number) ?? 0,
    last_active:
      row.last_active instanceof Date ? row.last_active.toISOString() : null,
    status: (row.status as CohortTableRow["status"]) ?? "unknown",
    uln_status: (row.uln_status as CohortTableRow["uln_status"]) ?? "missing",
    esol_aim_type: (row.esol_aim_type as string | null) ?? null,
    assigned_teacher_id: row.assigned_teacher_id
      ? String(row.assigned_teacher_id)
      : null,
    assigned_teacher_name:
      teacherName && teacherName.trim().length > 0 ? teacherName.trim() : null,
    teacher_last_reviewed_at:
      row.teacher_last_reviewed_at instanceof Date
        ? row.teacher_last_reviewed_at.toISOString()
        : null,
  };
};

// Re-exports for tests
export const __internals__ = {
  COHORT_TO_TABLE_STATUS,
  TABLE_TO_COHORT_STATUS,
  LIVE_STATUS_THRESHOLDS,
  DEFAULT_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MIN_SEARCH_LENGTH,
  normaliseRow,
};
