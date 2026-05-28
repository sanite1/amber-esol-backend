import { Worker, Job, Processor, WorkerOptions } from "bullmq";
import { createBullmqConnection } from "../lib/redis";
import { notificationsQueue, QueueName } from "../queues";
import FailedJob from "../models/FailedJob";
import logger from "../config/logger";

/**
 * Shared factory for BullMQ workers in Project Silk.
 *
 * Every worker created via this factory:
 *  1. Uses the singleton ioredis connection.
 *  2. Applies the standard retry policy — 3 attempts at 5s/30s/120s
 *     (controlled by the custom backoffStrategy registered on the worker).
 *  3. On TERMINAL failure (after all retries exhausted), writes a row to
 *     the `failed_jobs` MongoDB collection.
 *  4. On TERMINAL failure, enqueues an `admin_job_failure` notification on
 *     the notifications queue — unless the failing queue IS the notifications
 *     queue (which would cause an infinite loop).
 *  5. Logs every attempt to pino so on-call has live visibility.
 *
 * Concurrency defaults to 5 — tune per worker if needed via the option.
 */

const BACKOFF_DELAYS_MS = [5_000, 30_000, 120_000] as const;

export interface CreateWorkerOptions<T> {
  queueName: QueueName;
  processor: Processor<T>;
  concurrency?: number;
  /**
   * Override the inferred "do not self-notify" guard. Defaults to true ONLY
   * when queueName === "notifications". You almost never want to change this.
   */
  enqueueAdminNotificationOnFailure?: boolean;
  /**
   * BullMQ lock duration in ms. Default 30 seconds. Bump for long-running
   * processors (e.g. cache-refresh dataset load at 10 minutes) so the lock
   * doesn't expire mid-job and trigger an unnecessary retry.
   */
  lockDurationMs?: number;
}

export const createBaseWorker = <T = unknown>({
  queueName,
  processor,
  concurrency = 5,
  enqueueAdminNotificationOnFailure,
  lockDurationMs,
}: CreateWorkerOptions<T>): Worker<T> => {
  const shouldNotify =
    enqueueAdminNotificationOnFailure ?? queueName !== "notifications";

  // Each Worker gets its own ioredis connection per BullMQ's official
  // recommendation. Sharing a connection across workers causes "client[name]
  // is not a function" errors and MaxListenersExceeded warnings.
  const workerOptions: WorkerOptions = {
    connection: createBullmqConnection() as unknown as WorkerOptions["connection"],
    concurrency,
    ...(lockDurationMs ? { lockDuration: lockDurationMs } : {}),
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        BACKOFF_DELAYS_MS[Math.min(attemptsMade - 1, BACKOFF_DELAYS_MS.length - 1)],
    },
  };

  const worker = new Worker<T>(queueName, processor, workerOptions);

  worker.on("active", (job) => {
    logger.debug(
      { queue: queueName, jobId: job.id, name: job.name, attempt: job.attemptsMade + 1 },
      "Worker started job"
    );
  });

  worker.on("completed", (job) => {
    logger.info(
      { queue: queueName, jobId: job.id, name: job.name },
      "Worker completed job"
    );
  });

  worker.on("failed", async (job, err) => {
    if (!job) {
      // Job-less failure (very rare — usually a Redis disconnect during
      // fetch). Log and bail; nothing else we can persist about it.
      logger.error({ queue: queueName, err: err.message }, "Worker failure with no job context");
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const isTerminal = job.attemptsMade >= maxAttempts;

    logger.warn(
      {
        queue: queueName,
        jobId: job.id,
        name: job.name,
        attempt: job.attemptsMade,
        maxAttempts,
        terminal: isTerminal,
        err: err.message,
      },
      "Worker job failed"
    );

    if (!isTerminal) return; // retry pending — wait for next attempt

    // ── Terminal failure: persist and notify ────────────────────────────
    try {
      await FailedJob.create({
        queue_name: queueName,
        job_id: String(job.id),
        job_data: job.data,
        error: err.message,
        attempts: job.attemptsMade,
        created_at: new Date(),
      });
    } catch (persistErr) {
      logger.error(
        { queue: queueName, jobId: job.id, persistErr: (persistErr as Error).message },
        "Failed to persist failed_job row"
      );
    }

    if (shouldNotify) {
      try {
        await notificationsQueue.add(
          "admin_job_failure",
          {
            channel: "email",
            // Wired in real implementation: lookup of platform-admin user(s).
            // Until then the notifications processor stub logs the intent.
            recipientId: "amber-admin",
            type: "admin_job_failure",
            payload: {
              queue: queueName,
              jobId: job.id,
              jobName: job.name,
              error: err.message,
              attempts: job.attemptsMade,
            },
          },
          { priority: 1 }
        );
      } catch (notifyErr) {
        logger.error(
          { queue: queueName, jobId: job.id, notifyErr: (notifyErr as Error).message },
          "Failed to enqueue admin failure notification"
        );
      }
    }
  });

  worker.on("error", (err) => {
    logger.error({ queue: queueName, err: err.message }, "Worker emitted error");
  });

  logger.info({ queue: queueName, concurrency }, "Worker attached");
  return worker;
};
