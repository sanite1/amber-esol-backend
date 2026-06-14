/**
 * Admin MIS sync UI services — Phase 4 / Final Addendum §7 (BE-D).
 *
 * Four operations powering the per-org MIS Integration tab on
 * /admin/orgs/:id. Backed by existing infrastructure:
 *
 *   - Sync log     → reads AuditLog rows for MIS-related actions
 *   - Conflicts    → reads FailedJob rows scoped to the mis-push
 *                    queue (held + terminally-failed pushes that
 *                    need human resolution)
 *   - Sync now     → enqueues a push-batch onto the existing
 *                    mis-push queue with eligible ULNs
 *   - Resolve      → marks the FailedJob dismissed (with an audit
 *                    trail) — the upstream record is unchanged
 *
 * Why no new collection
 * =====================
 *
 * The brief calls out "sync logs" and "conflicts" as distinct
 * surfaces. Today's `AuditLog` already carries every MIS action
 * (`mis_push_*`, `mis_delta_*`, `mis_settings_*`), and `FailedJob`
 * already carries every terminal worker outcome. Adding a third
 * collection would either duplicate that data or fragment the
 * source of truth. We expose existing tables as filtered views
 * instead; if the UI surfaces grow (e.g. annotated notes per
 * conflict), a future iteration can lift them into a dedicated
 * `MisConflict` model without breaking the API contract.
 *
 * Eligible-ULN selection for sync-now
 * ===================================
 *
 * When the caller omits an explicit `ulns` list, we gather every
 * student in the org with a non-null `uln` and enqueue them
 * as a single push-batch. The mis-push worker already dedupes via
 * its idempotency-key system, so a stale double-tap from the UI
 * doesn't double-push. We cap the batch at MAX_ULNS_PER_TRIGGER
 * to keep the worker run bounded; very large orgs will need a
 * paginated trigger UI in a future iteration (documented inline).
 */

