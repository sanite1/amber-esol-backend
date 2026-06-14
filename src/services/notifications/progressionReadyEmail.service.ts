/**
 * Org-admin "learner ready for level review" email — brief Function 11.
 *
 * Sent by the daily progression cron's per-org worker when a learner
 * meets all five level-progression criteria AND no equivalent
 * notification has fired in the last 7 days for the same level.
 *
 * Privacy note: unlike the safeguarding alert email, this one DOES
 * carry the learner's name + level. That's intentional — the org
 * admin is the data controller for their cohort and already sees
 * these names in their dashboard. The brief's strict "no PII in
 * email" rule applies to safeguarding (where the recipient is the
 * platform-wide DSL inbox); the progression email is scoped to the
 * org admin who owns the learner record.
 *
 * Latency target: not SLA-bound — this is a daily-cadence email, not
 * a crisis ping. We still log the dispatch latency for observability
 * so a slow SMTP run shows up in metrics.
 */

import { Types } from "mongoose";
import transporter from "../nodemailer/nodemailer";
import User from "../../models/User";
import Organisation from "../../models/Organisation";
import logger from "../../config/logger";

export interface ProgressionReadyEmailJob {
  org_admin_user_id: string;
  org_id: string;
  learner_id: string;
  learner_name: string;
  current_level: string;
  ready_at: string;
}

export interface ProgressionReadyEmailResult {
  sent: boolean;
  recipient: string | null;
  message_id?: string;
  dispatch_latency_ms: number;
}

const DOMAIN_NAME = process.env.DOMAIN_NAME ?? "";

export const sendProgressionReadyEmail = async (
  job: ProgressionReadyEmailJob,
): Promise<ProgressionReadyEmailResult> => {
  const startedAt = Date.now();

  // 1. Resolve the org-admin email address. Tolerant of a missing
  //    user — the in-app notification was already created upstream;
  //    skipping the email is acceptable graceful degradation.
  let recipient: string | null = null;
  if (Types.ObjectId.isValid(job.org_admin_user_id)) {
    const admin = await User.findById(job.org_admin_user_id)
      .select("email firstname lastname")
      .lean();
    if (admin?.email) {
      recipient = admin.email;
    }
  }
  if (!recipient) {
    logger.warn(
      { org_admin_user_id: job.org_admin_user_id, org_id: job.org_id },
      "progression-ready-email: org admin email not resolvable — skipping send",
    );
    return {
      sent: false,
      recipient: null,
      dispatch_latency_ms: Date.now() - startedAt,
    };
  }

  // 2. Org name for the salutation. Cheap lookup, tolerant.
  let orgName = "your organisation";
  if (Types.ObjectId.isValid(job.org_id)) {
    const org = await Organisation.findById(job.org_id).select("name").lean();
    if (org?.name) orgName = org.name;
  }

  // 3. Compose via the existing Handlebars transporter — `template`
  //    is the file name in src/services/nodemailer/templates without
  //    the .handlebars suffix.
  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: recipient,
    subject: `Learner ready for level review: ${job.learner_name}`,
    template: "./progressionReady",
    context: {
      adminLooksLikeOrg: orgName,
      learnerName: job.learner_name,
      currentLevel: job.current_level.toUpperCase(),
      readyAt: new Date(job.ready_at).toLocaleString("en-GB", {
        timeZone: "Europe/London",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      // The org-admin dashboard's deep link to the learner record —
      // takes them straight to the level-review screen.
      dashboardUrl: `${DOMAIN_NAME}/org-admin/learners/${job.learner_id}/level-review`,
      currentYear: new Date().getFullYear(),
    },
  };

  let messageId: string | undefined;
  try {
    const info = await transporter.sendMail(mailOptions);
    messageId = info.messageId;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, recipient, org_id: job.org_id },
      "progression-ready-email: SMTP send failed",
    );
    // Re-throw so BullMQ retries — the email is the org admin's
    // primary signal and we want at least one delivery attempt to
    // succeed before giving up.
    throw err;
  }

  const dispatchLatencyMs = Date.now() - startedAt;
  logger.info(
    {
      recipient,
      org_id: job.org_id,
      learner_id: job.learner_id,
      current_level: job.current_level,
      message_id: messageId,
      dispatch_latency_ms: dispatchLatencyMs,
    },
    "progression-ready-email sent",
  );

  return {
    sent: true,
    recipient,
    message_id: messageId,
    dispatch_latency_ms: dispatchLatencyMs,
  };
};
