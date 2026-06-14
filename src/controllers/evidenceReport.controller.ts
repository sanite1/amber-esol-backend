/**
 * Evidence-report controllers — brief Function 14 To-Do 4.
 *
 * Six endpoints (three for org-admin, three for Amber admin):
 *
 *   org-admin:
 *     POST  /api/org-admin/evidence-report                 triggerEvidenceReportOrgAdmin
 *     GET   /api/org-admin/evidence-report/:jobId/status   getEvidenceReportStatusOrgAdmin
 *     GET   /api/org-admin/evidence-report/:reportId/download  downloadEvidenceReportOrgAdmin
 *
 *   admin (Amber):
 *     POST  /api/admin/evidence-report                     triggerEvidenceReportAdmin
 *     GET   /api/admin/evidence-report/:jobId/status       getEvidenceReportStatusAdmin
 *     GET   /api/admin/evidence-report/:reportId/download  downloadEvidenceReportAdmin
 *
 * The admin variants skip the requireOrgContext scope check; org_id
 * lives in the body for the trigger, and is implicit on status/download
 * because the lock's stored org_id is the authority.
 *
 * Download is the one controller that does direct file IO — it streams
 * the cached PDF from `${EVIDENCE_REPORT_DIR}/<reportId>.pdf`.
 */

