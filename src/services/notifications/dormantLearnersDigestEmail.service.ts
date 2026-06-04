/**
 * Dormant-learners digest email — brief Function 12 To-Do 4.
 *
 * Fired by the per-org progression worker when the daily sweep finds
 * at least one learner in the "dormant" band (15+ days since last
 * session). One email per org per cron run — aggregated rather than
 * per-learner so an org with a long tail of dormant learners doesn't
 * drown the admin inbox.
 *
 * The body is deliberately count-only. The brief warns against
 * inadvertently turning this into a list of names that travels through
 * email infrastructure; the org admin has the full filtered list on
 * the cohort table (`?status=dormant`), which lives behind their
 * authenticated session. The email is just the prompt to look.
 */

import { Types } from "mongoose";
import transporter from "../nodemailer/nodemailer";
import User from "../../models/User";
import Organisation from "../../models/Organisation";
import logger from "../../config/logger";

export interface DormantLearnersDigestEmailJob {
  org_admin_user_id: string;
  org_id: string;
  dormant_count: number;
  /** The "inactive cut-off" days — typically 14 (brief threshold for dormant). */
  window_days: number;
}

export interface DormantLearnersDigestEmailResult {
  sent: boolean;
  recipient: string | null;
  message_id?: string;
  dispatch_latency_ms: number;
}

const DOMAIN_NAME = process.env.DOMAIN_NAME ?? "";

export const sendDormantLearnersDigestEmail = async (
  job: DormantLearnersDigestEmailJob
): Promise<DormantLearnersDigestEmailResult> => {
  const startedAt = Date.now();

  let recipient: string | null = null;
  if (Types.ObjectId.isValid(job.org_admin_user_id)) {
    const admin = await User.findById(job.org_admin_user_id).select("email").lean();
    if (admin?.email) recipient = admin.email;
  }
  if (!recipient) {
    logger.warn(
      { org_admin_user_id: job.org_admin_user_id, org_id: job.org_id },
      "dormant-learners-digest-email: admin email not resolvable — skipping"
    );
    return {
      sent: false,
      recipient: null,
      dispatch_latency_ms: Date.now() - startedAt,
    };
  }

  let orgName = "your organisation";
  if (Types.ObjectId.isValid(job.org_id)) {
    const org = await Organisation.findById(job.org_id).select("name").lean();
    if (org?.name) orgName = org.name;
  }

  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: recipient,
    subject:
      job.dormant_count === 1
        ? "1 learner needs a check-in"
        : `${job.dormant_count} learners need a check-in`,
    template: "./dormantLearnersDigest",
    context: {
      orgName,
      dormantCount: job.dormant_count,
      isPlural: job.dormant_count !== 1,
      windowDays: job.window_days,
      dashboardUrl: `${DOMAIN_NAME}/org-admin/learners?status=dormant`,
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
      "dormant-learners-digest-email: SMTP send failed"
    );
    throw err; // BullMQ retry
  }

  const dispatchLatencyMs = Date.now() - startedAt;
  logger.info(
    {
      recipient,
      org_id: job.org_id,
      dormant_count: job.dormant_count,
      message_id: messageId,
      dispatch_latency_ms: dispatchLatencyMs,
    },
    "dormant-learners-digest-email sent"
  );

  return {
    sent: true,
    recipient,
    message_id: messageId,
    dispatch_latency_ms: dispatchLatencyMs,
  };
};
