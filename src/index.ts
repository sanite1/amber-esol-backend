import express, { raw } from "express";
import dotenv from "dotenv";
dotenv.config();
import cors from "cors";
import { createServer, get as httpGet } from "http";
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
import esolMessagesRoutes from "./routes/esolMessages.routes";
import esolMatchingRoutes from "./routes/esolMatching.routes";
import esolVerifyTokenRoutes from "./routes/esolVerifyToken.routes";
import esolRegisterRoutes from "./routes/esolRegister.routes";
import esolEligibilityRoutes from "./routes/esolEligibility.routes";
import esolUlnRoutes from "./routes/esolUln.routes";
import publicRoiCalculatorRoutes from "./routes/publicRoiCalculator.routes";
import orgAdminImportRoutes from "./routes/orgAdminImport.routes";
import placementRoutes from "./routes/placement.routes";
import calibrationRoutes from "./routes/calibration.routes";
import aiSessionRoutes from "./routes/aiSession.routes";
import healthRoutes from "./routes/health.routes";
import jobsRoutes from "./routes/jobs.routes";
import adminCacheRoutes from "./routes/adminCache.routes";
import adminUsersRoutes from "./routes/adminUsers.routes";
import adminSafeguardingRoutes from "./routes/adminSafeguarding.routes";
import orgAdminSafeguardingRoutes from "./routes/orgAdminSafeguarding.routes";
import adminLevelChangeRoutes from "./routes/adminLevelChange.routes";
import orgAdminLearnersRoutes from "./routes/orgAdminLearners.routes";
import orgAdminNarrativeRoutes from "./routes/orgAdminNarrative.routes";
import orgAdminAuditLogRoutes from "./routes/orgAdminAuditLog.routes";
// Phase 1 / Final Addendum §6 (BE-A) — learner-self audit log.
import learnerAuditLogRoutes from "./routes/learnerAuditLog.routes";
// Phase 2 / Final Addendum §13 (BE-G) — org-admin onboarding embed.
import orgOnboardingRoutes from "./routes/orgOnboarding.routes";
import ilrExportRoutes from "./routes/ilrExport.routes";
import orgAdminEvidenceReportRoutes from "./routes/orgAdminEvidenceReport.routes";
import adminEvidenceReportRoutes from "./routes/adminEvidenceReport.routes";
import adminOrgsRoutes from "./routes/adminOrgs.routes";
import adminImpersonationRoutes from "./routes/adminImpersonation.routes";
import adminComplianceConfigRoutes from "./routes/adminComplianceConfig.routes";
import adminAuditLogRoutes from "./routes/adminAuditLog.routes";
import adminSafeguardingMessagesRoutes from "./routes/adminSafeguardingMessages.routes";
import adminQueuesRoutes from "./routes/adminQueues.routes";
import adminTeacherUtilisationRoutes from "./routes/adminTeacherUtilisation.routes";
import adminGlhAnalyticsRoutes from "./routes/adminGlhAnalytics.routes";
import adminSalesIntelligenceRoutes from "./routes/adminSalesIntelligence.routes";
import adminFailedJobsRoutes from "./routes/adminFailedJobs.routes";
import stage5Routes from "./routes/stage5.routes";
import orgAdminStage5Routes from "./routes/orgAdminStage5.routes";
import teacherRoutes from "./routes/teacher.routes";
import orgAdminTeachersRoutes from "./routes/orgAdminTeachers.routes";
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
import CurriculumLevelService from "./services/curriculumLevel.service";
import SafeguardingDetector from "./services/safeguardingDetector.service";
import PostcodeRouter from "./services/postcodeRouter.service";
import FALACache from "./services/falaCache.service";
import { cacheRefreshQueue } from "./queues";
import { demoModeHeader } from "./middlewares/demoMode";

// Hosts like Render inject the port to bind via PORT; 4000 stays the
// local dev default so nothing changes on developer machines.
const PORT = Number(process.env.PORT) || 4000;

