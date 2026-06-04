/**
 * Admin safeguarding-alert services — brief Function 10 / Function 15.
 *
 * The Amber-admin (NOT org-admin) is the designated safeguarding lead
 * for the platform. These services back four endpoints:
 *
 *   GET  /api/admin/safeguarding              list (admin only)
 *   GET  /api/admin/safeguarding/:id          detail (admin only)
 *   PATCH /api/admin/safeguarding/:id         resolve (admin only)
 *   GET  /api/org-admin/safeguarding/count    count (org admin)
 *
 * Privacy invariants enforced here, not at the controller:
 *
 *   1. NO response ever includes raw message content — the
 *      `messageContentHash` is the only message-derived field returned.
 *      The Mongo collection doesn't even store the cleartext; this is
 *      belt-and-braces against future schema additions.
 *   2. Org-admin sees ONLY a count for their own org. The
 *      org-admin-count service refuses to return any per-alert detail
 *      even if a caller tries to widen the projection.
 *   3. Session populate is restricted to non-message fields (level,
 *      mode, started/ended timestamps). `turns[]` and `assessmentSummary`
 *      are explicitly projected OUT — they can contain learner-typed
 *      content that a safeguarding-flagged turn could leak.
 *   4. Resolution is monotonic: once `resolvedAt` is set, the PATCH
 *      service refuses to overwrite. An admin can edit `resolutionNotes`
 *      separately if needed — but a separate audit trail (Phase 13)
 *      will cover that. For MVP, single-shot resolution.
 *
 * Controller layer is the role guard (isAdmin / isOrgAdmin); these
 * services trust that gate and don't double-check it. The exception is
 * `getOrgAdminCountService` which requires a non-null org_id at the
 * service boundary so an Amber admin calling the wrong endpoint by
 * mistake gets a clear 400 instead of a wildcard count.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import SafeguardingAlert from "../models/SafeguardingAlert";
import Organisation from "../models/Organisation";
import { ISafeguardingAlert } from "../interfaces/safeguardingAlert.interface";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Whitelisted projection for the session populate. NEVER add `turns`,
 * `turn_buffer`, `assessmentSummary`, or anything that could carry
 * learner-typed content. The list here is the safe subset by enumeration
 * — opting in is intentional so a future field addition doesn't
 * silently start being returned.
 */
const SESSION_SAFE_FIELDS = [
  "esolLevel",
  "sessionMode",
  "scenario_id",
  "session_source",
  "start_time",
  "end_time",
  "completedAt",
  "createdAt",
].join(" ");

/**
 * Brief shape for list + detail responses.
 *
 * The output is deliberately a hand-curated object rather than
 * `alert.toJSON()` — this stops a future schema addition (say
 * `lastTurnSnippet`) from auto-leaking through the API. If you add a
 * field that the Amber admin should see, add it explicitly to the
 * `toBriefResponse` function below.
 */
interface BriefAlertResponse {
  id: string;
  org_id: string;
  org_name: string | null;
  learner_id: string;
  learner_name: string | null;
  learner_email: string | null;
  session_id: string;
  session_context: {
    esol_level: string | null;
    session_mode: string | null;
    scenario_id: string | null;
    started_at: string | null;
    ended_at: string | null;
  } | null;
  category: string | null;
  alert_level: string;
  trigger_source: string | null;
  message_content_hash: string;
  status: string;
  triggered_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolver_name: string | null;
  resolution_notes: string | null;
  notification_sent_at: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Response shaping
// ─────────────────────────────────────────────────────────────────────

const populatedString = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Types.ObjectId) return v.toString();
  if (typeof v === "object" && v !== null && "_id" in (v as object)) {
    const id = (v as { _id: unknown })._id;
    return id ? String(id) : null;
  }
  return typeof v === "string" ? v : String(v);
};

const populatedName = (
  v: unknown,
  format: (doc: { firstname?: string; lastname?: string; name?: string }) => string | null
): string | null => {
  if (!v || typeof v !== "object") return null;
  return format(v as { firstname?: string; lastname?: string; name?: string });
};

