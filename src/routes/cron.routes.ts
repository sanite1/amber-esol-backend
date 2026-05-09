import { Router } from "express";
import {
  cronCompleteLessons,
  cronGenerateInvoices,
  cronCheckProgression,
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

export default router;
