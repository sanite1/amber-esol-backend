/**
 * Admin failed-jobs review service — Final Addendum §1.
 *
 * Four flows:
 *
 *   GET    /api/admin/failed-jobs                listFailedJobsService
 *   GET    /api/admin/failed-jobs/count          countFailedJobsService
 *   POST   /api/admin/failed-jobs/:id/retry      retryFailedJobService
 *   DELETE /api/admin/failed-jobs/:id            dismissFailedJobService
 *
 * The retry path re-enqueues the job's ORIGINAL payload onto the
 * queue it came from — same data, fresh BullMQ id, BullMQ's default
 * retry policy applies (3 attempts). On success the FailedJob row is
 * stamped with `retried_at` so an admin reviewing the dashboard
 * tomorrow can see it was actioned.
 *
 * Dismiss is a SOFT delete — sets `dismissed: true` and stamps the
 * admin. The row stays in the collection forever (audit invariant);
 * the default listing filters dismissed out.
 *
 * Both retry and dismiss write an AuditLog row carrying the
 * before/after dismissed/retried state.
 */

import { Types } from "mongoose";
import { Request } from "express";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import FailedJob from "../models/FailedJob";
import { allQueues, QueueName } from "../queues";
import { writeAuditLog } from "./auditLog.service";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface ListFailedJobsQuery {
  queue?: string;
  from?: string; // ISO 8601 — inclusive
  to?: string; // ISO 8601 — inclusive
  page?: string;
  limit?: string;
  /** Optional override — default omits dismissed rows. */
  include_dismissed?: string;
}

export interface FailedJobRow {
  _id: string;
  queue_name: string;
  job_id: string;
  job_data: unknown;
  error: string;
  attempts: number;
  created_at: string;
  retried_at: string | null;
  dismissed: boolean;
  dismissed_by: string | null;
  dismissed_at: string | null;
}

export interface ListFailedJobsResponse {
  jobs: FailedJobRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  /** Per-queue counts of unresolved failures — drives the grouped UI. */
  by_queue: Array<{ queue_name: string; count: number }>;
}

// ─────────────────────────────────────────────────────────────────────
// Pagination defaults
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

const VALID_QUEUE_NAMES = new Set(Object.keys(allQueues));

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/failed-jobs
// ─────────────────────────────────────────────────────────────────────

const buildFilter = (
  query: ListFailedJobsQuery,
): Record<string, unknown> => {
  const filter: Record<string, unknown> = {};

  // Default: hide dismissed rows. Override with ?include_dismissed=true
  // for the "show every failure ever" audit view.
  if (query.include_dismissed !== "true") {
    filter.dismissed = false;
  }

  if (query.queue) {
    if (!VALID_QUEUE_NAMES.has(query.queue)) {
      throw new ApiError(
        400,
        `queue must be one of ${Array.from(VALID_QUEUE_NAMES).join(", ")}`,
      );
    }
    filter.queue_name = query.queue;
  }

  // Date range. Both ends optional; both inclusive.
  if (query.from || query.to) {
    const range: { $gte?: Date; $lte?: Date } = {};
    if (query.from) {
      const d = new Date(query.from);
      if (Number.isNaN(d.getTime())) {
        throw new ApiError(400, "from must be a valid ISO date");
      }
      range.$gte = d;
    }
    if (query.to) {
      const d = new Date(query.to);
      if (Number.isNaN(d.getTime())) {
        throw new ApiError(400, "to must be a valid ISO date");
      }
      range.$lte = d;
    }
    filter.created_at = range;
  }

  return filter;
};

