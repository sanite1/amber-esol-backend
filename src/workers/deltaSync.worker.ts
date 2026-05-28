import { createBaseWorker } from "./createBaseWorker";
import { processDeltaSync } from "../services/queueProcessors";
import type { DeltaSyncJob } from "../queues";

/** Worker for the `delta-sync` queue (low priority — daily MIS reconciliation). */
export const createDeltaSyncWorker = () =>
  createBaseWorker<DeltaSyncJob>({
    queueName: "delta-sync",
    processor: processDeltaSync,
    concurrency: 1,
  });