import { PipelineStage, Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AuditLog from "../models/AuditLog";
import FailedJob from "../models/FailedJob";
import User from "../models/User";
import { misPushQueue, type MisPushJob } from "../queues";
import { writeAuditLog } from "./auditLog.service";

// ─────────────────────────────────────────────────────────────────────
// Constants — both are deliberate cap rather than business rules.
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

/** Bound the worker run length so a 50K-learner org doesn't ship
 *  a single 50K-element batch. The push-batch worker calls one
 *  build + validate per ULN before the adapter call. */
const MAX_ULNS_PER_TRIGGER = 500;

/** The mis-push queue's identifier in FailedJob rows. Tied to the
 *  queue name in src/queues/index.ts; if that name changes this
 *  constant must too. */
const MIS_PUSH_QUEUE_NAME = "mis-push";

/** Audit actions surfaced in the sync-log view. Order is arbitrary —
 *  the view sorts by timestamp desc. */
const SYNC_LOG_ACTIONS = [
  "mis_push_completed",
  "mis_push_held",
  "mis_delta_discrepancy",
  "mis_delta_unknown_learner",
  "mis_settings_updated",
  "mis_test_connection_attempted",
  // Sync-now writes a row with the action below — pulled into the
  // sync log so the operator sees their own trigger in context.
  // The action is a member of the same enum (no new audit action
  // needed); see triggerSyncNowService.
] as const;

// ─────────────────────────────────────────────────────────────────────
// Query / response shapes
// ─────────────────────────────────────────────────────────────────────

export interface MisSyncQuery {
  page?: string;
  limit?: string;
}

export interface MisSyncLogRow {
  _id: string;
  timestamp: string;
  action: string;
  actor_type: string;
  actor_name: string | null;
  learner_id: string | null;
  learner_name: string | null;
  reason: string;
  before_state: unknown;
  after_state: unknown;
}

export interface MisSyncLogResponse {
  rows: MisSyncLogRow[];
  summary: {
    /** Counts per-action across the WHOLE history (not just the page). */
    by_action: Record<string, number>;
    /** Last successful push timestamp (mis_push_completed), if any. */
    last_pushed_at: string | null;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export interface MisConflictRow {
  _id: string;
  queue_name: string;
  job_id: string;
  error: string;
  attempts: number;
  created_at: string;
  /** Slice of the job_data payload useful for surfacing context. */
  job_summary: {
    kind?: string;
    uln?: string | null;
    ulns_count?: number | null;
  };
  retried_at: string | null;
  dismissed: boolean;
}

export interface MisConflictsResponse {
  rows: MisConflictRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export interface TriggerSyncNowInput {
  org_id: string;
  actor_user_id: string;
  /** Optional explicit ULN list. When omitted, the service collects
   *  every student in the org with a non-null `uln`. */
  ulns?: string[] | null;
}

export interface TriggerSyncNowResponse {
  job_id: string;
  ulns_enqueued: number;
  capped: boolean;
}

export interface ResolveConflictInput {
  conflict_id: string;
  org_id: string;
  actor_user_id: string;
  note?: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Pagination helper
// ─────────────────────────────────────────────────────────────────────

const parsePagination = (
  query: MisSyncQuery,
): { page: number; limit: number; skip: number } => {
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
  return { page, limit, skip: (page - 1) * limit };
};

const requireOrgId = (orgId: string): Types.ObjectId => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "Organisation id must be a valid ObjectId");
  }
  return new Types.ObjectId(orgId);
};

// ═════════════════════════════════════════════════════════════════════
// 1. Sync log — paginated AuditLog view + summary aggregate
// ═════════════════════════════════════════════════════════════════════

export const listSyncLogsService = async (
  orgId: string,
  query: MisSyncQuery,
): Promise<ApiResponse> => {
  const orgObjectId = requireOrgId(orgId);
  const { page, limit, skip } = parsePagination(query);

  const match: Record<string, unknown> = {
    org_id: orgObjectId,
    action: { $in: SYNC_LOG_ACTIONS },
  };

  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $facet: {
        rows: [
          { $sort: { timestamp: -1 } },
          { $skip: skip },
          { $limit: limit },
          // Resolve actor name from User collection. Mirrors the
          // pattern in orgAdminAuditLog.service for cross-page UX
          // consistency (the actor pill reads the same way).
          {
            $lookup: {
              from: "users",
              localField: "actor_id",
              foreignField: "_id",
              as: "_actor",
            },
          },
          {
            $lookup: {
              from: "users",
              localField: "learner_id",
              foreignField: "_id",
              as: "_learner",
            },
          },
          {
            $project: {
              _id: 1,
              timestamp: 1,
              action: 1,
              actor_type: 1,
              actor_name: {
                $let: {
                  vars: { a: { $arrayElemAt: ["$_actor", 0] } },
                  in: {
                    $cond: [
                      { $ifNull: ["$$a", false] },
                      {
                        $trim: {
                          input: {
                            $concat: [
                              { $ifNull: ["$$a.firstname", ""] },
                              " ",
                              { $ifNull: ["$$a.lastname", ""] },
                            ],
                          },
                        },
                      },
                      null,
                    ],
                  },
                },
              },
              learner_id: 1,
              learner_name: {
                $let: {
                  vars: { l: { $arrayElemAt: ["$_learner", 0] } },
                  in: {
                    $cond: [
                      { $ifNull: ["$$l", false] },
                      {
                        $trim: {
                          input: {
                            $concat: [
                              { $ifNull: ["$$l.firstname", ""] },
                              " ",
                              { $ifNull: ["$$l.lastname", ""] },
                            ],
                          },
                        },
                      },
                      null,
                    ],
                  },
                },
              },
              reason: 1,
              before_state: 1,
              after_state: 1,
            },
          },
        ],
        total: [{ $count: "value" }],
        by_action: [{ $group: { _id: "$action", count: { $sum: 1 } } }],
        last_pushed_at: [
          { $match: { action: "mis_push_completed" } },
          { $sort: { timestamp: -1 } },
          { $limit: 1 },
          { $project: { timestamp: 1 } },
        ],
      },
    },
  ];

  const [facetResult] = await AuditLog.aggregate(pipeline);
  const rawRows = (facetResult?.rows ?? []) as Array<Record<string, unknown>>;
  const total = (facetResult?.total?.[0]?.value as number | undefined) ?? 0;
  const byActionArr = (facetResult?.by_action ?? []) as Array<{
    _id: string;
    count: number;
  }>;
  const lastPushedDoc = (facetResult?.last_pushed_at?.[0] ?? null) as {
    timestamp: Date;
  } | null;

  const rows: MisSyncLogRow[] = rawRows.map((r) => {
    const ts = r.timestamp as Date | string;
    const lid = r.learner_id as Types.ObjectId | null | undefined;
    const trimOrNull = (s: unknown): string | null => {
      if (typeof s !== "string") return null;
      const t = s.trim();
      return t.length === 0 ? null : t;
    };
    return {
      _id: String(r._id),
      timestamp: ts instanceof Date ? ts.toISOString() : String(ts),
      action: String(r.action ?? ""),
      actor_type: String(r.actor_type ?? "system"),
      actor_name: trimOrNull(r.actor_name),
      learner_id: lid ? lid.toString() : null,
      learner_name: trimOrNull(r.learner_name),
      reason: String(r.reason ?? ""),
      before_state: r.before_state ?? null,
      after_state: r.after_state ?? null,
    };
  });

  const by_action: Record<string, number> = {};
  for (const e of byActionArr) by_action[e._id] = e.count;

  return new ApiResponse(200, "MIS sync logs retrieved", {
    rows,
    summary: {
      by_action,
      last_pushed_at: lastPushedDoc?.timestamp
        ? new Date(lastPushedDoc.timestamp).toISOString()
        : null,
    },
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
  } satisfies MisSyncLogResponse);
};

