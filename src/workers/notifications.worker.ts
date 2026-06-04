import { createBaseWorker } from "./createBaseWorker";
import { processNotifications } from "../services/queueProcessors";
import type { NotificationsQueuePayload } from "../queues";

/**
 * Worker for the `notifications` queue (high priority).
 *
 * Job types dispatched here (see processNotifications):
 *   - "safeguarding-alert" → DSL email via privateemail.com SMTP
 *                            (brief Function 10; p95 dispatch < 5s SLA)
 *   - "admin_job_failure"  → enqueued by createBaseWorker on terminal
 *                            failures of other queues
 *   - other notification types as they land
 *
 * Concurrency = 5 is deliberate: the SMTP server is the bottleneck for
 * email-bearing jobs, and 5 parallel sends keeps us well under
 * privateemail's connection-per-account limits. Raising this would need
 * SMTP pooling on the transporter side first.
 *
 * `enqueueAdminNotificationOnFailure: false` is critical — if the
 * notifications worker re-enqueued admin failure notifications on its own
 * failures, a Redis/Nodemailer outage would create an infinite fan-out.
 * Terminal failures of notification jobs still write to failed_jobs so
 * they're recoverable; they just don't try to send another notification.
 */
export const createNotificationsWorker = () =>
  createBaseWorker<NotificationsQueuePayload>({
    queueName: "notifications",
    processor: processNotifications,
    concurrency: 5,
    enqueueAdminNotificationOnFailure: false,
  });