const app = express();
// One proxy hop (Render's edge) forwards requests to us. Without this,
// req.ip is the proxy for every visitor, so rate limits share a single
// bucket and audit rows record the proxy address. Comments elsewhere
// (roiCalculatorSubmit) already assumed this was set.
app.set("trust proxy", 1);
const server = createServer(app);

const corsOption = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
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
  // Function 16 — surface X-Demo-Mode to the browser. Custom headers
  // are NOT in the CORS-safelisted response set, so the frontend
  // can't read them through fetch/axios without an explicit
  // Access-Control-Expose-Headers entry.
  exposedHeaders: ["X-Demo-Mode"],
};

app.use(cors(corsOption));
// Stamp X-Demo-Mode on every response when DEMO_MODE=true. Runs
// before any route so even /health surfaces the flag.
app.use(demoModeHeader);

(async () => {
  // ── Stripe webhook MUST be before express.json() ──
  app.post(
    "/api/webhooks/stripe",
    webhookLimiter,
    raw({ type: "application/json" }),
    stripeWebhook,
  );

  // F32 — spoken turns post base64 audio to /api/esol/session/turn-voice.
  // Mount a larger JSON parser on that prefix BEFORE the global one; the
  // global parser skips bodies that are already parsed, so every other
  // route keeps the default 100kb ceiling.
  app.use("/api/esol/session", express.json({ limit: "4mb" }));
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
      "ComplianceConfig loadAll failed at boot. Refusing to start.",
    );
    process.exit(1);
  }

  // ── Prime the curriculum cache (AI Tutor Build Brief §1.1) ──
  // CurriculumLevel docs drive Layer 3/5 prompt build, placement
  // objectives, vocab retention thresholds and the Bridge mode
  // controller. Non-fatal if empty (seed via `npm run seed:curriculum`)
  // — downstream reads fall back rather than refusing to serve.
  try {
    await CurriculumLevelService.loadAll();
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "CurriculumLevel loadAll failed at boot — continuing with empty cache",
    );
  }

  // ── Initialise Vertex AI Gemini singleton at boot ──
  // If this throws, fail loudly: do NOT degrade silently to per-request errors.
  try {
    initGeminiClient();
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      "Vertex AI client failed to initialise at boot. Refusing to start.",
    );
    process.exit(1);
  }

  // ── Initialise Redis singleton at boot ──
  // BullMQ queues, the rate limiter, and pre-cache services all share
  // this connection. Redis is a SOFT dependency (see lib/redis.ts) —
  // a connection failure logs a warning but does NOT crash the
  // process. Features that need Redis (rate limiter, BullMQ enqueue,
  // cache reads) degrade gracefully:
  //   • Rate limiter falls back to in-memory (per-container counters)
  //   • BullMQ enqueues become no-ops (logged + dropped)
  //   • Cache misses fall through to Mongo
  //
  // The only hard-failure case lives inside initRedis itself: missing
  // REDIS_URL in production. That's a deploy mistake we still crash on.
  try {
    const ok = await initRedis();
    if (!ok) {
      logger.warn(
        "Redis unavailable — continuing in degraded mode " +
          "(rate limiters in-memory, queues no-op, cache off)",
      );
    }
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message },
      "Redis init reported an unrecoverable error. Refusing to start.",
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
      "SafeguardingDetector.loadAll failed — continuing with empty cache",
    );
  }

  // ── Safeguarding response texts (Final Addendum §2) ──
  // Mongo-backed bank, seeded from the JSON file on first boot,
  // editable via the admin CMS without deployment. Failure keeps the
  // module-load file copy — the learner-facing fall-back chain never
  // breaks.
  try {
    const { reloadSafeguardingBankFromDb } = await import(
      "./services/safeguardingMessages.service"
    );
    await reloadSafeguardingBankFromDb();
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "Safeguarding message bank DB load failed — using file copy",
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
        "Postcode dataset not loaded — enqueued startup load job",
      );
    } else {
      logger.info("Postcode dataset already loaded — skipping startup load");
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "Postcode startup-load check failed",
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
        "FALA whitelist empty — enqueued startup refresh job",
      );
    } else {
      logger.info(
        "FALA whitelist already populated — skipping startup refresh",
      );
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "FALA startup-load check failed",
    );
  }

  // ── Initialise WebSocket ──
  initSocketIO(server);

  // Health FIRST, before the rate limiter: hosting health probes and
  // uptime monitors must get an answer even when Redis (the limiter's
  // store) is flapping — a hung probe marks the whole deploy failed.
  app.use("/api/health", healthRoutes);

  app.use("/api", generalLimiter);
  app.use("/api/jobs", jobsRoutes);
  app.use("/api/admin/cache", adminCacheRoutes);
  app.use("/api/admin/users", adminUsersRoutes);
  // Brief Function 10 / Function 15 — Amber-admin safeguarding console.
  // Mounted BEFORE the legacy /api/esol/safeguarding router so the new
  // strictly-admin-only paths take precedence; the legacy router stays
  // available for back-compat until the frontend migrates.
  app.use("/api/admin/safeguarding", adminSafeguardingRoutes);
  app.use("/api/org-admin/safeguarding", orgAdminSafeguardingRoutes);
  // Function 11 To-Do 2 — Amber admin confirm/reject a flagged learner.
  app.use("/api/admin/level-change", adminLevelChangeRoutes);
  // Function 12 To-Do 1 — org-admin cohort table.
  app.use("/api/org-admin/learners", orgAdminLearnersRoutes);
  // Function 12 To-Do 3 — Gemini-powered cohort narrative summary.
  app.use("/api/org-admin/narrative-summary", orgAdminNarrativeRoutes);
  // Final Addendum §6 — org-wide audit log.
  app.use("/api/org-admin/audit-log", orgAdminAuditLogRoutes);
  // Phase 1 / BE-A — learner-self audit log (mounted at /api/learner;
  // the only route under it today is GET /me/audit-log).
  app.use("/api/learner", learnerAuditLogRoutes);
  // Phase 2 / BE-G — org-admin onboarding embed (GET /status,
  // POST /complete). Lives under /api/org-admin/onboarding to keep
  // the org-admin auth chain consistent across the family.
  app.use("/api/org-admin/onboarding", orgOnboardingRoutes);
  // Function 13 To-Do 4 — ILR export pipeline (BullMQ-dispatched).
  app.use("/api/org-admin/export/ilr", ilrExportRoutes);
  // Function 14 To-Do 4 — consolidated RARPA evidence-report PDF.
  app.use("/api/org-admin/evidence-report", orgAdminEvidenceReportRoutes);
  app.use("/api/admin/evidence-report", adminEvidenceReportRoutes);
  // Function 15 To-Do 1 — Amber-admin all-orgs overview + management.
  app.use("/api/admin/orgs", adminOrgsRoutes);
  // Function 15 — Amber-admin impersonation for support sessions.
  app.use("/api/admin/impersonate", adminImpersonationRoutes);
  // Final Addendum §3 — versioned ComplianceConfig editor.
  app.use("/api/admin/compliance-config", adminComplianceConfigRoutes);
  // Final Addendum §6 — cross-organisation audit search (Amber admin).
  app.use("/api/admin/audit-log", adminAuditLogRoutes);
  // Final Addendum §2 — safeguarding response-text CMS (Amber admin).
  app.use("/api/admin/safeguarding-messages", adminSafeguardingMessagesRoutes);
  // Final Addendum §1 — admin queues dashboard summary + Bull Board
  // link generator. The Bull Board UI itself is mounted further down
  // at /admin/queues (no /api prefix).
  app.use("/api/admin/queues", adminQueuesRoutes);
  // Final Addendum §4 — teacher utilisation analytics.
  app.use("/api/admin/teacher-utilisation", adminTeacherUtilisationRoutes);
  // Final Addendum §12 — cross-platform GLH analytics. Validates
  // the "AI + teacher oversight" funding-model shape (target
  // teacher GLH ratio 10-20% of total).
  app.use("/api/admin/glh-analytics", adminGlhAnalyticsRoutes);
  // Final Addendum §13 — sales-intelligence over the public ROI
  // calculator submission feed. Outstanding-lead backlog +
  // mark-contacted action.
  app.use("/api/admin/sales-intelligence", adminSalesIntelligenceRoutes);
  // Final Addendum §1 — failed-job review dashboard.
  app.use("/api/admin/failed-jobs", adminFailedJobsRoutes);
  // Function 17 — Stage 5 RARPA review (learner self-assessment).
  app.use("/api/esol/stage5", stage5Routes);
  // Function 17 — Stage 5 RARPA review (org-admin confirmation).
  app.use("/api/org-admin/stage5", orgAdminStage5Routes);
  // Final Addendum §9 — teacher route group. Auth chain
  // (isAuthenticated + requireTeacherRole + requireTeacherContext)
  // applied inside the router; controllers stubbed pending
  // Todos 22.3-22.7 + Phase 23/24.
  app.use("/api/teacher", teacherRoutes);
  // Final Addendum §4 — teacher assignment management.
  app.use("/api/org-admin/teachers", orgAdminTeachersRoutes);
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
  // Final Addendum §11 — learner-facing messages endpoints.
  // GET /api/esol/messages/unread powers the learner dashboard's
  // unread banner; see esolMessages.routes.ts.
  app.use("/api/esol/messages", esolMessagesRoutes);
  app.use("/api/esol/teacher-matches", esolMatchingRoutes);
  app.use("/api/esol/verify-token", esolVerifyTokenRoutes);
  app.use("/api/esol/register", esolRegisterRoutes);
  app.use("/api/esol/declare-eligibility", esolEligibilityRoutes);
  app.use("/api/esol/uln", esolUlnRoutes);
  app.use("/api/org-admin/import", orgAdminImportRoutes);
  app.use("/api/esol/placement", placementRoutes);
  app.use("/api/admin/calibration", calibrationRoutes);
  app.use("/api/esol/session", aiSessionRoutes);

  // Final Addendum §13 — public ROI calculator submission endpoint.
  // NO AUTH. Rate-limited at 20/IP/hr (see src/config/rateLimiter).
  // Anything under /api/public/* must be safe to expose without
  // a JWT — this is the only such mount today.
  app.use("/api/public/roi-calculator", publicRoiCalculatorRoutes);

  // ── Bull Board admin UI ──────────────────────────────────────────────
  // Three gates in order: JWT, admin role, defence-in-depth token header.
  // Mounted outside /api on purpose — it's an admin tool, not a public API.
  const bullBoardAdapter = createBullBoardAdapter();
  app.use(
    "/admin/queues",
    isAuthenticated,
    isAdmin,
    requireBullBoardToken,
    bullBoardAdapter.getRouter(),
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
        "Inline worker startup failed — server will continue without workers",
      );
    }
  }

  // ── Use server.listen instead of app.listen for Socket.IO ──
  // Bind IPv4 wildcard explicitly: Node's default is the IPv6 wildcard
  // ("::"), which some hosts' proxies (Render) cannot reach over IPv4 —
  // the port scan sees the socket, the health probe times out, and the
  // deploy is marked failed although the app is healthy.
  // Render's Node guidance: keep-alive and header timeouts above the
  // proxy's own, so the edge never sees us drop a reused connection.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;
  server.listen(PORT, "0.0.0.0", () => {
    logger.info({ port: PORT, host: "0.0.0.0" }, "Server listening");
    // Self-probe over IPv4 loopback so the deploy log itself shows
    // whether the process answers HTTP where the host's proxy connects.
    httpGet(`http://127.0.0.1:${PORT}/api/health`, (res) => {
      logger.info(
        { status: res.statusCode },
        "Self probe /api/health answered",
      );
      res.resume();
    }).on("error", (err) =>
      logger.error({ err: err.message }, "Self probe /api/health FAILED"),
    );
  });
})();
