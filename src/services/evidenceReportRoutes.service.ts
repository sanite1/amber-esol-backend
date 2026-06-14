/**
 * Route-layer helpers for the evidence-report endpoints — brief
 * Function 14 To-Do 4.
 *
 * Three flows backed (org-admin + Amber-admin share the same service;
 * the admin route layer passes `org_id` from the body, the org-admin
 * layer pulls it from req.esol_context):
 *
 *   POST  /api/org-admin/evidence-report               triggerEvidenceReportService
 *   GET   /api/org-admin/evidence-report/:jobId/status getEvidenceReportStatusService
 *   GET   /api/org-admin/evidence-report/:reportId/download
 *
 * Trigger flow:
 *   1. Validate input shape (org id, YYYY-MM-DD dates).
 *   2. period_start < period_end, both within the last 12 months.
 *   3. Compute the sha256 idempotency key — same algorithm the worker
 *      uses, so a re-trigger collapses onto the same cache row.
 *   4. Check IdempotencyKey for `operation: "rarpa-evidence"`, status
 *      `completed`. If found, return the cached download URL inline.
 *   5. Otherwise enqueue an `rarpa-evidence` job with the deterministic
 *      `reportId` so the worker writes the PDF to a predictable path.
 *
 * The 12-month bound is a soft policy guard, not a hard data limit:
 * RARPA evidence is meaningless for periods so old that the contract
 * year has closed. Catches mistyped years (2014 instead of 2024) before
 * they burn compute.
 */

import { Types } from "mongoose";
import { Job } from "bullmq";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Organisation from "../models/Organisation";
import IdempotencyKey from "../models/IdempotencyKey";
import IdempotencyService from "./idempotency.service";
import { rarpaEvidenceQueue } from "../queues";
import { computeEvidenceReportIdempotencyKey } from "./evidenceReport.service";
import logger from "../config/logger";

/**
 * Shape of the cached result envelope persisted by the worker. The
 * download URL is included so cache hits don't have to reconstruct
 * the path from naming convention.
 */
interface CachedEvidenceResult {
  report_id: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  learner_count: number;
  pdf_bytes: number;
  download_url: string;
}

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// POST /api/org-admin/evidence-report — trigger
// ─────────────────────────────────────────────────────────────────────

export interface TriggerEvidenceReportInput {
  org_id: string;
  caller_id: string;
  period_start: string;
  period_end: string;
  /** `?force_refresh=true` query param. Bypasses the cache check. */
  force_refresh: boolean;
}

