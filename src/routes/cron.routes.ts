import { Router } from "express";
import {
  cronCompleteLessons,
  cronGenerateInvoices,
  cronCheckProgression,
  cronPostcodeRefreshAlert,
  cronFalaRefresh,
  cronPriorityQueue,
  cronResetDemoEnvironment,
  cronDeltaSync,
  cronReEngagement,
} from "../controllers/cron.controller";
import { isCronAuthorized } from "../middlewares/authMiddleWare";

const router = Router();

// GET /api/cron/complete-lessons
// Called by Vercel Cron Jobs — protected by CRON_SECRET, not user auth
router.get("/complete-lessons", isCronAuthorized, cronCompleteLessons);

// GET /api/cron/generate-invoices — monthly invoice auto-generation
router.get("/generate-invoices", isCronAuthorized, cronGenerateInvoices);

// GET /api/cron/check-progression — daily learner progression check
router.get("/check-progression", isCronAuthorized, cronCheckProgression);

// GET /api/cron/priority-queue — daily teacher priority scoring (Phase 23)
router.get("/priority-queue", isCronAuthorized, cronPriorityQueue);

// GET /api/cron/fala-refresh — monthly FALA whitelist refresh
router.get("/fala-refresh", isCronAuthorized, cronFalaRefresh);

// GET /api/cron/postcode-refresh-alert — annual reminder (1 Aug) for the new DfE postcode file
router.get("/postcode-refresh-alert", isCronAuthorized, cronPostcodeRefreshAlert);

// GET /api/cron/reset-demo-environment — daily 03:00 UTC, demo deployment only.
// Note: the handler itself enforces both DEMO_MODE and CRON_SECRET, in
// that order (DEMO_MODE first so a mis-deployed prod cron with a valid
// secret still refuses). No isCronAuthorized middleware here — the
// controller manages the gate ordering explicitly.
router.get("/reset-demo-environment", cronResetDemoEnvironment);

// GET /api/cron/delta-sync — daily 04:00 UTC, MIS reconciliation
// (Final Addendum §7). Fans out one delta-sync job per org with
// misType !== "none" AND billing_active: true.
router.get("/delta-sync", isCronAuthorized, cronDeltaSync);

// GET /api/cron/re-engagement — weekdays 09:00 UTC, dormant-learner
// re-engagement sweep (Final Addendum §11). Auto-sends a templated
// "checking in" message on each eligible teacher's behalf; capped
// at 50 messages per run; honours per-teacher opt-out.
router.get("/re-engagement", isCronAuthorized, cronReEngagement);

export default router;
