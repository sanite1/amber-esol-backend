import { createTransport } from "nodemailer";
import hbs from "nodemailer-express-handlebars";
import path from "path";
import logger from "../../config/logger";

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
