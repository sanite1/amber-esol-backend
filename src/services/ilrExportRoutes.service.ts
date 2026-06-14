/**
 * Route-layer helpers for the ILR export endpoints — brief Function
 * 13 To-Do 4.
 *
 * Three flows backed:
 *   POST  /api/org-admin/export/ilr           triggerIlrExportService
 *   GET   /api/org-admin/export/ilr/:jobId/status   getIlrExportStatusService
 *   GET   /api/org-admin/export/ilr/:exportId/download
 *
 * The download route reads bytes from disk in its own controller —
 * no service function is needed for that (the file path is the
 * authority).
 *
 * Service decisions:
 *   - Demo orgs are refused at the trigger layer (Function 14 To-Do
 *     5 follow-up): `Organisation.is_demo: true` → 403. Catches
 *     accidental funding-system submissions from a sales-demo org.
 *   - Idempotency key computed BEFORE enqueueing so the response
 *     can advertise the cache state on the same call that triggers
 *     a fresh run.
 *   - When `?force_refresh=true` is set, the cached job is ignored
 *     and a new one is enqueued. The IdempotencyKey lock still
 *     applies inside the worker — the duplicate-key path will fire
 *     and we'll get the cached result anyway. Calling this a
 *     "force" is a slight lie; documented in the service.
 */

import { Types } from "mongoose";
import { Job } from "bullmq";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Organisation from "../models/Organisation";
import IdempotencyKey from "../models/IdempotencyKey";
import { ilrExportQueue } from "../queues";
import { computeExportIdempotencyKey } from "./ilrExport.service";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// POST /api/org-admin/export/ilr — trigger
// ─────────────────────────────────────────────────────────────────────

export interface TriggerIlrExportInput {
  org_id: string;
  caller_id: string;
  academic_year: string;
  period_start: string;
  period_end: string;
  force_refresh: boolean;
}

export const triggerIlrExportService = async (
  input: TriggerIlrExportInput,
): Promise<ApiResponse> => {
  // ── 1. Shape validation ─────────────────────────────────────────
  if (!input.org_id || !Types.ObjectId.isValid(input.org_id)) {
    throw new ApiError(400, "Organisation context is required");
  }
  if (!input.caller_id || !Types.ObjectId.isValid(input.caller_id)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  if (!/^\d{4}\/\d{2}$/.test(input.academic_year)) {
    throw new ApiError(400, "academic_year must be YYYY/YY (e.g. 2025/26)");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_start)) {
    throw new ApiError(400, "period_start must be YYYY-MM-DD");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_end)) {
    throw new ApiError(400, "period_end must be YYYY-MM-DD");
  }
  if (input.period_start > input.period_end) {
    throw new ApiError(400, "period_start must be on or before period_end");
  }

  // ── 2. Demo-org refusal (brief Function 14 To-Do 5) ─────────────
  // The brief lists this check ahead of every other gate — a demo org
  // accidentally submitting a real funding claim is a serious
  // failure mode. Read the flag, refuse with 403 if set.
  const org = await Organisation.findById(input.org_id)
    .select("is_demo name")
    .lean();
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }
  if (org.is_demo) {
    throw new ApiError(
      403,
      "Demo organisations cannot submit ILR exports. Switch to a live organisation to generate a funding claim.",
    );
  }

  // ── 3. Idempotency key (same algorithm as the export pipeline) ──
  const exportId = computeExportIdempotencyKey({
    org_id: input.org_id,
    academic_year: input.academic_year,
    period_start: input.period_start,
    period_end: input.period_end,
  });

  // ── 4. Cache check (unless force_refresh) ───────────────────────
  if (!input.force_refresh) {
    const cached = await IdempotencyKey.findOne({
      key: exportId,
      operation: "ilr-export",
      status: "completed",
    }).lean();
    if (cached) {
      logger.info(
        { exportId, orgId: input.org_id },
        "triggerIlrExport: returning cached completed export",
      );
      return new ApiResponse(200, "Export already completed (cached)", {
        export_id: exportId,
        cached: true,
        status: "completed",
        download_url: `/api/org-admin/export/ilr/${exportId}/download`,
        json_url: `/api/org-admin/export/ilr/${exportId}/download?format=json`,
      });
    }
  }

  // ── 5. Enqueue ilr-export job ───────────────────────────────────
  // BullMQ jobId is deterministic per (export_id, force flag) so a
  // double-click without force_refresh hits the same job — no
  // duplicate work scheduled.
  const bullJobId = input.force_refresh
    ? `ilr:${exportId}:force-${Date.now()}`
    : `ilr:${exportId}`;
  const job = await ilrExportQueue.add(
    "ilr-export",
    {
      orgId: input.org_id,
      academicYear: input.academic_year,
      periodStart: input.period_start,
      periodEnd: input.period_end,
      requestedBy: input.caller_id,
      exportId,
    },
    { jobId: bullJobId },
  );

  logger.info(
    {
      exportId,
      jobId: job.id,
      orgId: input.org_id,
      force_refresh: input.force_refresh,
    },
    "triggerIlrExport: enqueued",
  );

  return new ApiResponse(202, "ILR export enqueued", {
    export_id: exportId,
    job_id: String(job.id),
    status_url: `/api/org-admin/export/ilr/${job.id}/status`,
    download_url: `/api/org-admin/export/ilr/${exportId}/download`,
    json_url: `/api/org-admin/export/ilr/${exportId}/download?format=json`,
  });
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/export/ilr/:jobId/status
// ─────────────────────────────────────────────────────────────────────

