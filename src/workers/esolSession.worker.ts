import { createBaseWorker } from "./createBaseWorker";
import { processEsolSession } from "../services/queueProcessors";
import type { EsolSessionJob } from "../queues";

/**
 * Worker for the `esol-session` queue.
 *
 * Handles per-turn AI inference, post-session evidence capture, and vocab
 * ledger updates. High priority — the learner is waiting.
 *
 * Concurrency 10: AI calls are I/O-bound and we want to keep multiple
 * sessions moving in parallel. Vertex AI quota is the upper limit.
 */
export const createEsolSessionWorker = () =>
  createBaseWorker<EsolSessionJob>({
    queueName: "esol-session",
    processor: processEsolSession,
    concurrency: 10,
  });