export const triggerEvidenceReportService = async (
  input: TriggerEvidenceReportInput,
): Promise<ApiResponse> => {
  // ── 1. Shape validation ────────────────────────────────────────────
  if (!input.org_id || !Types.ObjectId.isValid(input.org_id)) {
    throw new ApiError(400, "Organisation context is required");
  }
  if (!input.caller_id || !Types.ObjectId.isValid(input.caller_id)) {
    throw new ApiError(400, "Authenticated caller id required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_start)) {
    throw new ApiError(400, "period_start must be YYYY-MM-DD");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_end)) {
    throw new ApiError(400, "period_end must be YYYY-MM-DD");
  }

  const start = new Date(`${input.period_start}T00:00:00.000Z`);
  const end = new Date(`${input.period_end}T23:59:59.999Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ApiError(400, "period_start / period_end must be real dates");
  }
  if (start >= end) {
    throw new ApiError(400, "period_start must be strictly before period_end");
  }

  // 12-month window check: both endpoints must fall within the last
  // year. Future-dated periods are also refused — RARPA evidence for a
  // period that hasn't ended yet is meaningless.
  const now = Date.now();
  const twelveMonthsAgo = now - TWELVE_MONTHS_MS;
  if (start.getTime() < twelveMonthsAgo || end.getTime() < twelveMonthsAgo) {
    throw new ApiError(
      400,
      "Evidence reports are limited to the most recent 12 months. Older periods are out of scope.",
    );
  }
  if (start.getTime() > now || end.getTime() > now) {
    throw new ApiError(400, "Reporting period cannot extend into the future");
  }

  // ── 2. Org existence check ─────────────────────────────────────────
  // Unlike ILR, demo orgs ARE allowed to generate evidence reports —
  // these never leave the platform and showing a demo report is a key
  // sales tool. (The watermark + privacy section make the demo
  // provenance obvious.)
  const org = await Organisation.findById(input.org_id).select("name").lean();
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  // ── 3. Idempotency key ─────────────────────────────────────────────
  const reportId = computeEvidenceReportIdempotencyKey({
    org_id: input.org_id,
    period_start: input.period_start,
    period_end: input.period_end,
  });

  // ── 4. Cache check (unless force_refresh) — brief Function 14 To-Do 5
  //
  // IdempotencyService.lookup is read-only: hit = completed row exists.
  // Failed and in-flight rows are reported as misses so the caller can
  // re-enqueue (the worker's `updateOne` resets a failed row back to
  // "processing" on the next attempt, see processRarpaEvidence).
  if (!input.force_refresh) {
    const cached = await IdempotencyService.lookup<CachedEvidenceResult>(
      reportId,
      "rarpa-evidence",
    );
    if (cached.hit && cached.result) {
      logger.info(
        { reportId, orgId: input.org_id, cachedAt: cached.meta?.created_at },
        "triggerEvidenceReport: returning cached completed report",
      );
      return new ApiResponse(
        200,
        "Evidence report already available (cached)",
        {
          report_id: reportId,
          cached: true,
          status: "completed",
          // The cached envelope stores the canonical download URL —
          // preferring that over a recomputed string protects against
          // route drift between worker and route layer.
          download_url:
            cached.result.download_url ??
            `/api/org-admin/evidence-report/${reportId}/download`,
          generated_at: cached.result.generated_at,
          learner_count: cached.result.learner_count,
        },
      );
    }
  }

  // ── 5. Enqueue rarpa-evidence job ──────────────────────────────────
  // Deterministic BullMQ jobId per (reportId, force flag) — a double-
  // click without force_refresh hits the same job.
  const bullJobId = input.force_refresh
    ? `evidence:${reportId}:force-${Date.now()}`
    : `evidence:${reportId}`;
  const job = await rarpaEvidenceQueue.add(
    "evidence-report",
    {
      kind: "evidence_report",
      orgId: input.org_id,
      periodStart: input.period_start,
      periodEnd: input.period_end,
      requestedBy: input.caller_id,
      reportId,
    },
    { jobId: bullJobId },
  );

  logger.info(
    {
      reportId,
      jobId: job.id,
      orgId: input.org_id,
      force_refresh: input.force_refresh,
    },
    "triggerEvidenceReport: enqueued",
  );

  return new ApiResponse(202, "Evidence report enqueued", {
    report_id: reportId,
    job_id: String(job.id),
    status_url: `/api/org-admin/evidence-report/${job.id}/status`,
    download_url: `/api/org-admin/evidence-report/${reportId}/download`,
  });
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/evidence-report/:jobId/status
// ─────────────────────────────────────────────────────────────────────

export type EvidenceJobStatus = "waiting" | "active" | "completed" | "failed";

export interface EvidenceJobStatusResult {
  job_id: string;
  status: EvidenceJobStatus;
  progress: number;
  report_id?: string;
  download_url?: string;
  failed_reason?: string;
}

const mapBullStateToStatus = (state: string): EvidenceJobStatus => {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "active":
      return "active";
    default:
      return "waiting"; // delayed | waiting | waiting-children | prioritized
  }
};

/**
 * Status lookup. When `callerOrgId` is null, the caller is an Amber
 * admin and the org-scope check is skipped — admins observe any job.
 */
export const getEvidenceReportStatusService = async (
  jobId: string,
  callerOrgId: string | null,
): Promise<ApiResponse> => {
  if (!jobId) {
    throw new ApiError(400, "jobId is required");
  }
  if (callerOrgId !== null && !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(400, "Organisation context is required");
  }

  const job = (await rarpaEvidenceQueue.getJob(jobId)) as Job | undefined;
  if (!job) {
    throw new ApiError(404, "Evidence report job not found");
  }

  // Only evidence-report jobs are surfaced here — a stage-compile
  // job that happens to share the queue must not be observable via
  // this endpoint.
  if ((job.data as { kind?: string }).kind !== "evidence_report") {
    throw new ApiError(404, "Evidence report job not found");
  }

  // Cross-org scope check (org-admin callers only). Admins skip.
  if (
    callerOrgId !== null &&
    (job.data as { orgId?: string }).orgId !== callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this evidence report job");
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

  const result: EvidenceJobStatusResult = {
    job_id: String(job.id),
    status,
    progress,
  };

  if (status === "completed" && job.returnvalue) {
    const rv = job.returnvalue as {
      report_id?: string;
      download_url?: string;
    };
    result.report_id = rv.report_id;
    result.download_url = rv.download_url;
  }
  if (status === "failed") {
    result.failed_reason = job.failedReason ?? "Unknown error";
  }

  return new ApiResponse(200, "Evidence report status", result);
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/evidence-report/:reportId/download — ACL helper
// ─────────────────────────────────────────────────────────────────────

export interface AuthorisedEvidenceReport {
  report_id: string;
  org_id: string;
  org_name: string;
  period_start: string;
  period_end: string;
}

/**
 * Returns the metadata the controller needs to build the filename and
 * stream the PDF. When `callerOrgId` is null the caller is an Amber
 * admin (no org-scope check); otherwise the lock's org_id must match.
 */
export const authoriseEvidenceReportDownloadService = async (
  reportId: string,
  callerOrgId: string | null,
): Promise<AuthorisedEvidenceReport> => {
  if (!reportId) throw new ApiError(400, "reportId is required");
  if (callerOrgId !== null && !Types.ObjectId.isValid(callerOrgId)) {
    throw new ApiError(400, "Organisation context is required");
  }

  const lock = await IdempotencyKey.findOne({
    key: reportId,
    operation: "rarpa-evidence",
  }).lean();
  if (!lock) {
    throw new ApiError(404, "Evidence report not found");
  }
  if (lock.status !== "completed") {
    throw new ApiError(
      409,
      `Evidence report is not yet available (status: ${lock.status})`,
    );
  }
  if (callerOrgId !== null && lock.org_id?.toString() !== callerOrgId) {
    throw new ApiError(403, "Access denied to this evidence report");
  }

  const result = lock.result as {
    period_start?: string;
    period_end?: string;
  } | null;
  if (!result) {
    throw new ApiError(
      500,
      "Evidence report metadata missing — re-run with force_refresh=true",
    );
  }

  const ownerOrgId = lock.org_id?.toString() ?? "";
  const org = ownerOrgId
    ? await Organisation.findById(ownerOrgId).select("name").lean()
    : null;

  return {
    report_id: reportId,
    org_id: ownerOrgId,
    org_name: org?.name ?? "organisation",
    period_start: result.period_start ?? "",
    period_end: result.period_end ?? "",
  };
};

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/admin/evidence-report/cache/:org_id — brief Function 14 To-Do 5
// ─────────────────────────────────────────────────────────────────────

export interface ClearEvidenceCacheResult {
  org_id: string;
  cleared_count: number;
  removed_files: number;
  failed_files: string[];
}

/**
 * Cache-clear for the given org. Removes every `rarpa-evidence`
 * IdempotencyKey row for the org AND best-effort unlinks the
 * corresponding `<key>.pdf` on disk so the next trigger regenerates
 * from scratch.
 *
 * Implementation note: we delete rows in any status (processing /
 * completed / failed) so that a stuck "processing" row isn't left
 * blocking a re-trigger after the org's data has been corrected.
 *
 * Returns:
 *   - cleared_count   number of IdempotencyKey rows removed
 *   - removed_files   number of PDFs unlinked from disk
 *   - failed_files    paths the unlink failed on (so the caller can
 *                     investigate; not treated as a hard error since
 *                     a missing file is the desired end state anyway)
 */
export const clearEvidenceReportCacheService = async (
  orgId: string,
): Promise<ClearEvidenceCacheResult> => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }

  // Importing here (inside the function) keeps the top-of-file imports
  // free of fs/path concerns — they belong to the cache-clear flow,
  // not the trigger / status / download flows.
  const { unlink } = await import("fs/promises");
  const { resolve } = await import("path");
  const { EVIDENCE_REPORT_DIR } = await import("./evidenceReport.service");

  const rows = await IdempotencyKey.find({
    operation: "rarpa-evidence",
    org_id: new Types.ObjectId(orgId),
  })
    .select("key")
    .lean();

  let removed_files = 0;
  const failed_files: string[] = [];
  for (const row of rows) {
    const path = resolve(EVIDENCE_REPORT_DIR, `${row.key}.pdf`);
    try {
      await unlink(path);
      removed_files += 1;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // File already gone — the desired end state. Don't log as a
        // failure; this is the normal path for half-completed runs.
        continue;
      }
      failed_files.push(path);
      logger.warn(
        { err: (err as Error).message, path },
        "clearEvidenceReportCache: unlink failed",
      );
    }
  }

  const del = await IdempotencyKey.deleteMany({
    operation: "rarpa-evidence",
    org_id: new Types.ObjectId(orgId),
  });

  logger.info(
    {
      orgId,
      cleared_count: del.deletedCount,
      removed_files,
      failed_count: failed_files.length,
    },
    "clearEvidenceReportCache: complete",
  );

  return {
    org_id: orgId,
    cleared_count: del.deletedCount,
    removed_files,
    failed_files,
  };
};