import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { Types } from "mongoose";
import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import {
  triggerEvidenceReportService,
  getEvidenceReportStatusService,
  authoriseEvidenceReportDownloadService,
  clearEvidenceReportCacheService,
} from "../services/evidenceReportRoutes.service";
import { EVIDENCE_REPORT_DIR } from "../services/evidenceReport.service";
import AuditLog from "../models/AuditLog";
import Organisation from "../models/Organisation";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const callerOrgIdFromRequest = (req: Parameters<ExpressFunction>[0]): string =>
  (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
    ?.org_id ??
  (req.user?.orgId as string | undefined) ??
  "";

const callerIdFromRequest = (req: Parameters<ExpressFunction>[0]): string =>
  req.user?.id?.toString() ?? "";

/**
 * Sanitise the org name for the Content-Disposition header — same
 * rule as the ILR download controller.
 */
const safeOrgNameForFilename = (raw: string): string =>
  raw
    .replace(/[^A-Za-z0-9\-_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

// ─────────────────────────────────────────────────────────────────────
// POST /api/org-admin/evidence-report
// ─────────────────────────────────────────────────────────────────────

export const triggerEvidenceReportOrgAdmin: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const orgId = callerOrgIdFromRequest(req);
    const callerId = callerIdFromRequest(req);
    const body = (req.body ?? {}) as {
      period_start?: string;
      period_end?: string;
    };
    const forceRefresh =
      (req.query as Record<string, unknown>).force_refresh === "true";

    const result = await triggerEvidenceReportService({
      org_id: orgId,
      caller_id: callerId,
      period_start: body.period_start ?? "",
      period_end: body.period_end ?? "",
      force_refresh: forceRefresh,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/evidence-report  (Amber admin)
// ─────────────────────────────────────────────────────────────────────

export const triggerEvidenceReportAdmin: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const callerId = callerIdFromRequest(req);
    const body = (req.body ?? {}) as {
      org_id?: string;
      period_start?: string;
      period_end?: string;
    };
    const forceRefresh =
      (req.query as Record<string, unknown>).force_refresh === "true";

    const result = await triggerEvidenceReportService({
      org_id: body.org_id ?? "",
      caller_id: callerId,
      period_start: body.period_start ?? "",
      period_end: body.period_end ?? "",
      force_refresh: forceRefresh,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// GET .../:jobId/status
// ─────────────────────────────────────────────────────────────────────

export const getEvidenceReportStatusOrgAdmin: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const orgId = callerOrgIdFromRequest(req);
    const { jobId } = req.params as { jobId: string };
    const result = await getEvidenceReportStatusService(jobId, orgId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const getEvidenceReportStatusAdmin: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const { jobId } = req.params as { jobId: string };
    // Pass null → no org-scope check; admins can observe any job.
    const result = await getEvidenceReportStatusService(jobId, null);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// GET .../:reportId/download — streams the PDF
// ─────────────────────────────────────────────────────────────────────

const streamEvidenceReportPdf = async (
  req: Parameters<ExpressFunction>[0],
  res: Parameters<ExpressFunction>[1],
  next: Parameters<ExpressFunction>[2],
  callerOrgId: string | null,
) => {
  try {
    const { reportId } = req.params as { reportId: string };
    const auth = await authoriseEvidenceReportDownloadService(
      reportId,
      callerOrgId,
    );

    // Filename: RARPA_<orgName>_<periodStart>_to_<periodEnd>.pdf
    const baseName = `RARPA_${safeOrgNameForFilename(auth.org_name)}_${auth.period_start}_to_${auth.period_end}`;
    const filename = `${baseName}.pdf`;

    const filePath = resolve(EVIDENCE_REPORT_DIR, `${reportId}.pdf`);
    try {
      await stat(filePath);
    } catch {
      throw new ApiError(
        404,
        "Evidence report PDF missing on disk — re-run with ?force_refresh=true",
      );
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    const stream = createReadStream(filePath);
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
};

export const downloadEvidenceReportOrgAdmin: ExpressFunction = (
  req,
  res,
  next,
) => streamEvidenceReportPdf(req, res, next, callerOrgIdFromRequest(req));

export const downloadEvidenceReportAdmin: ExpressFunction = (req, res, next) =>
  // null = no org-scope filter; admins can download any org's report.
  streamEvidenceReportPdf(req, res, next, null);

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/admin/evidence-report/cache/:org_id — Function 14 To-Do 5
// ─────────────────────────────────────────────────────────────────────

/**
 * Amber-admin only. Clears every cached `rarpa-evidence` row for the
 * target org and unlinks the corresponding PDFs on disk.
 *
 * Use case from the brief: "useful if data was corrected and
 * regeneration needed". A learner record was fixed retroactively;
 * the cached PDFs for the org are now stale and have to be invalidated
 * so the next trigger regenerates from the corrected data.
 *
 * Writes an AuditLog row (`evidence_report_cache_cleared`) capturing
 * the actor, the org, and how many rows / files were affected — so
 * we can prove a cache flush happened if the corrected report later
 * comes into question.
 */
export const clearEvidenceReportCacheAdmin: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const { org_id } = req.params as { org_id: string };
    const callerId = callerIdFromRequest(req);

    // Sanity-check the org exists before doing the destructive work.
    // Returning 404 here avoids a silent "we cleared nothing" success
    // that masks a typo in the URL.
    if (!Types.ObjectId.isValid(org_id)) {
      throw new ApiError(400, "org_id must be a valid ObjectId");
    }
    const org = await Organisation.findById(org_id).select("name").lean();
    if (!org) throw new ApiError(404, "Organisation not found");

    const result = await clearEvidenceReportCacheService(org_id);

    // Audit log — append-only. Best-effort: the clear succeeded
    // already; a log write failure here doesn't undo the cache
    // invalidation, but it does need a loud error so we can
    // back-fill the entry manually if needed.
    await AuditLog.create({
      timestamp: new Date(),
      actor_type: "amber_admin",
      actor_id: Types.ObjectId.isValid(callerId)
        ? new Types.ObjectId(callerId)
        : null,
      org_id: new Types.ObjectId(org_id),
      learner_id: null,
      action: "evidence_report_cache_cleared",
      before_state: null,
      after_state: {
        cleared_count: result.cleared_count,
        removed_files: result.removed_files,
        failed_files_count: result.failed_files.length,
      },
      reason: `Amber admin cleared the evidence-report cache for ${org.name}; ${result.cleared_count} cached row(s) and ${result.removed_files} PDF file(s) removed.`,
      compliance_config_version: null,
    }).catch((err) =>
      logger.error(
        { err: (err as Error).message, org_id },
        "clearEvidenceReportCacheAdmin: AuditLog write failed (cache still cleared)",
      ),
    );

    return res.status(200).json({
      message: "Evidence-report cache cleared",
      data: result,
    });
  } catch (err) {
    next(err);
  }
};
