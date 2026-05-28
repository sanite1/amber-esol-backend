import { Router } from "express";
import {
  cronCompleteLessons,
  cronGenerateInvoices,
  cronCheckProgression,
  cronPostcodeRefreshAlert,
  cronFalaRefresh,
  cronPriorityQueue,
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

export default router;
