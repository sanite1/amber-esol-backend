import { Job } from "bullmq";
import logger from "../../config/logger";
import PostcodeRouter from "../postcodeRouter.service";
import FALACache from "../falaCache.service";
import type {
  EsolSessionJob,
  RarpaEvidenceJob,
  IlrExportJob,
  ComplianceValidationJob,
  MisPushJob,
  PriorityQueueJob,
  DeltaSyncJob,
  NotificationJob,
  CacheRefreshJob,
} from "../../queues";

/**
 * Queue job processors — one per queue.
 *
 * Each processor is a stub that logs the inbound payload and returns. Real
 * implementations land per-feature in subsequent tasks:
 *
 *   esolSession        → Phase 9 (AI tutor session)
 *   rarpaEvidence      → Phase 11 (RARPA stages 2–5 compilation)
 *   ilrExport          → Phase 12 (ILR CSV + warnings)
 *   complianceValidation → Phase 13 (green-light validator)
 *   misPush            → Phase 14 (ProSolution/Maytas/EBS push)
 *   priorityQueue      → Phase 15 (teacher prep scoring)
 *   deltaSync          → Phase 15 (MIS delta cron)
 *   notifications      → Phase 10 (safeguarding + email plumbing)
 *
 * When you implement the real version, replace the function body. The worker
 * signature stays identical so no other file has to change.
 */

const stub = async <T>(name: string, job: Job<T>): Promise<{ stubbed: true }> => {
  logger.info(
    { processor: name, jobId: job.id, jobName: job.name, data: job.data },
    "[stub] processor invoked — no real work performed"
  );
  return { stubbed: true };
};

export const processEsolSession = (job: Job<EsolSessionJob>) =>
  stub("processEsolSession", job);

export const processRarpaEvidence = (job: Job<RarpaEvidenceJob>) =>
  stub("processRarpaEvidence", job);

export const processIlrExport = (job: Job<IlrExportJob>) =>
  stub("processIlrExport", job);

export const processComplianceValidation = (job: Job<ComplianceValidationJob>) =>
  stub("processComplianceValidation", job);

export const processMisPush = (job: Job<MisPushJob>) =>
  stub("processMisPush", job);

export const processPriorityQueue = (job: Job<PriorityQueueJob>) =>
  stub("processPriorityQueue", job);

export const processDeltaSync = (job: Job<DeltaSyncJob>) =>
  stub("processDeltaSync", job);

export const processNotifications = (job: Job<NotificationJob>) =>
  stub("processNotifications", job);

/**
 * Real implementation (not a stub). Branches on job.name to either load
 * the postcode dataset into Redis or refresh the FALA whitelist.
 */
export const processCacheRefresh = async (
  job: Job<CacheRefreshJob>
): Promise<{ task: string; result: unknown }> => {
  const { task, academicYear } = job.data;
  logger.info(
    { task, academicYear, jobId: job.id },
    "cache-refresh job started"
  );

  if (task === "postcode-load") {
    const result = await PostcodeRouter.loadDatasetFromSource(academicYear);
    return { task, result };
  }
  if (task === "fala-refresh") {
    const result = await FALACache.reload(academicYear);
    return { task, result };
  }

  throw new Error(`Unknown cache-refresh task: ${task}`);
};
