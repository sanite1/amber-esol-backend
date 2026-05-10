import { Router } from "express";
import { authLimiter } from "../config/rateLimiter";
import { upload } from "../config/upload";
import {
  getPlacementQuestions,
  completeOnboarding,
} from "../controllers/esolOnboarding.controller";

const router = Router();

// Public — get placement questions (no auth required for D1 wizard)
router.get("/placement-questions", authLimiter, getPlacementQuestions);

// Public — complete onboarding (rate-limited, multipart upload)
router.post(
  "/complete",
  authLimiter,
  upload.single("file"),
  completeOnboarding
);

export default router;
