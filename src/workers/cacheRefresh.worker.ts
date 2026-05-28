import { createBaseWorker } from "./createBaseWorker";
import { processCacheRefresh } from "../services/queueProcessors";
import type { CacheRefreshJob } from "../queues";

/**
 * Worker for the `cache-refresh` queue.
 *
 * Concurrency 1: postcode load and FALA refresh are bulk Redis writes —
 * running two in parallel would compete for Redis bandwidth without speedup.
 *
 * Long lockDuration: the postcode load can stream millions of rows.
 * LARGE_DATASET_TIMEOUT env var controls the per-job timeout window;
 * default 600000 ms (10 minutes). BullMQ Worker `lockDuration` keeps the
 * job claimed against other workers for that long.
 */
export const createCacheRefreshWorker = () => {
  const timeoutMs = Number(process.env.LARGE_DATASET_TIMEOUT) || 600_000;
  return createBaseWorker<CacheRefreshJob>({
    queueName: "cache-refresh",
    processor: processCacheRefresh,
    concurrency: 1,
    lockDurationMs: timeoutMs,
  });
};
