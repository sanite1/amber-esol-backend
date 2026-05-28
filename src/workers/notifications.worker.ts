import { createBaseWorker } from "./createBaseWorker";
import { processNotifications } from "../services/queueProcessors";
import type { NotificationJob } from "../queues";

/**
 * Worker for the `notifications` queue (high priority).
 *
 * `enqueueAdminNotificationOnFailure: false` is critical — if the
 * notifications worker re-enqueued admin failure notifications on its own
 * failures, a Redis/Nodemailer outage would create an infinite fan-out.
 * Terminal failures of notification jobs still write to failed_jobs so
 * they're recoverable; they just don't try to send another notification.
 */
export const createNotificationsWorker = () =>
  createBaseWorker<NotificationJob>({
    queueName: "notifications",
    processor: processNotifications,
    concurrency: 5,
    enqueueAdminNotificationOnFailure: false,
  });
