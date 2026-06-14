/**
 * Amber-admin sales-intelligence service — Final Addendum §13.
 *
 *   GET   /api/admin/sales-intelligence/roi-submissions
 *   PATCH /api/admin/sales-intelligence/roi-submissions/:id/contacted
 *
 * Read-only surface over the public ROI calculator's submission
 * feed. Joey lives in this view: filters the outstanding leads,
 * marks them contacted as they're worked, exports cohorts to CSV
 * for outreach campaigns.
 *
 * The list endpoint reads from the same RoiCalculatorSubmission
 * collection the public POST writes to (Final Addendum §13's
 * earlier task). No data is transformed at storage time —
 * filters apply at read time so a future tweak (e.g. adding a
 * `priority` axis based on unclaimed_income_annual ranges) is a
 * one-file change here.
 *
 * Privacy posture
 * ===============
 *
 *   - `ip_address_hash` and `user_agent` are projected out at the
 *     service layer (the model's toJSON transform already strips
 *     ip_address_hash from the JSON serialiser, but admin
 *     responses go through .lean() which bypasses that — so we
 *     drop both fields explicitly).
 *   - `contacted_by` resolves to a teacher name string at the
 *     service layer; the raw ObjectId never reaches the admin
 *     payload.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import RoiCalculatorSubmission from "../models/RoiCalculatorSubmission";
import User from "../models/User";
import logger from "../config/logger";
import type { RoiOrgType } from "../interfaces/roiCalculatorSubmission.interface";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface ListRoiSubmissionsQuery {
  /** "true" → contacted_at IS NOT NULL; "false" → contacted_at IS NULL. */
  contacted?: string;
  from?: string; // ISO date YYYY-MM-DD
  to?: string; // ISO date YYYY-MM-DD (inclusive)
  org_type?: string;
  page?: string;
  limit?: string;
}

export interface RoiSubmissionRow {
  _id: string;
  org_name: string | null;
  org_type: RoiOrgType | null;
  waiting_list_size: number;
  avg_asf_rate: number;
  current_throughput_per_year: number;
  unclaimed_income_annual: number;
  payback_weeks: number | null;
  contact_email: string | null;
  contact_name: string | null;
  submitted_at: string;
  contacted_at: string | null;
  contacted_by_name: string | null;
}

