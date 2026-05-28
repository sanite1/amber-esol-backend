import { createBaseWorker } from "./createBaseWorker";
import { processIlrExport } from "../services/queueProcessors";
import type { IlrExportJob } from "../queues";

/**
 * Worker for the `ilr-export` queue (standard priority).
 *
 * ILR exports can be memory-heavy (large cohorts × many fields). Keep
 * concurrency low so a single worker process doesn't OOM during a multi-org
 * monthly run.
 */
export const createIlrExportWorker = () =>
  createBaseWorker<IlrExportJob>({
    queueName: "ilr-export",
    processor: processIlrExport,
    concurrency: 2,
  });
