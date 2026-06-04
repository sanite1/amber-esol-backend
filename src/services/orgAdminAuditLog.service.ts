/**
 * Org-wide audit log endpoint — Final Addendum §6.
 *
 * Backs GET /api/org-admin/audit-log. The same service powers the
 * org-admin Audit Log tab (no filters), the per-learner Compliance
 * Timeline tab (`?learner_id=…`), and any future "show me everything
 * an Ofsted inspector cares about" view (`?action=ilr_record_generated`).
 *
 * Sort: timestamp desc (newest first). Inspectors read latest-first;
 * a chronological view is one click away on the frontend's order
 * toggle (Phase 13).
 *
 * Names resolved Mongo-side via $lookup:
 *   - actor_name from actor_id (User.firstname + lastname)
 *   - learner_name from learner_id (User.firstname + lastname)
 *
 * Doing the joins here saves the frontend N+1 round-trips. The
 * (org_id, timestamp -1) compound index on AuditLog covers the
 * primary sort + filter; the per-row $lookups run once per limit-N
 * page so the cost is bounded by limit, not by org size.
 *
 * Privacy: actor + learner NAMES are returned, but the org_id scope
 * means a leak across orgs is impossible. The org admin already sees
 * these names on the cohort table and learner detail page; the audit
 * log just gives them a chronological view of the same identities.
 */

import { PipelineStage, Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AuditLog from "../models/AuditLog";
import type { AuditAction } from "../interfaces/auditLog.interface";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

/**
 * Whitelist of actions the cohort dashboard's action picker offers.
 * Sourced from AuditAction (interfaces/auditLog.interface.ts) — if the
 * enum grows, this set grows with it. The service validates against
 * this set rather than re-importing the type at runtime (TS types
 * aren't runtime values).
 */
const VALID_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  "learner_registered",
  "learner_bulk_imported",
  "forskills_imported",
  "historical_session_imported",
  "eligibility_declared",
  "uln_recorded",
  "session_started",
  "session_completed",
  "rarpa_stage_advanced",
  "ilr_record_generated",
  "mis_push_completed",
  "mis_push_held",
  "green_light_passed",
  "safeguarding_alert_raised",
  "safeguarding_ai_only_flag",
  "teacher_review_logged",
  "teacher_message_sent",
  "pathway_override_set",
  "pathway_override_expired",
  "level_change_confirmed",
  "level_change_rejected",
  "placement_completed",
  "stage5_review_generated",
  "progression_ready_flagged",
  "cohort_status_changed",
  "learner_nudge_sent",
]);

// ─────────────────────────────────────────────────────────────────────
// Query shape
// ─────────────────────────────────────────────────────────────────────

export interface OrgAdminAuditLogQuery {
  learner_id?: string;
  action?: string;
  from?: string;
  to?: string;
  page?: string;
  limit?: string;
}

export interface OrgAdminAuditLogRow {
  _id: string;
  timestamp: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  learner_id: string | null;
  learner_name: string | null;
  action: string;
  reason: string;
  before_state: unknown;
  after_state: unknown;
  compliance_config_version: number | null;
}

// ─────────────────────────────────────────────────────────────────────
// Date parsing
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD or full ISO string. Returns a Date or throws 400.
 *
 * For the `from` filter we anchor to start-of-day (00:00:00); for `to`
 * we anchor to end-of-day (23:59:59.999). Both done in UTC because
 * the audit log timestamp is UTC — a user in Europe/London asking for
 * "today" will get a 24-hour window aligned to UTC midnight, which is
 * one hour off civil midnight during BST. Acceptable for MVP; a
 * future enhancement can accept a timezone param.
 */
const parseDateFilter = (
  raw: string,
  end: boolean,
  fieldLabel: string,
): Date => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ApiError(400, `${fieldLabel} must be a non-empty date`);
  }

  // YYYY-MM-DD shorthand
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const time = end ? "T23:59:59.999Z" : "T00:00:00.000Z";
    const d = new Date(`${trimmed}${time}`);
    if (Number.isNaN(d.getTime())) {
      throw new ApiError(400, `${fieldLabel} is not a valid date`);
    }
    return d;
  }

  // Full ISO
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(
      400,
      `${fieldLabel} must be a YYYY-MM-DD date or ISO timestamp`,
    );
  }
  return d;
};

// ─────────────────────────────────────────────────────────────────────
// Pipeline build
// ─────────────────────────────────────────────────────────────────────