export const listFailedJobsService = async (
  query: ListFailedJobsQuery,
): Promise<ApiResponse> => {
  const rawPage = Number.parseInt(query.page ?? "1", 10);
  const rawLimit = Number.parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Math.min(
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const skip = (page - 1) * limit;

  const filter = buildFilter(query);

  // Three reads in parallel:
  //   1. Page of failed jobs (the list)
  //   2. Total count under the filter (for pagination)
  //   3. Per-queue counts of UNRESOLVED failures (independent of
  //      paging or queue filter — drives the grouped UI header)
  //
  // The third query intentionally re-derives `{ dismissed: false }`
  // rather than reading from `filter` — even if the caller passed
  // ?include_dismissed=true, the grouped summary should still report
  // the "needs attention" count.
  const [docs, total, byQueueAgg] = await Promise.all([
    FailedJob.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).lean(),
    FailedJob.countDocuments(filter),
    FailedJob.aggregate([
      { $match: { dismissed: false } },
      { $group: { _id: "$queue_name", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const jobs: FailedJobRow[] = docs.map((d) => ({
    _id: (d._id as Types.ObjectId).toString(),
    queue_name: d.queue_name,
    job_id: d.job_id,
    job_data: d.job_data,
    error: d.error,
    attempts: d.attempts,
    created_at: d.created_at.toISOString(),
    retried_at: d.retried_at ? d.retried_at.toISOString() : null,
    dismissed: Boolean(d.dismissed),
    dismissed_by: d.dismissed_by ? d.dismissed_by.toString() : null,
    dismissed_at: d.dismissed_at ? d.dismissed_at.toISOString() : null,
  }));

  const by_queue = (byQueueAgg as Array<{ _id: string; count: number }>).map(
    (g) => ({ queue_name: g._id, count: g.count }),
  );

  const payload: ListFailedJobsResponse = {
    jobs,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
    by_queue,
  };
  return new ApiResponse(200, "Failed jobs", payload);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/failed-jobs/count — sidebar-badge feeder
// ─────────────────────────────────────────────────────────────────────

export interface CountFailedJobsResponse {
  unresolved: number;
}

/**
 * Cheap count of unresolved (non-dismissed) failures. Used by the
 * admin sidebar badge — keep it a single bounded query.
 */
export const countFailedJobsService = async (): Promise<ApiResponse> => {
  const unresolved = await FailedJob.countDocuments({ dismissed: false });
  return new ApiResponse(200, "Unresolved failed-job count", { unresolved });
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/failed-jobs/:id/retry
// ─────────────────────────────────────────────────────────────────────

export const retryFailedJobService = async (
  id: string,
  callerId: string,
  req?: Request,
): Promise<ApiResponse> => {
  if (!id || !Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "id must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }

  const failed = await FailedJob.findById(id);
  if (!failed) throw new ApiError(404, "Failed job not found");

  // ── Guard: queue must exist on the running app ────────────────
  const queueName = failed.queue_name as QueueName;
  const queue = (allQueues as Record<string, typeof allQueues[QueueName]>)[
    queueName
  ];
  if (!queue) {
    throw new ApiError(
      500,
      `Queue ${queueName} is not registered — cannot re-enqueue`,
    );
  }

  // Pre-mutation snapshot.
  const before_state = {
    retried_at: failed.retried_at ? failed.retried_at.toISOString() : null,
    dismissed: failed.dismissed,
  };

  // ── Re-enqueue with a deterministic-but-unique BullMQ jobId ───
  // We don't reuse the original job.id — BullMQ rejects a duplicate.
  // Appending a retry-marker keeps the trace readable in Bull Board
  // ("retry-of-<original-id>-<timestamp>") and avoids collision with
  // any future automatic retry that uses the same key.
  const retryJobId = `retry-${failed.job_id}-${Date.now()}`;
  let enqueuedId: string;
  try {
    const enqueued = await queue.add(
      `retry:${failed.job_id}`, // job name — visible in Bull Board
      failed.job_data as never, // original payload, re-cast to the queue's payload type
      { jobId: retryJobId },
    );
    enqueuedId = String(enqueued.id);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, queue: queueName, id },
      "retryFailedJob: enqueue failed",
    );
    throw new ApiError(
      500,
      `Failed to re-enqueue job: ${(err as Error).message}`,
    );
  }

  // ── Stamp retried_at (we don't un-dismiss — retrying a dismissed
  // failure is allowed but the dismiss state stays for audit). ──
  failed.retried_at = new Date();
  await failed.save();

  const after_state = {
    retried_at: failed.retried_at.toISOString(),
    dismissed: failed.dismissed,
    new_bull_job_id: enqueuedId,
  };

  await writeAuditLog(
    {
      actor_type: "amber_admin",
      actor_id: callerId,
      org_id: null,
      learner_id: null,
      action: "failed_job_retried",
      before_state,
      after_state,
      reason: `Re-enqueued failed job on ${queueName} (orig job_id: ${failed.job_id}; new BullMQ id: ${enqueuedId}).`,
    },
    { req },
  );

  logger.info(
    {
      callerId,
      failedJobId: id,
      queueName,
      origJobId: failed.job_id,
      newBullId: enqueuedId,
    },
    "retryFailedJob: re-enqueued",
  );

  return new ApiResponse(200, "Failed job re-enqueued", {
    _id: id,
    queue_name: queueName,
    new_bull_job_id: enqueuedId,
    retried_at: failed.retried_at.toISOString(),
  });
};

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/admin/failed-jobs/:id — soft delete
// ─────────────────────────────────────────────────────────────────────

export const dismissFailedJobService = async (
  id: string,
  callerId: string,
  req?: Request,
): Promise<ApiResponse> => {
  if (!id || !Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "id must be a valid ObjectId");
  }
  if (!callerId || !Types.ObjectId.isValid(callerId)) {
    throw new ApiError(400, "Authenticated caller id required");
  }

  const failed = await FailedJob.findById(id);
  if (!failed) throw new ApiError(404, "Failed job not found");

  if (failed.dismissed) {
    // Idempotent — already dismissed. Return success without
    // re-stamping `dismissed_at` so the audit trail stays clean.
    return new ApiResponse(200, "Failed job already dismissed", {
      _id: id,
      dismissed: true,
      dismissed_by: failed.dismissed_by?.toString() ?? null,
      dismissed_at: failed.dismissed_at?.toISOString() ?? null,
    });
  }

  const before_state = {
    dismissed: false,
    dismissed_by: null,
    dismissed_at: null,
  };

  failed.dismissed = true;
  failed.dismissed_by = new Types.ObjectId(callerId);
  failed.dismissed_at = new Date();
  await failed.save();

  const after_state = {
    dismissed: true,
    dismissed_by: callerId,
    dismissed_at: failed.dismissed_at.toISOString(),
  };

  await writeAuditLog(
    {
      actor_type: "amber_admin",
      actor_id: callerId,
      org_id: null,
      learner_id: null,
      action: "failed_job_dismissed",
      before_state,
      after_state,
      reason: `Dismissed failed job ${failed.job_id} on queue ${failed.queue_name}. Error: ${failed.error.slice(0, 200)}`,
    },
    { req },
  );

  return new ApiResponse(200, "Failed job dismissed", {
    _id: id,
    dismissed: true,
    dismissed_by: callerId,
    dismissed_at: failed.dismissed_at.toISOString(),
  });
};