export type ExportJobStatus = "waiting" | "active" | "completed" | "failed";

export interface ExportJobStatusResult {
  job_id: string;
  status: ExportJobStatus;
  progress: number;
  errors_count?: number;
  warnings_count?: number;
  rows_exported?: number;
  download_url?: string;
  json_url?: string;
  failed_reason?: string;
}

const mapBullStateToStatus = (state: string): ExportJobStatus => {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "active":
      return "active";
    default:
      return "waiting"; // includes "delayed", "waiting-children", "waiting", "prioritized"
  }
};

export const getIlrExportStatusService = async (
  jobId: string,
  callerOrgId: string,
): Promise<ApiResponse> => {
  if (!jobId) {
    throw new ApiError(400, "jobId is required");
  }
  if (!callerOrgId || !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(400, "Organisation context is required");
  }

  const job = (await ilrExportQueue.getJob(jobId)) as Job | undefined;
  if (!job) {
    throw new ApiError(404, "Export job not found");
  }

  // Cross-org scope check — a job from a different org shouldn't be
  // observable from this caller's session even via guessed jobId.
  if (job.data.orgId !== callerOrgId) {
    throw new ApiError(403, "Access denied to this export job");
  }

  const state = await job.getState();
  const status = mapBullStateToStatus(state);
  const progressRaw = job.progress;
  const progress =
    typeof progressRaw === "number"
      ? progressRaw
      : status === "completed"
        ? 100
        : 0;

  const result: ExportJobStatusResult = {
    job_id: String(job.id),
    status,
    progress,
  };

  if (status === "completed" && job.returnvalue) {
    const rv = job.returnvalue as {
      export_id?: string;
      rows_exported?: number;
      rows_blocked?: number;
      warnings_count?: number;
      download_url?: string;
      json_url?: string;
    };
    result.errors_count = rv.rows_blocked;
    result.warnings_count = rv.warnings_count;
    result.rows_exported = rv.rows_exported;
    result.download_url = rv.download_url;
    result.json_url = rv.json_url;
  }

  if (status === "failed") {
    result.failed_reason = job.failedReason ?? "Unknown error";
  }

  return new ApiResponse(200, "ILR export status", result);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/export/ilr/:exportId/download — ACL helper
// ─────────────────────────────────────────────────────────────────────

/**
 * The controller streams the bytes; this helper authorises the
 * request (export exists + belongs to the caller's org) and returns
 * the org name so the controller can build the filename.
 */
export interface AuthorisedExport {
  export_id: string;
  org_id: string;
  org_name: string;
  academic_year: string;
  period_start: string;
  period_end: string;
}

export const authoriseDownloadService = async (
  exportId: string,
  callerOrgId: string,
): Promise<AuthorisedExport> => {
  if (!exportId) throw new ApiError(400, "exportId is required");
  if (!callerOrgId || !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(400, "Organisation context is required");
  }

  // The IdempotencyKey row IS the authority — its `org_id` scope and
  // `result` payload tell us which org owns the export and what its
  // metadata is. No separate `IlrExport` collection needed for MVP.
  const lock = await IdempotencyKey.findOne({
    key: exportId,
    operation: "ilr-export",
  }).lean();
  if (!lock) {
    throw new ApiError(404, "Export not found");
  }
  if (lock.status !== "completed") {
    throw new ApiError(
      409,
      `Export is not yet available (status: ${lock.status})`,
    );
  }
  if (lock.org_id?.toString() !== callerOrgId) {
    throw new ApiError(403, "Access denied to this export");
  }

  const result = lock.result as {
    academic_year?: string;
    period_start?: string;
    period_end?: string;
  } | null;
  if (!result) {
    throw new ApiError(500, "Export metadata missing — re-run the export");
  }

  const org = await Organisation.findById(callerOrgId).select("name").lean();
  return {
    export_id: exportId,
    org_id: callerOrgId,
    org_name: org?.name ?? "organisation",
    academic_year: result.academic_year ?? "",
    period_start: result.period_start ?? "",
    period_end: result.period_end ?? "",
  };
};
