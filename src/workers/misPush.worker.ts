import { createBaseWorker } from "./createBaseWorker";
import { processMisPush } from "../services/queueProcessors";
import type { MisPushJob } from "../queues";

/**
 * Worker for the `mis-push` queue (standard priority).
 *
 * Concurrency 1: most MIS vendors rate-limit hard and some lock the
 * destination during write. Sequential is safer.
 */
export const createMisPushWorker = () =>
  createBaseWorker<MisPushJob>({
    queueName: "mis-push",
    processor: processMisPush,
    concurrency: 1,
  });