const toBriefResponse = (alert: any): BriefAlertResponse => {
  const session = alert.sessionId && typeof alert.sessionId === "object" && "_id" in alert.sessionId
    ? alert.sessionId
    : null;

  return {
    id: alert._id.toString(),
    org_id: populatedString(alert.orgId) ?? "",
    org_name: populatedName(alert.orgId, (o) => o.name ?? null),
    learner_id: populatedString(alert.learnerId) ?? "",
    learner_name: populatedName(alert.learnerId, (l) =>
      l.firstname || l.lastname ? `${l.firstname ?? ""} ${l.lastname ?? ""}`.trim() : null
    ),
    learner_email: populatedName(alert.learnerId, (l) =>
      "email" in (l as Record<string, unknown>) ? ((l as { email?: string }).email ?? null) : null
    ),
    session_id: populatedString(alert.sessionId) ?? "",
    session_context: session
      ? {
          esol_level: session.esolLevel ?? null,
          session_mode: session.sessionMode ?? null,
          scenario_id: session.scenario_id ?? null,
          started_at:
            session.start_time instanceof Date
              ? session.start_time.toISOString()
              : null,
          ended_at:
            session.end_time instanceof Date
              ? session.end_time.toISOString()
              : session.completedAt instanceof Date
                ? session.completedAt.toISOString()
                : null,
        }
      : null,
    category: alert.triggerCategory ?? null,
    alert_level: alert.alertLevel,
    trigger_source: alert.triggerSource ?? null,
    message_content_hash: alert.messageContentHash,
    status: alert.status,
    triggered_at: (alert.createdAt as Date).toISOString(),
    resolved_at:
      alert.resolvedAt instanceof Date ? alert.resolvedAt.toISOString() : null,
    resolved_by: populatedString(alert.resolvedBy),
    resolver_name: populatedName(alert.resolvedBy, (u) =>
      u.firstname || u.lastname ? `${u.firstname ?? ""} ${u.lastname ?? ""}`.trim() : null
    ),
    resolution_notes: alert.resolutionNotes ?? null,
    notification_sent_at:
      alert.notificationSentAt instanceof Date
        ? alert.notificationSentAt.toISOString()
        : null,
  };
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/safeguarding — list (admin only)
// ─────────────────────────────────────────────────────────────────────

export interface AdminListSafeguardingQuery {
  resolved?: string;
  org_id?: string;
  category?: string;
  page?: string;
  limit?: string;
  /** Window filter — alerts with createdAt within the last N days. */
  days?: string;
  /** "true" switches to the aggregate summary response — Function 15 To-Do 2. */
  summary?: string;
}

/**
 * Translate the `?days=N` query param into a Mongo `$gte` cutoff.
 * Returns `null` when the param is absent or invalid (Joi rejects bad
 * shapes upstream, so this is belt-and-braces).
 */
const cutoffFromDays = (raw: string | undefined): Date | null => {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
};

/**
 * List alerts across ALL orgs (Amber admin scope).
 *
 * Filters:
 *   - `resolved=true`  → resolvedAt is non-null
 *   - `resolved=false` → resolvedAt is null
 *   - `org_id`         → exact match on alert.orgId
 *   - `category`       → exact match on triggerCategory
 *
 * Sort is always `triggered_at` (createdAt) descending — the brief
 * specifies this; a query-string override would let a careless caller
 * accidentally page through old alerts first and miss the new ones.
 */
export const listAdminSafeguardingAlertsService = async (
  query: AdminListSafeguardingQuery
): Promise<ApiResponse> => {
  // Page / limit parsing — defensive against negative or NaN inputs.
  const rawPage = parseInt(query.page ?? "1", 10);
  const rawLimit = parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Math.min(
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );
  const skip = (page - 1) * limit;

  const mongoFilter: Record<string, unknown> = {};

  if (query.resolved === "true") {
    mongoFilter.resolvedAt = { $ne: null };
  } else if (query.resolved === "false") {
    mongoFilter.resolvedAt = null;
  }

  if (query.org_id) {
    if (!Types.ObjectId.isValid(query.org_id)) {
      throw new ApiError(400, "org_id must be a valid ObjectId");
    }
    mongoFilter.orgId = new Types.ObjectId(query.org_id);
  }

  if (query.category) {
    mongoFilter.triggerCategory = query.category;
  }

  // Function 15 To-Do 2 — optional window filter.
  const cutoff = cutoffFromDays(query.days);
  if (cutoff) {
    mongoFilter.createdAt = { $gte: cutoff };
  }

  const [docs, total] = await Promise.all([
    SafeguardingAlert.find(mongoFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("orgId", "name")
      .populate("learnerId", "firstname lastname email")
      .populate("resolvedBy", "firstname lastname")
      .populate({
        path: "sessionId",
        select: SESSION_SAFE_FIELDS,
      })
      .lean(),
    SafeguardingAlert.countDocuments(mongoFilter),
  ]);

  return new ApiResponse(200, "Safeguarding alerts retrieved", {
    alerts: docs.map((d) => toBriefResponse(d)),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/safeguarding?summary=true — Function 15 To-Do 2
// ─────────────────────────────────────────────────────────────────────

/**
 * Aggregate counts across the alert collection (admin scope).
 *
 * Returns:
 *   - by_category: [{ category, count }]  sorted desc by count
 *   - by_org:      [{ org_id, org_name, count }] sorted desc by count
 *   - unresolved_over_24h: number of alerts where resolvedAt is null
 *                          AND createdAt is older than 24 hours ago
 *   - avg_resolution_hours / median_resolution_hours: across alerts
 *                                                     resolved IN the
 *                                                     window
 *   - total: total alerts in the window
 *
 * Window filters from the query (`org_id`, `category`, `days`) narrow
 * EVERY metric — including unresolved>24h, which the brief specifies
 * as a count not just a list. A summary call without filters is a
 * platform-wide snapshot; with filters it's a slice.
 *
 * Single $facet aggregation — one collection scan, five rollups.
 */
export interface AdminSafeguardingSummary {
  window: { days: number | null; cutoff: string | null };
  total: number;
  by_category: Array<{ category: string; count: number }>;
  by_org: Array<{ org_id: string; org_name: string; count: number }>;
  unresolved_over_24h: number;
  avg_resolution_hours: number | null;
  median_resolution_hours: number | null;
  resolved_count: number;
}

export const getAdminSafeguardingSummaryService = async (
  query: AdminListSafeguardingQuery,
): Promise<ApiResponse> => {
  const cutoff = cutoffFromDays(query.days);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Base filter — the same one the list service uses, minus paging.
  // Demo orgs are NOT excluded from the summary: a safeguarding event
  // raised on a demo org still matters operationally (typically it's
  // an Amber-internal test triggering it, but it still wants
  // surfacing).
  const baseMatch: Record<string, unknown> = {};
  if (cutoff) baseMatch.createdAt = { $gte: cutoff };
  if (query.org_id) {
    if (!Types.ObjectId.isValid(query.org_id)) {
      throw new ApiError(400, "org_id must be a valid ObjectId");
    }
    baseMatch.orgId = new Types.ObjectId(query.org_id);
  }
  if (query.category) baseMatch.triggerCategory = query.category;

  const orgsColl = Organisation.collection.name;

  const [facet] = await SafeguardingAlert.aggregate<{
    by_category: Array<{ _id: string; count: number }>;
    by_org: Array<{ org_id: Types.ObjectId; org_name: string; count: number }>;
    unresolved_over_24h: Array<{ n: number }>;
    resolution_times: Array<{ avg_ms: number; count: number; values: number[] }>;
    total: Array<{ n: number }>;
  }>([
    { $match: baseMatch },
    {
      $facet: {
        // ── alerts by category (descending) ─────────────────────
        by_category: [
          { $group: { _id: "$triggerCategory", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ],

        // ── alerts by org (descending) — joins Organisation for the
        //    human-readable name. NB. orgId is the alert collection's
        //    field name; the lookup matches against Organisation._id. ─
        by_org: [
          { $group: { _id: "$orgId", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          {
            $lookup: {
              from: orgsColl,
              localField: "_id",
              foreignField: "_id",
              as: "org",
            },
          },
          {
            $project: {
              _id: 0,
              org_id: "$_id",
              org_name: {
                $ifNull: [
                  { $arrayElemAt: ["$org.name", 0] },
                  "(unknown)",
                ],
              },
              count: 1,
            },
          },
        ],

        // ── unresolved older than 24 hours ──────────────────────
        // The 24-hour rule applies regardless of any `days` window
        // — the SLA breach is "still open AND older than a day".
        unresolved_over_24h: [
          {
            $match: {
              resolvedAt: null,
              createdAt: { $lte: twentyFourHoursAgo },
            },
          },
          { $count: "n" },
        ],

        // ── resolution times — avg + values for median ──────────
        // Collect every resolution duration (ms) into a single array
        // so we can compute both mean and median in one pass. For very
        // large windows this would balloon — at our scale (alerts per
        // org are low-double-digits per month) it's fine.
        resolution_times: [
          {
            $match: {
              resolvedAt: { $ne: null },
              createdAt: { $ne: null },
            },
          },
          {
            $project: {
              ms: { $subtract: ["$resolvedAt", "$createdAt"] },
            },
          },
          {
            $group: {
              _id: null,
              avg_ms: { $avg: "$ms" },
              count: { $sum: 1 },
              values: { $push: "$ms" },
            },
          },
        ],

        // ── total in window ─────────────────────────────────────
        total: [{ $count: "n" }],
      },
    },
  ]);

  const total = facet.total[0]?.n ?? 0;
  const unresolved_over_24h = facet.unresolved_over_24h[0]?.n ?? 0;

  const rt = facet.resolution_times[0];
  const avg_resolution_hours = rt
    ? Math.round((rt.avg_ms / 3_600_000) * 100) / 100
    : null;
  let median_resolution_hours: number | null = null;
  if (rt && rt.values.length > 0) {
    const sorted = rt.values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const medianMs =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    median_resolution_hours = Math.round((medianMs / 3_600_000) * 100) / 100;
  }

  const payload: AdminSafeguardingSummary = {
    window: {
      days: query.days ? Number.parseInt(query.days, 10) : null,
      cutoff: cutoff ? cutoff.toISOString() : null,
    },
    total,
    by_category: facet.by_category.map((c) => ({
      category: c._id,
      count: c.count,
    })),
    by_org: facet.by_org.map((o) => ({
      org_id: o.org_id.toString(),
      org_name: o.org_name,
      count: o.count,
    })),
    unresolved_over_24h,
    avg_resolution_hours,
    median_resolution_hours,
    resolved_count: rt?.count ?? 0,
  };

  return new ApiResponse(200, "Safeguarding summary", payload);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/safeguarding/:id — detail (admin only)
// ─────────────────────────────────────────────────────────────────────

export const getAdminSafeguardingAlertService = async (
  alertId: string
): Promise<ApiResponse> => {
  if (!Types.ObjectId.isValid(alertId)) {
    throw new ApiError(400, "alert id must be a valid ObjectId");
  }

  const alert = await SafeguardingAlert.findById(alertId)
    .populate("orgId", "name")
    .populate("learnerId", "firstname lastname email esolLevel l1Language")
    .populate("resolvedBy", "firstname lastname")
    .populate({
      path: "sessionId",
      select: SESSION_SAFE_FIELDS,
    })
    .lean();

  if (!alert) {
    throw new ApiError(404, "Safeguarding alert not found");
  }

  return new ApiResponse(200, "Safeguarding alert retrieved", {
    alert: toBriefResponse(alert),
  });
};

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/admin/safeguarding/:id — resolve (admin only)
// ─────────────────────────────────────────────────────────────────────

export interface ResolveAdminSafeguardingBody {
  resolution_notes?: string;
}

export const resolveAdminSafeguardingAlertService = async (
  alertId: string,
  body: ResolveAdminSafeguardingBody,
  callerId: string
): Promise<ApiResponse> => {
  if (!Types.ObjectId.isValid(alertId)) {
    throw new ApiError(400, "alert id must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }

  const notes = (body?.resolution_notes ?? "").toString().trim();
  if (!notes) {
    throw new ApiError(400, "resolution_notes is required");
  }
  if (notes.length > 4_000) {
    throw new ApiError(400, "resolution_notes must be 4000 characters or fewer");
  }

  // Conditional update so two admins racing to resolve don't clobber
  // each other's notes — first writer wins, second gets 409.
  const updated = await SafeguardingAlert.findOneAndUpdate(
    { _id: new Types.ObjectId(alertId), resolvedAt: null },
    {
      $set: {
        resolvedAt: new Date(),
        resolvedBy: new Types.ObjectId(callerId),
        resolutionNotes: notes,
        status: "resolved",
      },
    },
    { new: true }
  )
    .populate("orgId", "name")
    .populate("learnerId", "firstname lastname email esolLevel l1Language")
    .populate("resolvedBy", "firstname lastname")
    .populate({
      path: "sessionId",
      select: SESSION_SAFE_FIELDS,
    })
    .lean();

  if (!updated) {
    // Either the alert doesn't exist, or someone else already resolved
    // it. Disambiguate so the admin UI can show the right message.
    const exists = await SafeguardingAlert.findById(alertId).select("_id resolvedAt").lean();
    if (!exists) {
      throw new ApiError(404, "Safeguarding alert not found");
    }
    throw new ApiError(409, "Safeguarding alert has already been resolved");
  }

  return new ApiResponse(200, "Safeguarding alert resolved", {
    alert: toBriefResponse(updated),
  });
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/safeguarding/count — count only (org admin)
// ─────────────────────────────────────────────────────────────────────

export interface OrgAdminCountQuery {
  resolved?: string;
}

/**
 * Org-admin view: a single integer.
 *
 * The brief is emphatic that org-admins must not see alert details.
 * This service deliberately returns ZERO identifying information about
 * the underlying alerts — not the categories, not the IDs, not the
 * timestamps. Just the count.
 *
 * Defaults to the OPEN (unresolved) count, which is the figure an org-
 * admin's badge would show. `?resolved=true` returns the resolved
 * count if they want to see historical activity volume. `?resolved`
 * absent returns BOTH so a single round-trip drives the badge + tab.
 */
export const getOrgAdminSafeguardingCountService = async (
  callerOrgId: string | null | undefined,
  query: OrgAdminCountQuery
): Promise<ApiResponse> => {
  if (!callerOrgId) {
    throw new ApiError(400, "Organisation context required for this endpoint");
  }
  if (!Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(400, "Organisation context is invalid");
  }

  const orgObjectId = new Types.ObjectId(callerOrgId);

  if (query.resolved === "true") {
    const resolved = await SafeguardingAlert.countDocuments({
      orgId: orgObjectId,
      resolvedAt: { $ne: null },
    });
    return new ApiResponse(200, "Org safeguarding count", { resolved });
  }
  if (query.resolved === "false") {
    const open = await SafeguardingAlert.countDocuments({
      orgId: orgObjectId,
      resolvedAt: null,
    });
    return new ApiResponse(200, "Org safeguarding count", { open });
  }

  // Default — return both. One DB round-trip per call (parallel).
  const [open, resolved] = await Promise.all([
    SafeguardingAlert.countDocuments({ orgId: orgObjectId, resolvedAt: null }),
    SafeguardingAlert.countDocuments({
      orgId: orgObjectId,
      resolvedAt: { $ne: null },
    }),
  ]);

  return new ApiResponse(200, "Org safeguarding count", {
    open,
    resolved,
    total: open + resolved,
  });
};

// Re-export for tests
export const __internals__ = { toBriefResponse, SESSION_SAFE_FIELDS };
// Suppress unused-import warning when the interface lands without
// being read from an external file yet.
export type _ISafeguardingAlert = ISafeguardingAlert;
