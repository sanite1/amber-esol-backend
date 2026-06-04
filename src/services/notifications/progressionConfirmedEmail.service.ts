/**
 * Learner celebration email — brief Function 11 To-Do 2.
 *
 * Fired when Amber admin confirms a level change. Carries an L1
 * greeting in the learner's first language alongside the English body
 * so a learner with E1-level English still parses the headline.
 *
 * L1 coverage matches the MVP language set (ar/so/fa/zh) plus English.
 * Pashto degrades to Farsi script per the brief-wide rule (see
 * safeguardingMessages.service.ts). A non-mappable L1 falls back to
 * English-only — the email still delivers, the learner just doesn't
 * get the localised opener.
 *
 * No PII concerns: this email is addressed to the learner about their
 * own progression. The recipient owns the data.
 */

import transporter from "../nodemailer/nodemailer";
import logger from "../../config/logger";

export interface ProgressionConfirmedEmailJob {
  learner_id: string;
  learner_email: string;
  learner_name: string;
  l1_language: string;
  old_level: string;
  new_level: string;
}

export interface ProgressionConfirmedEmailResult {
  sent: boolean;
  recipient: string;
  message_id?: string;
  l1_greeting_used: string;
  dispatch_latency_ms: number;
}

const DOMAIN_NAME = process.env.DOMAIN_NAME ?? "";

/**
 * L1 → opener phrase. Short, well-known congratulation in each MVP
 * language. Reviewed by native-speaker translators in the same review
 * pass as the safeguarding bank (see SAFEGUARDING_REVIEW.md for the
 * process) — until that pass lands, the values are Joey's drafts and
 * the brief authorises them as a temporary working set.
 */
const L1_GREETING: Record<string, { greeting: string; congrats: string }> = {
  english: { greeting: "Hello", congrats: "Congratulations!" },
  arabic:  { greeting: "مرحبا",    congrats: "مبروك!" },
  somali:  { greeting: "Salaan",   congrats: "Hambalyo!" },
  dari:    { greeting: "سلام",    congrats: "تبریک می‌گویم!" },
  farsi:   { greeting: "سلام",    congrats: "تبریک می‌گویم!" },
  pashto:  { greeting: "سلام",    congrats: "مبارک شه!" },
  chinese: { greeting: "你好",     congrats: "恭喜你!" },
  cantonese: { greeting: "你好",   congrats: "恭喜你!" },
  mandarin: { greeting: "你好",    congrats: "恭喜你!" },
};

const resolveGreeting = (l1: string | null | undefined) => {
  const key = (l1 ?? "").toString().trim().toLowerCase();
  return L1_GREETING[key] ?? L1_GREETING.english;
};

export const sendProgressionConfirmedEmail = async (
  job: ProgressionConfirmedEmailJob
): Promise<ProgressionConfirmedEmailResult> => {
  const startedAt = Date.now();

  if (!job.learner_email) {
    logger.warn(
      { learner_id: job.learner_id },
      "progression-confirmed-email: no learner email — skipping"
    );
    return {
      sent: false,
      recipient: "",
      l1_greeting_used: "english",
      dispatch_latency_ms: Date.now() - startedAt,
    };
  }

  const greeting = resolveGreeting(job.l1_language);
  const newLevelUpper = job.new_level.toUpperCase();

  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: job.learner_email,
    subject: `Congratulations — you have progressed to ${newLevelUpper}`,
    template: "./progressionConfirmed",
    context: {
      l1Greeting: greeting.greeting,
      l1Congrats: greeting.congrats,
      learnerName: job.learner_name,
      oldLevel: job.old_level.toUpperCase(),
      newLevel: newLevelUpper,
      dashboardUrl: `${DOMAIN_NAME}/learner/dashboard`,
      currentYear: new Date().getFullYear(),
    },
  };

  let messageId: string | undefined;
  try {
    const info = await transporter.sendMail(mailOptions);
    messageId = info.messageId;
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        recipient: job.learner_email,
        learner_id: job.learner_id,
      },
      "progression-confirmed-email: SMTP send failed"
    );
    throw err; // let BullMQ retry
  }

  const dispatchLatencyMs = Date.now() - startedAt;
  const l1Key = (job.l1_language ?? "english").toString().trim().toLowerCase();
  logger.info(
    {
      recipient: job.learner_email,
      learner_id: job.learner_id,
      old_level: job.old_level,
      new_level: job.new_level,
      l1_greeting_used: l1Key in L1_GREETING ? l1Key : "english",
      message_id: messageId,
      dispatch_latency_ms: dispatchLatencyMs,
    },
    "progression-confirmed-email sent"
  );

  return {
    sent: true,
    recipient: job.learner_email,
    message_id: messageId,
    l1_greeting_used: l1Key in L1_GREETING ? l1Key : "english",
    dispatch_latency_ms: dispatchLatencyMs,
  };
};

export const __internals__ = { L1_GREETING, resolveGreeting };