// ═════════════════════════════════════════════════════════════════════
// 2. Conflicts — FailedJob rows for the mis-push queue, this org,
//    not yet dismissed.
// ═════════════════════════════════════════════════════════════════════

export const listMisConflictsService = async (
  orgId: string,
  query: MisSyncQuery,
): Promise<ApiResponse> => {
  const orgObjectId = requireOrgId(orgId);
  const { page, limit, skip } = parsePagination(query);

  // FailedJob carries the job's full data payload; we filter on
  // org_id inside job_data because the MIS push jobs always carry
  // an `org_id` field. The query uses `$elemMatch`-free dotted
  // path which Mongo can evaluate against a sparse index — fine
  // for the per-org admin surface scale (one org's history).
  const match: Record<string, unknown> = {
    queue_name: MIS_PUSH_QUEUE_NAME,
    "job_data.org_id": orgObjectId.toString(),
    dismissed: false,
  };

  const [rows, total] = await Promise.all([
    FailedJob.find(match)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    FailedJob.countDocuments(match),
  ]);

  const shape = (r: Record<string, unknown>): MisConflictRow => {
    const jd = (r.job_data ?? {}) as {
      kind?: string;
      uln?: string;
      ulns?: string[];
    };
    return {
      _id: String(r._id),
      queue_name: String(r.queue_name ?? ""),
      job_id: String(r.job_id ?? ""),
      error: String(r.error ?? ""),
      attempts: Number(r.attempts ?? 0),
      created_at: (r.created_at as Date).toISOString(),
      job_summary: {
        kind: jd.kind,
        uln: jd.uln ?? null,
        ulns_count: Array.isArray(jd.ulns) ? jd.ulns.length : null,
      },
      retried_at: r.retried_at ? (r.retried_at as Date).toISOString() : null,
      dismissed: Boolean(r.dismissed),
    };
  };

  return new ApiResponse(200, "MIS conflicts retrieved", {
    rows: (rows as unknown as Array<Record<string, unknown>>).map(shape),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
  } satisfies MisConflictsResponse);
};

// ═════════════════════════════════════════════════════════════════════
// 3. Sync now — enqueue a push-batch
// ═════════════════════════════════════════════════════════════════════

