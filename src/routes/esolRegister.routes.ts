import { Router } from "express";
import { referralTokenLimiter } from "../config/rateLimiter";
import { esolRegisterValidation } from "../validations/esolRegister.validation";
import { esolRegister } from "../controllers/esolRegister.controller";

/**
 * POST /api/esol/register — public, brief Function 2 To-Do 2.
 *
 * No auth required (learner doesn't have an account yet). Rate-limited
 * with referralTokenLimiter (20/hour per IP) — same bucket as
 * verify-token because both endpoints accept the same JWT and would
 * be subject to the same enumeration concerns.
 */
const router = Router();

router.post("/", referralTokenLimiter, esolRegisterValidation(), esolRegister);

export default router;
