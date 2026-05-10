import express, { raw } from "express";
import dotenv from "dotenv";
dotenv.config();
import cors from "cors";
import { createServer } from "http";
import { connectDb } from "./config/db";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";
import ApiError from "./errors/apiError";
import userRoutes from "./routes/user.routes";
import availabilityRoutes from "./routes/availability.routes";
import bookingRoutes from "./routes/booking.routes";
import paymentRoutes from "./routes/payment.routes";
import reviewRoutes from "./routes/review.routes";
import messagingRoutes from "./routes/messaging.routes";
import notificationRoutes from "./routes/notification.routes";
import myTutorsRoutes from "./routes/myTutors.routes";
import myStudentsRoutes from "./routes/myStudents.routes";
import tutorDashboardRoutes from "./routes/tutorDashboard.routes";
import studentDashboardRoutes from "./routes/studentDashboard.routes";
import adminDashboardRoutes from "./routes/adminDashboard.routes";
import cronRoutes from "./routes/cron.routes";
import esolOrgRoutes from "./routes/esolOrg.routes";
import esolReferralRoutes from "./routes/esolReferral.routes";
import esolOnboardingRoutes from "./routes/esolOnboarding.routes";
import esolLearnerRoutes from "./routes/esolLearner.routes";
import esolTeacherRoutes from "./routes/esolTeacher.routes";
import esolAISessionRoutes from "./routes/esolAISession.routes";
import esolSafeguardingRoutes from "./routes/esolSafeguarding.routes";
import esolInvoiceRoutes from "./routes/esolInvoice.routes";
import esolReportRoutes from "./routes/esolReport.routes";
import esolLevelChangeRoutes from "./routes/esolLevelChange.routes";
import esolSessionFeedbackRoutes from "./routes/esolSessionFeedback.routes";
import esolVocabRoutes from "./routes/esolVocab.routes";
import { stripeWebhook } from "./controllers/webhook.controller";
import { initSocketIO } from "./services/websocket.service";
import ALLOWED_ORIGINS from "./config/cors";
import { generalLimiter, webhookLimiter } from "./config/rateLimiter";
import logger from "./config/logger";

const PORT = 4000;

const app = express();
const server = createServer(app);

const corsOption = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    // Allow requests with no origin header — mobile apps, server-to-server,
    // Stripe webhooks, Vercel cron jobs.
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true,
};

app.use(cors(corsOption));

(async () => {
  // ── Stripe webhook MUST be before express.json() ──
  app.post(
    "/api/webhooks/stripe",
    webhookLimiter,
    raw({ type: "application/json" }),
    stripeWebhook
  );

  app.use(express.json());

  // ✅ Wait for DB before registering routes
  await connectDb();
  // ── Initialise WebSocket ──
  initSocketIO(server);

  app.use("/api", generalLimiter);

  app.use("/api/users", userRoutes);
  app.use("/api/availability", availabilityRoutes);
  app.use("/api/bookings", bookingRoutes);
  app.use("/api/payments", paymentRoutes);
  app.use("/api/reviews", reviewRoutes);
  app.use("/api/conversations", messagingRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api/my-tutors", myTutorsRoutes);
  app.use("/api/my-students", myStudentsRoutes);
  app.use("/api/tutor-dashboard", tutorDashboardRoutes);
  app.use("/api/student-dashboard", studentDashboardRoutes);
  app.use("/api/admin-dashboard", adminDashboardRoutes);
  app.use("/api/cron", cronRoutes);

  // ── ESOL / Project Silk ──
  app.use("/api/esol/organisations", esolOrgRoutes);
  app.use("/api/esol/referrals", esolReferralRoutes);
  app.use("/api/esol/onboarding", esolOnboardingRoutes);
  app.use("/api/esol/learners", esolLearnerRoutes);
  app.use("/api/esol/teachers", esolTeacherRoutes);
  app.use("/api/esol/sessions", esolAISessionRoutes);
  app.use("/api/esol/safeguarding", esolSafeguardingRoutes);
  app.use("/api/esol/invoices", esolInvoiceRoutes);
  app.use("/api/esol/reports", esolReportRoutes);
  app.use("/api/esol/level-changes", esolLevelChangeRoutes);
  app.use("/api/esol/session-feedback", esolSessionFeedbackRoutes);
  app.use("/api/esol/vocab", esolVocabRoutes);

  app.all("*", (req, _res, next) => {
    next(new ApiError(404, `Can't find ${req.originalUrl} on the server!`));
  });
  app.use(globalErrorHandler);

  // ── Use server.listen instead of app.listen for Socket.IO ──
  server.listen(PORT, () => {
    logger.info({ port: PORT }, "Server listening");
  });
})();
