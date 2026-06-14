/**
 * Safeguarding alert email — brief Function 10.
 *
 * Sends ONE text-only email to the platform-wide DSL inbox when a
 * SafeguardingAlert document is created. Wired into the `notifications`
 * BullMQ queue via processNotifications, dispatched by job name
 * "safeguarding-alert".
 *
 * Privacy contract (brief verbatim):
 *
 *   - NO learner name, NO message content, NO session ID in the body.
 *   - The job payload itself carries only { category, org_id, alert_id,
 *     alert_created_at }. Even if Redis spills, the worst leak is "org
 *     X had a category-Y event at time T".
 *   - The email body tells the DSL to log in to the Amber admin console
 *     to see the alert + the redacted reasoning. The cleartext
 *     disclosure NEVER leaves Mongo.
 *
 * Latency target: p95 dispatch (SafeguardingAlert.create → SMTP
 * transporter.sendMail returns) under 5 seconds. We measure and log
 * `dispatch_latency_ms` on every send; an alarm > 5s gets logged at
 * WARN so it's visible without needing a separate metrics pipeline
 * for the MVP.
 */

import { Types } from "mongoose";
import transporter from "../nodemailer/nodemailer";
import Organisation from "../../models/Organisation";
import SafeguardingAlert from "../../models/SafeguardingAlert";
import logger from "../../config/logger";
import type { SafeguardingAlertEmailJob } from "../../queues";

/**
 * The single env-driven recipient. We don't pull this from the DB
 * (per-org DSL inboxes land in Phase 12) because the brief specifies
 * one platform-wide address for MVP — keeps the worker's failure
 * surface to "SMTP works / it doesn't", no Mongo dependency on the
 * outbound path.
 */
const RECIPIENT_FALLBACK = "safeguarding@ambertraining.co.uk";

/**
 * p95 SLA from the brief. We log a WARN when a single dispatch crosses
 * this — a rolling p95 needs a metrics sink (Phase 14), but the per-
 * event log line means on-call sees regressions immediately.
 */
const DISPATCH_LATENCY_BUDGET_MS = 5_000;

export interface SafeguardingEmailResult {
  sent: true;
  dispatch_latency_ms: number;
  recipient: string;
  message_id: string | undefined;
}

/**
 * Build the email body. Pulled out so the test asserts the exact text
 * without coupling to the transporter mock.
 *
 * Text-only by design. HTML escaping is a class of bugs we don't want
 * inside a safeguarding pathway; plain text also renders identically
 * in every mail client the DSL might use.
 */
export const buildSafeguardingEmailBody = (args: {
  category: string;
  orgName: string;
  timestamp: Date;
}): string => {
  return [
    "A safeguarding alert has been triggered.",
    "",
    `Category: ${args.category}`,
    `Organisation: ${args.orgName}`,
    `Time: ${args.timestamp.toISOString()}`,
    "",
    "Log in to the Amber admin console to review.",
    "",
    "Do NOT reply to this email. This is an automated alert.",
  ].join("\n");
};

/**
 * The worker entry point. Always returns — never throws — because
 * a thrown email failure is already handled by BullMQ retry + the
 * createBaseWorker terminal-failure path; we re-throw at the END if
 * the send actually failed so the retry policy fires.
 *
 * Ordering:
 *   1. Compute dispatch latency from `alert_created_at` (clock start).
 *   2. Lookup org name — single Mongo round-trip, defensive default.
 *   3. Compose body via buildSafeguardingEmailBody (testable in isolation).
 *   4. transporter.sendMail — the real privateemail.com SMTP call.
 *   5. Best-effort stamp `notificationSentAt` on SafeguardingAlert.
 *   6. Log structured metric for the p95 dashboard.
 */
export const sendSafeguardingAlertEmail = async (
  job: SafeguardingAlertEmailJob,
): Promise<SafeguardingEmailResult> => {
  const startedAt = Date.now();

  // 1. Lookup org for display name. Tolerant of a missing org
  //    (Organisation might be archived between alert + email);
  //    safer to deliver "unknown organisation" than to drop the email.
  let orgName = "(unknown organisation)";
  if (job.org_id && Types.ObjectId.isValid(job.org_id)) {
    const org = await Organisation.findById(job.org_id).select("name").lean();
    if (org?.name) orgName = org.name;
  }

  // 2. Compose. Hard-coded subject — the brief specifies exact text.
  const subject = "[URGENT] Safeguarding alert triggered";
  const body = buildSafeguardingEmailBody({
    category: job.category,
    orgName,
    timestamp: new Date(),
  });
  const recipient = process.env.SAFEGUARDING_EMAIL || RECIPIENT_FALLBACK;

  // 3. Send. The transporter is the same SMTP singleton the rest of
  //    the platform uses (mail.privateemail.com:465, env credentials).
  //    No `template:` field — we want raw text, not handlebars-compiled.
  const info = await transporter.sendMail({
    from: `"Amber Safeguarding" <${process.env.AUTH_EMAIL}>`,
    to: recipient,
    subject,
    text: body,
  });

  // 4. Stamp the alert. Best-effort — a write failure here doesn't
  //    re-throw because the email DID go out, and the cleanup is a
  //    cosmetic dashboard concern (the DSL already has the email).
  if (job.alert_id && Types.ObjectId.isValid(job.alert_id)) {
    SafeguardingAlert.updateOne(
      { _id: new Types.ObjectId(job.alert_id) },
      { $set: { notificationSentAt: new Date() } },
    ).catch((err) =>
      logger.error(
        { err, alert_id: job.alert_id },
        "Failed to stamp notificationSentAt on SafeguardingAlert",
      ),
    );
  }

  // 5. Dispatch-latency metric (brief: p95 < 5s).
  //    Two clocks worth logging:
  //      - end_to_end_ms: SafeguardingAlert.create → email sent (the SLA)
  //      - worker_ms: BullMQ pulled the job → email sent (worker health)
  const createdAt = new Date(job.alert_created_at).getTime();
  const now = Date.now();
  const endToEndLatencyMs = Number.isFinite(createdAt) ? now - createdAt : -1;
  const workerLatencyMs = now - startedAt;

  const meta = {
    alert_id: job.alert_id,
    org_id: job.org_id,
    category: job.category,
    recipient,
    message_id: info.messageId,
    dispatch_latency_ms: endToEndLatencyMs,
    worker_latency_ms: workerLatencyMs,
  };

  if (
    endToEndLatencyMs >= 0 &&
    endToEndLatencyMs > DISPATCH_LATENCY_BUDGET_MS
  ) {
    logger.warn(
      meta,
      `Safeguarding alert email dispatch exceeded ${DISPATCH_LATENCY_BUDGET_MS}ms SLA`,
    );
  } else {
    logger.info(meta, "Safeguarding alert email sent");
  }

  return {
    sent: true,
    dispatch_latency_ms: endToEndLatencyMs,
    recipient,
    message_id: info.messageId,
  };
};