export const buildAuditLogPipeline = (
  orgId: Types.ObjectId,
  query: OrgAdminAuditLogQuery,
  pagination: { skip: number; limit: number },
): PipelineStage[] => {
  // ── 1. Pre-lookup $match — hits the (org_id, timestamp -1) index ──
  const match: Record<string, unknown> = { org_id: orgId };

  if (query.learner_id) {
    if (!Types.ObjectId.isValid(query.learner_id)) {
      throw new ApiError(400, "learner_id must be a valid ObjectId");
    }
    match.learner_id = new Types.ObjectId(query.learner_id);
  }

  if (query.action) {
    if (!VALID_ACTIONS.has(query.action as AuditAction)) {
      throw new ApiError(400, `action "${query.action}" is not a known audit action`);
    }
    match.action = query.action;
  }

  if (query.from || query.to) {
    const range: Record<string, Date> = {};
    if (query.from) range.$gte = parseDateFilter(query.from, false, "from");
    if (query.to) range.$lte = parseDateFilter(query.to, true, "to");
    if (range.$gte && range.$lte && range.$gte > range.$lte) {
      throw new ApiError(400, "from must be on or before to");
    }
    match.timestamp = range;
  }

  // ── 2. Name lookups ──────────────────────────────────────────────
  // Both lookups project minimal fields — firstname + lastname only.
  // The actor lookup is conditional on actor_id being non-null
  // (system actions have actor_id null and don't need a join).
  const actorLookup: PipelineStage.Lookup = {
    $lookup: {
      from: "users",
      let: { actorId: "$actor_id" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $ne: ["$$actorId", null] },
                { $eq: ["$_id", "$$actorId"] },
              ],
            },
          },
        },
        { $project: { firstname: 1, lastname: 1 } },
      ],
      as: "_actor_doc",
    },
  };

  const learnerLookup: PipelineStage.Lookup = {
    $lookup: {
      from: "users",
      let: { learnerId: "$learner_id" },
      pipeline: [
        {
          $match: {
            $expr: {
              $and: [
                { $ne: ["$$learnerId", null] },
                { $eq: ["$_id", "$$learnerId"] },
              ],
            },
          },
        },
        { $project: { firstname: 1, lastname: 1 } },
      ],
      as: "_learner_doc",
    },
  };

  // ── 3. $facet for rows + total in one round-trip ─────────────────
  const facet: PipelineStage.Facet = {
    $facet: {
      rows: [
        { $sort: { timestamp: -1 } },
        { $skip: pagination.skip },
        { $limit: pagination.limit },
        actorLookup,
        learnerLookup,
        {
          $addFields: {
            _actor: { $arrayElemAt: ["$_actor_doc", 0] },
            _learner: { $arrayElemAt: ["$_learner_doc", 0] },
          },
        },
        {
          $project: {
            _id: 1,
            timestamp: 1,
            actor_type: 1,
            actor_id: 1,
            actor_name: {
              $cond: [
                { $ifNull: ["$_actor", false] },
                {
                  $trim: {
                    input: {
                      $concat: [
                        { $ifNull: ["$_actor.firstname", ""] },
                        " ",
                        { $ifNull: ["$_actor.lastname", ""] },
                      ],
                    },
                  },
                },
                null,
              ],
            },
            learner_id: 1,
            learner_name: {
              $cond: [
                { $ifNull: ["$_learner", false] },
                {
                  $trim: {
                    input: {
                      $concat: [
                        { $ifNull: ["$_learner.firstname", ""] },
                        " ",
                        { $ifNull: ["$_learner.lastname", ""] },
                      ],
                    },
                  },
                },
                null,
              ],
            },
            action: 1,
            reason: 1,
            before_state: 1,
            after_state: 1,
            compliance_config_version: 1,
          },
        },
      ],
      total: [{ $count: "value" }],
    },
  };

  return [{ $match: match }, facet];
};

// ─────────────────────────────────────────────────────────────────────
// Response shaping
// ─────────────────────────────────────────────────────────────────────

const normaliseRow = (row: Record<string, unknown>): OrgAdminAuditLogRow => ({
  _id: String(row._id),
  timestamp:
    row.timestamp instanceof Date
      ? row.timestamp.toISOString()
      : String(row.timestamp ?? ""),
  actor_type: (row.actor_type as string) ?? "system",
  actor_id: row.actor_id ? String(row.actor_id) : null,
  actor_name:
    typeof row.actor_name === "string" && row.actor_name.trim().length > 0
      ? row.actor_name.trim()
      : null,
  learner_id: row.learner_id ? String(row.learner_id) : null,
  learner_name:
    typeof row.learner_name === "string" && row.learner_name.trim().length > 0
      ? row.learner_name.trim()
      : null,
  action: (row.action as string) ?? "",
  reason: (row.reason as string) ?? "",
  before_state: row.before_state ?? null,
  after_state: row.after_state ?? null,
  compliance_config_version:
    typeof row.compliance_config_version === "number"
      ? row.compliance_config_version
      : null,
});

// ─────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────

export const listOrgAdminAuditLogService = async (
  callerOrgId: string,
  query: OrgAdminAuditLogQuery,
): Promise<ApiResponse> => {
  if (!callerOrgId || !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(
      400,
      "Organisation context is required and must be a valid id",
    );
  }

  // Pagination — same bounds + clamp behaviour as the cohort table
  // (Function 12 refinement); throws on out-of-range so a misconfigured
  // client sees the bug rather than silently getting clamped.
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
        `limit must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`,
      );
    }
  }

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Math.min(
    Math.max(
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE,
      MIN_PAGE_SIZE,
    ),
    MAX_PAGE_SIZE,
  );
  const skip = (page - 1) * limit;

  const pipeline = buildAuditLogPipeline(
    new Types.ObjectId(callerOrgId),
    query,
    { skip, limit },
  );

  const [facetResult] = await AuditLog.aggregate(pipeline);
  const rows = ((facetResult?.rows ?? []) as Array<Record<string, unknown>>).map(
    (r) => normaliseRow(r),
  );
  const total = (facetResult?.total?.[0]?.value as number | undefined) ?? 0;

  return new ApiResponse(200, "Audit log retrieved", {
    rows,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
  });
};

export const __internals__ = {
  VALID_ACTIONS,
  DEFAULT_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseDateFilter,
  normaliseRow,
};