export const triggerSyncNowService = async (
  input: TriggerSyncNowInput,
): Promise<ApiResponse> => {
  const orgObjectId = requireOrgId(input.org_id);
  if (!input.actor_user_id || !Types.ObjectId.isValid(input.actor_user_id)) {
    throw new ApiError(400, "Actor user id is required");
  }

  let ulns: string[];
  if (Array.isArray(input.ulns) && input.ulns.length > 0) {
    ulns = input.ulns.map((u) => String(u).trim()).filter(Boolean);
  } else {
    // Gather every student in the org with a non-null ULN. Cap to
    // avoid an out-of-scope job. The cap surfaces back to the
    // caller so the UI can prompt for a targeted re-sync if hit.
    const learners = await User.find({
      orgId: orgObjectId,
      role: "student",
      uln: { $ne: null, $exists: true },
    })
      .select("uln")
      .limit(MAX_ULNS_PER_TRIGGER + 1)
      .lean();
    ulns = (learners as unknown as Array<{ uln: string }>)
      .map((l) => String(l.uln).trim())
      .filter(Boolean);
  }

  const capped = ulns.length > MAX_ULNS_PER_TRIGGER;
  if (capped) ulns = ulns.slice(0, MAX_ULNS_PER_TRIGGER);

  if (ulns.length === 0) {
    // Nothing to push — still write an audit row so the operator
    // can see they pressed the button. No enqueue, no consumed
    // worker slot.
    await writeAuditLog({
      actor_type: "amber_admin",
      actor_id: input.actor_user_id,
      org_id: input.org_id,
      learner_id: null,
      action: "mis_settings_updated", // closest existing enum value
      before_state: null,
      after_state: { sync_now_triggered: true, ulns_enqueued: 0 },
      reason: "Manual MIS sync triggered — no eligible ULNs to push.",
    });
    return new ApiResponse(200, "No eligible ULNs to push", {
      job_id: "",
      ulns_enqueued: 0,
      capped: false,
    } satisfies TriggerSyncNowResponse);
  }

  const jobData: MisPushJob = {
    kind: "push-batch",
    org_id: input.org_id,
    ulns,
    requested_by: input.actor_user_id,
  };
  const job = await misPushQueue.add("mis-sync-now", jobData, {
    // No idempotency key here — the operator pressing "Sync now"
    // EXPECTS a fresh attempt. Per-ULN idempotency inside the
    // worker still de-dupes successful pushes.
    removeOnComplete: true,
    removeOnFail: false,
  });

  await writeAuditLog({
    actor_type: "amber_admin",
    actor_id: input.actor_user_id,
    org_id: input.org_id,
    learner_id: null,
    action: "mis_settings_updated", // closest existing enum value
    before_state: null,
    after_state: {
      sync_now_triggered: true,
      ulns_enqueued: ulns.length,
      capped,
      job_id: String(job.id ?? ""),
    },
    reason: `Manual MIS sync triggered — ${ulns.length} ULN${ulns.length === 1 ? "" : "s"} enqueued${capped ? ` (capped at ${MAX_ULNS_PER_TRIGGER})` : ""}.`,
  });

  return new ApiResponse(202, "MIS sync enqueued", {
    job_id: String(job.id ?? ""),
    ulns_enqueued: ulns.length,
    capped,
  } satisfies TriggerSyncNowResponse);
};

// ═════════════════════════════════════════════════════════════════════
// 4. Resolve conflict — dismiss FailedJob + audit
// ═════════════════════════════════════════════════════════════════════

export const resolveMisConflictService = async (
  input: ResolveConflictInput,
): Promise<ApiResponse> => {
  const orgObjectId = requireOrgId(input.org_id);
  if (!input.conflict_id || !Types.ObjectId.isValid(input.conflict_id)) {
    throw new ApiError(400, "Conflict id must be a valid ObjectId");
  }
  if (!input.actor_user_id || !Types.ObjectId.isValid(input.actor_user_id)) {
    throw new ApiError(400, "Actor user id is required");
  }

  // Ownership check: this conflict must be a mis-push job AND
  // belong to the supplied org. 404 on either failing — opaque so
  // a tampered id can't probe cross-org existence.
  const conflict = await FailedJob.findOne({
    _id: new Types.ObjectId(input.conflict_id),
    queue_name: MIS_PUSH_QUEUE_NAME,
    "job_data.org_id": orgObjectId.toString(),
  }).lean();
  if (!conflict) {
    throw new ApiError(404, "Conflict not found");
  }

  if ((conflict as { dismissed?: boolean }).dismissed) {
    return new ApiResponse(200, "Conflict already resolved", {
      already_resolved: true,
    });
  }

  const note = input.note?.trim() || "";
  const now = new Date();
  await FailedJob.updateOne(
    { _id: (conflict as unknown as { _id: Types.ObjectId })._id },
    {
      $set: {
        dismissed: true,
        dismissed_by: new Types.ObjectId(input.actor_user_id),
        dismissed_at: now,
      },
    },
  );

  await writeAuditLog({
    actor_type: "amber_admin",
    actor_id: input.actor_user_id,
    org_id: input.org_id,
    learner_id: null,
    action: "failed_job_dismissed",
    before_state: { dismissed: false },
    after_state: { dismissed: true, dismissed_at: now, note: note || null },
    reason: note
      ? `MIS conflict resolved by admin: ${note}`
      : "MIS conflict resolved by admin (no note).",
  });

  return new ApiResponse(200, "Conflict resolved", {
    already_resolved: false,
    dismissed_at: now.toISOString(),
  });
};

export const __internals__ = {
  MAX_ULNS_PER_TRIGGER,
  MIS_PUSH_QUEUE_NAME,
  SYNC_LOG_ACTIONS,
};
