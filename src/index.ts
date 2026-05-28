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
import esolMatchingRoutes from "./routes/esolMatching.routes";
import healthRoutes from "./routes/health.routes";
import jobsRoutes from "./routes/jobs.routes";
import adminCacheRoutes from "./routes/adminCache.routes";
import adminUsersRoutes from "./routes/adminUsers.routes";
import orgRoutes from "./routes/org.routes";
import { stripeWebhook } from "./controllers/webhook.controller";
import { initSocketIO } from "./services/websocket.service";
import ALLOWED_ORIGINS from "./config/cors";
import { generalLimiter, webhookLimiter } from "./config/rateLimiter";
import logger from "./config/logger";
import { initGeminiClient } from "./lib/gemini";
import { initRedis } from "./lib/redis";
import { createBullBoardAdapter } from "./lib/bullBoard";
import { isAuthenticated, isAdmin } from "./middlewares/authMiddleWare";
import { requireBullBoardToken } from "./middlewares/bullBoardToken";
import ComplianceConfigService from "./services/ComplianceConfigService";
import SafeguardingDetector from "./services/safeguardingDetector.service";
import PostcodeRouter from "./services/postcodeRouter.service";
import FALACache from "./services/falaCache.service";
import { cacheRefreshQueue } from "./queues";

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

  // ── Prime compliance rules cache from Mongo ──
  // ILR / RARPA / ASF-routing constants are config, not code. Every
  // downstream service reads from the in-memory cache via
  // ComplianceConfigService.getConfig(). If the seed hasn't been run yet
  // the cache will be empty and downstream services will see null —
  // fail-closed by design.
  try {
    await ComplianceConfigService.loadAll();
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      "ComplianceConfig loadAll failed at boot. Refusing to start."
    );
    process.exit(1);
  }

  // ── Initialise Vertex AI Gemini singleton at boot ──
  // If this throws, fail loudly: do NOT degrade silently to per-request errors.
  try {
    initGeminiClient();
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      "Vertex AI client failed to initialise at boot. Refusing to start."
    );
    process.exit(1);
  }

  // ── Initialise Redis singleton at boot ──
  // BullMQ queues, the rate limiter, and pre-cache services all share this
  // connection. If Redis is unreachable, we refuse to start rather than
  // silently failing to enqueue jobs later.
  try {
    await initRedis();
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      "Redis failed to initialise at boot. Refusing to start."
    );
    process.exit(1);
  }

  // ── Prime the safeguarding detector cache ──
  // Loads keyword/regex patterns from Mongo. Empty collection is logged
  // but not fatal — better to start with no patterns and surface a warning
  // than to refuse to serve at all. Joey backfills via the seed script.
  try {
    await SafeguardingDetector.loadAll();
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "SafeguardingDetector.loadAll failed — continuing with empty cache"
    );
  }

  // ── Postcode dataset: enqueue startup load if marker is stale ────────
  // Non-fatal — production may legitimately defer the heavy load. Redis
  // unreachable would have crashed initRedis above; if we get here Redis
  // is fine and we can safely query the marker.
  try {
    const loaded = await PostcodeRouter.isLoaded();
    if (!loaded) {
      const job = await cacheRefreshQueue.add("postcode-load", {
        task: "postcode-load",
        academicYear: PostcodeRouter.TARGET_ACADEMIC_YEAR,
      });
      logger.info(
        { jobId: job.id },
        "Postcode dataset not loaded — enqueued startup load job"
      );
    } else {
      logger.info("Postcode dataset already loaded — skipping startup load");
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "Postcode startup-load check failed"
    );
  }

  // ── FALA whitelist: enqueue startup seed if empty ────────────────────
  try {
    const populated = await FALACache.isPopulated();
    if (!populated) {
      const job = await cacheRefreshQueue.add("fala-refresh", {
        task: "fala-refresh",
        academicYear: FALACache.TARGET_ACADEMIC_YEAR,
      });
      logger.info(
        { jobId: job.id },
        "FALA whitelist empty — enqueued startup refresh job"
      );
    } else {
      logger.info("FALA whitelist already populated — skipping startup refresh");
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "FALA startup-load check failed"
    );
  }

  // ── Initialise WebSocket ──
  initSocketIO(server);

  app.use("/api", generalLimiter);

  app.use("/api/health", healthRoutes);
  app.use("/api/jobs", jobsRoutes);
  app.use("/api/admin/cache", adminCacheRoutes);
  app.use("/api/admin/users", adminUsersRoutes);
  app.use("/api/orgs", orgRoutes);
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
  app.use("/api/esol/teacher-matches", esolMatchingRoutes);

  // ── Bull Board admin UI ──────────────────────────────────────────────
  // Three gates in order: JWT, admin role, defence-in-depth token header.
  // Mounted outside /api on purpose — it's an admin tool, not a public API.
  const bullBoardAdapter = createBullBoardAdapter();
  app.use(
    "/admin/queues",
    isAuthenticated,
    isAdmin,
    requireBullBoardToken,
    bullBoardAdapter.getRouter()
  );

  app.all("*", (req, _res, next) => {
    next(new ApiError(404, `Can't find ${req.originalUrl} on the server!`));
  });
  app.use(globalErrorHandler);

  // ── Inline BullMQ workers in dev ────────────────────────────────────
  // In production, workers run as a separate process via `npm run workers`.
  // For local development, attach them to this process so a single
  // `npm run dev` starts everything. Disable with INLINE_WORKERS=false.
  if (process.env.INLINE_WORKERS !== "false") {
    try {
      const { startWorkers } = await import("./workers");
      startWorkers();
    } catch (err) {
      logger.error(
        { err: (err as Error).message },
        "Inline worker startup failed — server will continue without workers"
      );
    }
  }

  // ── Use server.listen instead of app.listen for Socket.IO ──
  server.listen(PORT, () => {
    logger.info({ port: PORT }, "Server listening");
  });
})();
