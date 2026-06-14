import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import {
  requireEsolLearner,
  requireOrgContext,
} from "../middlewares/orgScopingMiddleware";
import { aiTurnLimiter, sessionStartLimiter } from "../config/rateLimiter";
import {
  processTurn,
  startSession,
  endSession,
} from "../controllers/aiSession.controller";

/**
 * POST /api/esol/session/turn — brief Function 7 To-Do 5.
 *
 * Middleware chain:
 *   1. isAuthenticated      — populate req.user from JWT
 *   2. requireEsolLearner   — role must be "student" + orgId set;
 *                              ownership of the session is re-checked
 *                              in the service against learnerId on the
 *                              AISession doc
 *   3. requireOrgContext    — populate req.esol_context.org_id
 *   4. aiTurnLimiter        — 30 turns / minute / IP (rateLimiter.ts)
 *   5. processTurn          — controller hands to processTurnService
 *
 * The brief's spec listed only `isAuthenticated + requireOrgContext +
 * aiTurnLimiter`; `requireEsolLearner` is added as defence-in-depth
 * (same rationale as the eligibility / ULN routes from Function 2).
 */
const router = Router();

router.post(
  "/turn",
  isAuthenticated,
  requireEsolLearner,
  requireOrgContext,
  aiTurnLimiter,
  processTurn,
);

/**
 * POST /api/esol/session/start — brief Function 7 To-Do 6.
 *
 * Middleware chain (per brief): isAuthenticated + requireOrgContext +
 * sessionStartLimiter. requireEsolLearner is added defence-in-depth
 * — only ESOL learners can open a session for themselves.
 */
router.post(
  "/start",
  isAuthenticated,
  requireEsolLearner,
  requireOrgContext,
  sessionStartLimiter,
  startSession,
);

/**
 * POST /api/esol/session/end — brief Function 7 To-Do 6.
 *
 * No rate limiter here: ending a session is a low-frequency action
 * and a stuck/restarted learner needs to be able to recover.
 * Idempotency-wrap in the service handles double-submit.
 */
router.post(
  "/end",
  isAuthenticated,
  requireEsolLearner,
  requireOrgContext,
  endSession,
);

export default router;
