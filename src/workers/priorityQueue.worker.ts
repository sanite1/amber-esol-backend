import { createBaseWorker } from "./createBaseWorker";
import { processPriorityQueue } from "../services/queueProcessors";
import type { PriorityQueueJob } from "../queues";

/** Worker for the `priority-queue` queue (low priority — nightly scoring run). */
export const createPriorityQueueWorker = () =>
  createBaseWorker<PriorityQueueJob>({
    queueName: "priority-queue",
    processor: processPriorityQueue,
    concurrency: 3,
  });
