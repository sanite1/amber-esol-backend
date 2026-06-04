/**
 * Learner nudge email — brief Function 12 To-Do 4.
 *
 * Sent on demand when an org admin clicks "nudge" on a learner's
 * record. The email is localised to the learner's L1 by passing a
 * per-language greeting + body sentence into the Handlebars context;
 * the template renders both alongside the English fallback so a
 * learner with limited English still parses the headline.
 *
 * No latency SLA — this is a one-off click, not a crisis ping. We
 * still log dispatch latency for observability.
 */

import transporter from "../nodemailer/nodemailer";
import logger from "../../config/logger";

export interface LearnerNudgeEmailJob {
  learner_id: string;
  learner_email: string;
  learner_name: string;
  l1_language: string;
  esol_level: string | null;
  custom_message: string | null;
  sent_by_user_id: string;
}

export interface LearnerNudgeEmailResult {
  sent: boolean;
  recipient: string;
  message_id?: string;
  l1_language_used: string;
  dispatch_latency_ms: number;
}

const DASHBOARD_URL = "https://esol.ambertraining.co.uk/dashboard";

/**
 * L1 → { greeting, body, signoff }.
 *
 * Translations are Joey's working drafts pending the same review pass
 * that governs safeguarding-messages.json (see SAFEGUARDING_REVIEW.md).
 * Pashto degrades to Farsi script per the platform-wide rule.
 *
 * Each language slot holds three short strings that the template
 * stitches together. Keeping them granular (rather than one big
 * paragraph per language) means a future translator can replace any
 * single sentence without touching the rest.
 */
const L1_NUDGE: Record<
  string,
  { greeting: string; body: string; signoff: string; renderedLanguage: string }
> = {
  english: {
    greeting: "Hello",
    body: "We have not seen you for a while. Your English practice is waiting for you whenever you are ready.",
    signoff: "Sign in here when you have a few minutes.",
    renderedLanguage: "english",
  },
  arabic: {
    greeting: "مرحبا",
    body: "لم نرك منذ فترة. تمارين اللغة الإنجليزية تنتظرك متى كنت مستعدًا.",
    signoff: "سجّل الدخول هنا عندما تجد بضع دقائق.",
    renderedLanguage: "arabic",
  },
  somali: {
    greeting: "Salaan",
    body: "Wakhti dheer ayaa la' yahay ka dib markii aan ku aragnay. Tababarkaaga Ingiriisigu wuu kugu sugayaa marka aad diyaar tahay.",
    signoff: "Gal halkan markaad helayso daqiiqado yar.",
    renderedLanguage: "somali",
  },
  dari: {
    greeting: "سلام",
    body: "مدتی است که شما را ندیده‌ایم. تمرین انگلیسی شما هر وقت آماده باشید منتظرتان است.",
    signoff: "وقتی چند دقیقه فرصت داشتید اینجا وارد شوید.",
    renderedLanguage: "dari",
  },
  farsi: {
    greeting: "سلام",
    body: "مدتی است که شما را ندیده‌ایم. تمرین انگلیسی شما هر وقت آماده باشید منتظرتان است.",
    signoff: "وقتی چند دقیقه فرصت داشتید اینجا وارد شوید.",
    renderedLanguage: "farsi",
  },
  pashto: {
    greeting: "سلام",
    body: "مدتی است که شما را ندیده‌ایم. تمرین انگلیسی شما هر وقت آماده باشید منتظرتان است.",
    signoff: "وقتی چند دقیقه فرصت داشتید اینجا وارد شوید.",
    renderedLanguage: "farsi",
  },
  chinese: {
    greeting: "你好",
    body: "我们已经有一段时间没见到您了。无论何时您准备好，您的英语练习都在等着您。",
    signoff: "有几分钟时间时请在这里登录。",
    renderedLanguage: "chinese",
  },
  cantonese: {
    greeting: "你好",
    body: "我们已经有一段时间没见到您了。无论何时您准备好，您的英语练习都在等着您。",
    signoff: "有几分钟时间时请在这里登录。",
    renderedLanguage: "chinese",
  },
  mandarin: {
    greeting: "你好",
    body: "我们已经有一段时间没见到您了。无论何时您准备好，您的英语练习都在等着您。",
    signoff: "有几分钟时间时请在这里登录。",
    renderedLanguage: "chinese",
  },
};

const resolveSlot = (l1: string | null | undefined) => {
  const key = (l1 ?? "").toString().trim().toLowerCase();
  return L1_NUDGE[key] ?? L1_NUDGE.english;
};

export const sendLearnerNudgeEmail = async (
  job: LearnerNudgeEmailJob
): Promise<LearnerNudgeEmailResult> => {
  const startedAt = Date.now();

  if (!job.learner_email) {
    logger.warn(
      { learner_id: job.learner_id },
      "learner-nudge-email: no learner email — skipping"
    );
    return {
      sent: false,
      recipient: "",
      l1_language_used: "english",
      dispatch_latency_ms: Date.now() - startedAt,
    };
  }

  const slot = resolveSlot(job.l1_language);

  const mailOptions = {
    from: `"Amber Training" <${process.env.AUTH_EMAIL}>`,
    to: job.learner_email,
    subject: "We miss you at Amber — come back when you can",
    template: "./learnerNudge",
    context: {
      l1Greeting: slot.greeting,
      l1Body: slot.body,
      l1Signoff: slot.signoff,
      learnerName: job.learner_name,
      customMessage: job.custom_message ?? "",
      hasCustomMessage: Boolean(job.custom_message && job.custom_message.length > 0),
      dashboardUrl: DASHBOARD_URL,
      currentYear: new Date().getFullYear(),
    },
  };

  let messageId: string | undefined;
  try {
    const info = await transporter.sendMail(mailOptions);
    messageId = info.messageId;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, recipient: job.learner_email, learner_id: job.learner_id },
      "learner-nudge-email: SMTP send failed"
    );
    throw err;
  }

  const dispatchLatencyMs = Date.now() - startedAt;
  logger.info(
    {
      recipient: job.learner_email,
      learner_id: job.learner_id,
      l1_language_used: slot.renderedLanguage,
      message_id: messageId,
      dispatch_latency_ms: dispatchLatencyMs,
    },
    "learner-nudge-email sent"
  );

  return {
    sent: true,
    recipient: job.learner_email,
    message_id: messageId,
    l1_language_used: slot.renderedLanguage,
    dispatch_latency_ms: dispatchLatencyMs,
  };
};

export const __internals__ = { L1_NUDGE, resolveSlot, DASHBOARD_URL };
