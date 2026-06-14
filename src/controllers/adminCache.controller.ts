import { Request, Response, NextFunction } from "express";
import { cacheRefreshQueue } from "../queues";
import { respondWithAcceptedJob } from "../lib/jobResponse";
import ComplianceConfigService from "../services/ComplianceConfigService";

/**
 * POST /api/admin/cache/postcode/reload
 *
 * Enqueues a cache-refresh job to download/parse/load the DfE ASF postcode
 * dataset into Redis. Used:
 *   - Manually by Joey every August when the new postcode file ships
 *   - Auto-enqueued at startup if the dataset_loaded marker is stale
 *
 * Returns 202 + jobId. Poll /api/jobs/cache-refresh/<jobId>/status.
 */
export const reloadPostcodeDataset = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const academicYear =
      (req.body?.academicYear as string) ||
      ComplianceConfigService.currentAcademicYear();
    const source = req.body?.source as string | undefined;

    const job = await cacheRefreshQueue.add("postcode-load", {
      task: "postcode-load",
      academicYear,
      source,
    });

    return respondWithAcceptedJob(
      res,
      job,
      "cache-refresh",
      "Postcode reload enqueued",
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/admin/cache/fala/reload
 *
 * Enqueues a cache-refresh job to repopulate the FALA LearnAimRef
 * whitelist for the given (or current) academic year.
 */
export const reloadFalaWhitelist = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const academicYear =
      (req.body?.academicYear as string) ||
      ComplianceConfigService.currentAcademicYear();

    const job = await cacheRefreshQueue.add("fala-refresh", {
      task: "fala-refresh",
      academicYear,
    });

    return respondWithAcceptedJob(
      res,
      job,
      "cache-refresh",
      "FALA reload enqueued",
    );
  } catch (err) {
    next(err);
  }
};
