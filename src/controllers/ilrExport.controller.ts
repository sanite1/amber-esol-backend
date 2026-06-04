/**
 * ILR export controllers — brief Function 13 To-Do 4.
 *
 * Three endpoints:
 *   POST  /api/org-admin/export/ilr                  triggerIlrExport
 *   GET   /api/org-admin/export/ilr/:jobId/status    getIlrExportStatus
 *   GET   /api/org-admin/export/ilr/:exportId/download   downloadIlrExport
 *
 * Trigger + status are JSON; download streams bytes from disk with a
 * filesystem-safe filename. The download controller is the one place
 * in this stack that does direct file IO — it reads from
 * `${EXPORT_DIR}/<exportId>.{csv,json}` produced by the worker.
 */

import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { resolve } from "path";
import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import {
  triggerIlrExportService,
  getIlrExportStatusService,
  authoriseDownloadService,
} from "../services/ilrExportRoutes.service";
import { EXPORT_DIR } from "../services/ilrCsvWriter.service";

// ─────────────────────────────────────────────────────────────────────
// POST /api/org-admin/export/ilr
// ─────────────────────────────────────────────────────────────────────

export const triggerIlrExport: ExpressFunction = async (req, res, next) => {
  try {
    const orgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ?? (req.user?.orgId as string) ?? "";
    const callerId = req.user!.id.toString();
    const body = (req.body ?? {}) as {
      academic_year?: string;
      period_start?: string;
      period_end?: string;
    };
    // `?force_refresh=true` bypasses the cache check; "true" as
    // string per usual query-param convention.
    const forceRefresh =
      (req.query as Record<string, unknown>).force_refresh === "true";

    const result = await triggerIlrExportService({
      org_id: orgId,
      caller_id: callerId,
      academic_year: body.academic_year ?? "",
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
// GET /api/org-admin/export/ilr/:jobId/status
// ─────────────────────────────────────────────────────────────────────

export const getIlrExportStatus: ExpressFunction = async (req, res, next) => {
  try {
    const orgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ?? (req.user?.orgId as string) ?? "";
    const { jobId } = req.params as { jobId: string };
    const result = await getIlrExportStatusService(jobId, orgId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/export/ilr/:exportId/download
// ─────────────────────────────────────────────────────────────────────

/**
 * Sanitise the org name for the Content-Disposition header.
 * Allows letters, digits, hyphen, underscore — anything else
 * collapses to underscore. Prevents path-traversal or CR/LF in
 * the header (HTTP-injection class of bugs).
 */
const safeOrgNameForFilename = (raw: string): string =>
  raw.replace(/[^A-Za-z0-9\-_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

export const downloadIlrExport: ExpressFunction = async (req, res, next) => {
  try {
    const orgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ?? (req.user?.orgId as string) ?? "";
    const { exportId } = req.params as { exportId: string };
    const format = (req.query as Record<string, unknown>).format;
    const wantJson = format === "json";

    const auth = await authoriseDownloadService(exportId, orgId);

    // Filename per the brief:
    //   ILR_<orgName>_<academicYear>_<periodStart>_to_<periodEnd>.csv
    // Slashes in the academic year ("2025/26") are stripped — they're
    // valid in attachment filenames per RFC 6266 but break in Windows.
    const ay = auth.academic_year.replace("/", "-");
    const baseName =
      `ILR_${safeOrgNameForFilename(auth.org_name)}_${ay}_${auth.period_start}_to_${auth.period_end}`;
    const filename = wantJson ? `${baseName}.json` : `${baseName}.csv`;

    const filePath = resolve(EXPORT_DIR, `${exportId}.${wantJson ? "json" : "csv"}`);
    // Stat first — if the file is missing the export was never
    // persisted (worker crashed mid-flight, or the disk was cleaned).
    // Surface a clear error rather than a silent stream-not-found.
    try {
      await stat(filePath);
    } catch {
      throw new ApiError(
        404,
        "Export artefact missing on disk — re-run the export with ?force_refresh=true",
      );
    }

    res.setHeader(
      "Content-Type",
      wantJson ? "application/json" : "text/csv; charset=utf-8",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    // Stream the file rather than buffering — keeps the controller
    // O(1) memory regardless of cohort size.
    const stream = createReadStream(filePath);
    stream.on("error", (err) => next(err));
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
};