export interface ListRoiSubmissionsResponse {
  submissions: RoiSubmissionRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  /** Counters for the dashboard top strip — match the filters. */
  aggregates: {
    total_count: number;
    contacted_count: number;
    pending_count: number;
    total_unclaimed_pipeline: number;
  };
  /** Echo of applied filters for the UI "showing X" line. */
  filters: {
    contacted: boolean | null;
    from: string | null;
    to: string | null;
    org_type: RoiOrgType | null;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const VALID_ORG_TYPES: ReadonlyArray<RoiOrgType> = [
  "college",
  "council",
  "charity",
  "employer",
];
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const parseContactedFilter = (raw: string | undefined): boolean | null => {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null; // omit / unknown → no filter
};

const parseDateBound = (raw: string | undefined): Date | null => {
  if (!raw || typeof raw !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const parseOrgTypeFilter = (raw: string | undefined): RoiOrgType | null => {
  if (!raw) return null;
  return VALID_ORG_TYPES.includes(raw as RoiOrgType)
    ? (raw as RoiOrgType)
    : null;
};

// ─────────────────────────────────────────────────────────────────────
// LIST — GET /admin/sales-intelligence/roi-submissions
// ─────────────────────────────────────────────────────────────────────

export const listRoiSubmissionsService = async (
  query: ListRoiSubmissionsQuery,
): Promise<ApiResponse> => {
  const contactedFilter = parseContactedFilter(query.contacted);
  const fromDate = parseDateBound(query.from);
  const toDate = parseDateBound(query.to);
  const orgTypeFilter = parseOrgTypeFilter(query.org_type);

  // Inclusive `to` — extend to end-of-day so a learner who submits
  // at 23:59 on the To date is still picked up.
  const toEnd = toDate
    ? new Date(toDate.getTime() + 24 * 60 * 60 * 1000 - 1)
    : null;
  if (fromDate && toEnd && fromDate > toEnd) {
    throw new ApiError(400, "from must be on or before to");
  }

  const page = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
  const limitRaw = parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10);
  const limit = Math.max(
    1,
    Math.min(MAX_PAGE_SIZE, limitRaw || DEFAULT_PAGE_SIZE),
  );
  const skip = (page - 1) * limit;

  // Build the Mongo filter once; reused by find + countDocuments
  // + aggregate so the four queries can't diverge.
  const filter: Record<string, unknown> = {};
  if (contactedFilter === true) filter.contacted_at = { $ne: null };
  if (contactedFilter === false) filter.contacted_at = null;
  if (fromDate || toEnd) {
    filter.submitted_at = {
      ...(fromDate ? { $gte: fromDate } : {}),
      ...(toEnd ? { $lte: toEnd } : {}),
    };
  }
  if (orgTypeFilter) filter.org_type = orgTypeFilter;

  // ── Parallel queries ────────────────────────────────────────
  // page rows, total count (for pagination), and aggregates (for
  // the dashboard top strip). The aggregate pipeline reuses the
  // same `filter` so the counts match what the table renders.
  const [docs, total, aggregates] = await Promise.all([
    RoiCalculatorSubmission.find(filter)
      .sort({ submitted_at: -1 })
      .skip(skip)
      .limit(limit)
      // Project out PII the admin doesn't need.
      .select("-ip_address_hash -user_agent")
      .lean(),

    RoiCalculatorSubmission.countDocuments(filter),

    RoiCalculatorSubmission.aggregate<{
      total_count: number;
      contacted_count: number;
      pending_count: number;
      total_unclaimed_pipeline: number;
    }>([
      { $match: filter },
      {
        $group: {
          _id: null,
          total_count: { $sum: 1 },
          contacted_count: {
            $sum: { $cond: [{ $ne: ["$contacted_at", null] }, 1, 0] },
          },
          pending_count: {
            $sum: { $cond: [{ $eq: ["$contacted_at", null] }, 1, 0] },
          },
          total_unclaimed_pipeline: { $sum: "$unclaimed_income_annual" },
        },
      },
    ]),
  ]);

  // ── Resolve contacted_by names in one batched lookup ─────────
  // The list typically renders <20 distinct admins; even on a
  // large page (200 rows) the Set dedupe keeps the User query
  // bounded by the admin headcount.
  const contactedByIds = Array.from(
    new Set(
      docs
        .map((d) =>
          (
            d as { contacted_by?: Types.ObjectId | null }
          ).contacted_by?.toString(),
        )
        .filter((id): id is string => Boolean(id)),
    ),
  ).map((id) => new Types.ObjectId(id));

  const adminNameById = new Map<string, string>();
  if (contactedByIds.length > 0) {
    const admins = await User.find({ _id: { $in: contactedByIds } })
      .select("firstname lastname")
      .lean();
    for (const a of admins) {
      adminNameById.set(
        (a._id as Types.ObjectId).toString(),
        `${a.firstname ?? ""} ${a.lastname ?? ""}`.trim() || "Amber admin",
      );
    }
  }

  // ── Project to the response shape ───────────────────────────
  const submissions: RoiSubmissionRow[] = docs.map((d) => {
    const contactedByRaw = (d as { contacted_by?: Types.ObjectId | null })
      .contacted_by;
    return {
      _id: (d._id as Types.ObjectId).toString(),
      org_name: (d as { org_name?: string | null }).org_name ?? null,
      org_type: (d as { org_type?: RoiOrgType | null }).org_type ?? null,
      waiting_list_size: (d as { waiting_list_size: number }).waiting_list_size,
      avg_asf_rate: (d as { avg_asf_rate: number }).avg_asf_rate,
      current_throughput_per_year:
        (d as { current_throughput_per_year?: number })
          .current_throughput_per_year ?? 0,
      unclaimed_income_annual: (d as { unclaimed_income_annual: number })
        .unclaimed_income_annual,
      payback_weeks:
        (d as { payback_weeks?: number | null }).payback_weeks ?? null,
      contact_email:
        (d as { contact_email?: string | null }).contact_email ?? null,
      contact_name:
        (d as { contact_name?: string | null }).contact_name ?? null,
      submitted_at: (d as { submitted_at: Date }).submitted_at.toISOString(),
      contacted_at:
        (d as { contacted_at?: Date | null }).contacted_at?.toISOString() ??
        null,
      contacted_by_name: contactedByRaw
        ? (adminNameById.get(contactedByRaw.toString()) ?? null)
        : null,
    };
  });

  const agg = aggregates[0] ?? {
    total_count: 0,
    contacted_count: 0,
    pending_count: 0,
    total_unclaimed_pipeline: 0,
  };

  const response: ListRoiSubmissionsResponse = {
    submissions,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    },
    aggregates: agg,
    filters: {
      contacted: contactedFilter,
      from: fromDate ? fromDate.toISOString().slice(0, 10) : null,
      to: toDate ? toDate.toISOString().slice(0, 10) : null,
      org_type: orgTypeFilter,
    },
  };
  return new ApiResponse(200, "ROI submissions", response);
};

// ─────────────────────────────────────────────────────────────────────
// MARK CONTACTED — PATCH /admin/.../roi-submissions/:id/contacted
// ─────────────────────────────────────────────────────────────────────

export interface MarkContactedInput {
  submission_id: string;
  admin_user_id: string;
}

export const markRoiSubmissionContactedService = async (
  input: MarkContactedInput,
): Promise<ApiResponse> => {
  if (!input.submission_id || !Types.ObjectId.isValid(input.submission_id)) {
    throw new ApiError(400, "submission id must be a valid ObjectId");
  }
  if (!input.admin_user_id || !Types.ObjectId.isValid(input.admin_user_id)) {
    throw new ApiError(400, "Authenticated admin id required");
  }

  // findOneAndUpdate guarded on `contacted_at: null` so a second
  // concurrent PATCH sees no-match and falls through to the
  // idempotent re-read below. Same pattern the mark-message-read
  // service uses.
  const now = new Date();
  const updated = await RoiCalculatorSubmission.findOneAndUpdate(
    {
      _id: new Types.ObjectId(input.submission_id),
      contacted_at: null,
    },
    {
      $set: {
        contacted_at: now,
        contacted_by: new Types.ObjectId(input.admin_user_id),
      },
    },
    { new: true, projection: "-ip_address_hash -user_agent" },
  ).lean();

  if (updated) {
    logger.info(
      {
        submission_id: input.submission_id,
        admin_user_id: input.admin_user_id,
        contacted_at: now.toISOString(),
      },
      "markRoiSubmissionContacted: flagged",
    );
    return new ApiResponse(200, "Marked as contacted", {
      submission_id: input.submission_id,
      contacted_at: now.toISOString(),
      newly_marked: true,
    });
  }

  // Either the row doesn't exist OR it was already contacted by
  // someone else. Distinguish via a follow-up read so the caller
  // gets the right status (200 idempotent vs 404).
  const existing = await RoiCalculatorSubmission.findById(input.submission_id)
    .select("-ip_address_hash -user_agent")
    .lean();
  if (!existing) {
    throw new ApiError(404, "Submission not found");
  }
  // Already contacted — idempotent 200, echo the existing
  // contacted_at so the UI shows the right "marked at" value.
  return new ApiResponse(200, "Already marked as contacted", {
    submission_id: input.submission_id,
    contacted_at:
      (
        existing as { contacted_at?: Date | null }
      ).contacted_at?.toISOString() ?? null,
    newly_marked: false,
  });
};

// ─────────────────────────────────────────────────────────────────────
// Test exports
// ─────────────────────────────────────────────────────────────────────

export const __internals__ = {
  parseContactedFilter,
  parseDateBound,
  parseOrgTypeFilter,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
};
