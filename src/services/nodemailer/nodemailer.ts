import { createTransport } from "nodemailer";
import hbs from "nodemailer-express-handlebars";
import path from "path";
import logger from "../../config/logger";
import { IS_DEMO_MODE, DEMO_EMAIL_PREFIX } from "../../config/demoMode";

const transporter = createTransport({
  host: "mail.privateemail.com",
  port: 465,
  secure: true,
  requireTLS: true,
  auth: {
    user: process.env.AUTH_EMAIL,
    pass: process.env.AUTH_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

// ── Demo-mode subject prefix (brief Function 16) ────────────────────
// When DEMO_MODE=true we wrap sendMail so every outgoing subject is
// prefixed with "[DEMO] ". Done by monkey-patching the transporter's
// sendMail rather than touching the 30+ call sites — a single
// truthful interception keeps the rule centralised and means a future
// caller can't accidentally bypass it.
//
// We avoid double-prefixing if the caller has already added [DEMO]
// (e.g. an integration test that asserts on the literal subject).
if (IS_DEMO_MODE) {
  const original = transporter.sendMail.bind(transporter);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (transporter as any).sendMail = (options: any, cb?: any) => {
    if (
      options &&
      typeof options.subject === "string" &&
      !options.subject.startsWith(DEMO_EMAIL_PREFIX)
    ) {
      options = { ...options, subject: DEMO_EMAIL_PREFIX + options.subject };
    }
    return original(options, cb);
  };
  logger.info("nodemailer: DEMO_MODE — outbound subjects prefixed with [DEMO]");
}

const handlebarOptions = {
  viewEngine: {
    partialsDir: path.resolve("src/services/nodemailer/templates"),
    defaultLayout: "",
  },
  viewPath: path.resolve("src/services/nodemailer/templates"),
};

transporter.use("compile", hbs(handlebarOptions));

transporter.verify((error: any, _success: any) => {
  if (error) {
    logger.error({ err: error }, "SMTP connection error");
  } else {
    logger.info("SMTP server is ready to send messages");
  }
});

export default transporter;
