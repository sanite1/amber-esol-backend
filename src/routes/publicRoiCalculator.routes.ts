/**
 * Public ROI calculator routes — Final Addendum §13.
 *
 * Mounted at `/api/public/roi-calculator` in src/index.ts.
 *
 * NO AUTH. The only friction against abuse is the per-IP rate
 * limiter (20 per hour, Redis-backed, fleet-wide). Anything
 * mounted under `/api/public/*` MUST be safe to expose without
 * a JWT — this is the only such mount today.
 */

import { Router } from "express";
import { submitRoiCalculator } from "../controllers/roiCalculatorSubmit.controller";
import { submitRoiCalculatorValidation } from "../validations/roiCalculatorSubmit.validation";
import { roiCalculatorLimiter } from "../config/rateLimiter";

const router = Router();

// POST /api/public/roi-calculator/submit
router.post(
  "/submit",
  roiCalculatorLimiter,
  submitRoiCalculatorValidation(),
  submitRoiCalculator,
);

export default router;
