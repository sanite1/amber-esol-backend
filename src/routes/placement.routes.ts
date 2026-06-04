import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import {
  requireEsolLearner,
  requireOrgContext,
} from "../middlewares/orgScopingMiddleware";
import {
  startPlacement,
  answerPlacement,
  submitPlacement,
} from "../controllers/placement.controller";

/**
 * Placement assessment routes — brief Function 6 To-Do 2.
 *
 * Auth chain: isAuthenticated + requireEsolLearner. Only an ESOL
 * learner can take their own placement; org admins and tutors don't
 * have a meaningful action here, and the marketplace student path
 * has no placement step.
 *
 * Routes:
 *   POST /api/esol/placement/start   — open or resume an attempt,
 *                                       returns the question to ask.
 *   POST /api/esol/placement/answer  — submit one answer + question_id,
 *                                       returns the next question (or
 *                                       {done: true} when all 20 are in).
 *   POST /api/esol/placement/submit  — finalise after 20 answers; the
 *                                       Gemini scoring worker (To-Do
 *                                       8.3) picks it up from "submitted".
 *
 * `/start` is POST not GET because it has a state-mutating side effect
 * — it creates a PlacementAttempt row on first call.
 */
const router = Router();

router.post("/start", isAuthenticated, requireEsolLearner, startPlacement);
router.post("/answer", isAuthenticated, requireEsolLearner, answerPlacement);
// `/submit` adds requireOrgContext per brief Function 6 To-Do 3 — the
// AuditLog write and the scored-by-Gemini path both need org_id, and
// the scoring service is the right place to enforce it.
router.post(
  "/submit",
  isAuthenticated,
  requireEsolLearner,
  requireOrgContext,
  submitPlacement
);

export default router;
