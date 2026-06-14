/**
 * Org-admin "level change rejected" email — brief Function 11 To-Do 2.
 *
 * Fired when Amber admin declines a flagged learner. Carries the
 * reviewer's rationale so the org admin understands why their
 * dashboard's "ready" flag didn't translate into a confirmed
 * promotion.
 *
 * Audience is the org admin (data controller for the learner cohort);
 * the email therefore includes the learner's name and current level.
 * The brief's no-PII rule for safeguarding email does not apply here.
 */

import { Types } from "mongoose";
import transporter from "../nodemailer/nodemailer";
import User from "../../models/User";
import logger from "../../config/logger";

export interface ProgressionRejectedEmailJob {
  org_id: string;
  org_name: string;
  org_admin_user_id: string;
  learner_id: string;
  learner_name: string;
  current_level: string;
  reason: string;
}

export interface ProgressionRejectedEmailResult {
  sent: boolean;
  recipient: string | null;
  message_id?: string;
  dispatch_latency_ms: number;
}

const DOMAIN_NAME = process.env.DOMAIN_NAME ?? "";

export const sendProgressionRejectedEmail = async (
  job: ProgressionRejectedEmailJob,
): Promise<ProgressionRejectedEmailResult> => {
  const startedAt = Date.now();

  let recipient: string | null = null;
  if (Types.ObjectId.isValid(job.org_admin_user_id)) {
    const admin = await User.findById(job.org_admin_user_id)
      .select("email")
      .lean();
    if (admin?.email) recipient = admin.email;
  }
  if (!recipient) {
    logger.warn(
      { org_admin_user_id: job.org_admin_user_id, org_id: job.org_id },
      "progression-rejected-email: org admin email not resolvable — skipping",
    );
    return {
      sent: false,
      recipient: null,
      dispatch_latency_ms: Date.now() - startedAt,
    };
  }

  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: recipient,
    subject: `Level change rejected: ${job.learner_name}`,
    template: "./progressionRejected",
    context: {
      orgName: job.org_name,
      learnerName: job.learner_name,
      currentLevel: job.current_level.toUpperCase(),
      reason: job.reason,
      reviewedAt: new Date().toLocaleString("en-GB", {
        timeZone: "Europe/London",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      dashboardUrl: `${DOMAIN_NAME}/org-admin/learners/${job.learner_id}`,
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
      "progression-rejected-email: SMTP send failed",
    );
    throw err;
  }

  const dispatchLatencyMs = Date.now() - startedAt;
  logger.info(
    {
      recipient,
      org_id: job.org_id,
      learner_id: job.learner_id,
      message_id: messageId,
      dispatch_latency_ms: dispatchLatencyMs,
    },
    "progression-rejected-email sent",
  );

  return {
    sent: true,
    recipient,
    message_id: messageId,
    dispatch_latency_ms: dispatchLatencyMs,
  };
};
