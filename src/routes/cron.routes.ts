import { Router } from "express";
import { cronCompleteLessons } from "../controllers/cron.controller";

const router = Router();

// GET /api/cron/complete-lessons
// Called by Vercel Cron Jobs — protected by CRON_SECRET, not user auth
router.get("/complete-lessons", cronCompleteLessons);

export default router;
