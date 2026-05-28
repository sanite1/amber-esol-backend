import { Worker } from "bullmq";
import logger from "../config/logger";
import { createEsolSessionWorker } from "./esolSession.worker";
import { createRarpaEvidenceWorker } from "./rarpaEvidence.worker";
import { createIlrExportWorker } from "./ilrExport.worker";
import { createComplianceValidationWorker } from "./complianceValidation.worker";
import { createMisPushWorker } from "./misPush.worker";
import { createPriorityQueueWorker } from "./priorityQueue.worker";
import { createDeltaSyncWorker } from "./deltaSync.worker";
import { createNotificationsWorker } from "./notifications.worker";
import { createCacheRefreshWorker } from "./cacheRefresh.worker";

/**
 * Start all BullMQ workers.
 *
 * Returns the array of Worker instances so callers can hold references for
 * graceful shutdown (`await Promise.all(workers.map(w => w.close()))` on
 * SIGTERM).
 *
 * Production: invoked by src/workers/run.ts as a standalone Node process.
 * Development: invoked inline by src/index.ts when INLINE_WORKERS !== "false".
 */
export const startWorkers = (): Worker[] => {
  const workers: Worker[] = [
    createEsolSessionWorker(),
    createRarpaEvidenceWorker(),
    createIlrExportWorker(),
    createComplianceValidationWorker(),
    createMisPushWorker(),
    createPriorityQueueWorker(),
    createDeltaSyncWorker(),
    createNotificationsWorker(),
    createCacheRefreshWorker(),
  ];
  logger.info({ count: workers.length }, "All BullMQ workers started");
  return workers;
};

/**
 * Graceful shutdown helper. Call from a SIGTERM handler.
 */
export const stopWorkers = async (workers: Worker[]): Promise<void> => {
  await Promise.all(workers.map((w) => w.close()));
  logger.info("All BullMQ workers stopped");
};
