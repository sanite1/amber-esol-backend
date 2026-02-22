import { Router } from "express";
import { cronCompleteLessons } from "../controllers/cron.controller";
import { isCronAuthorized } from "../middlewares/authMiddleWare";

const router = Router();

// GET /api/cron/complete-lessons
// Called by Vercel Cron Jobs — protected by CRON_SECRET, not user auth
router.get("/complete-lessons", isCronAuthorized, cronCompleteLessons);

export default router;
