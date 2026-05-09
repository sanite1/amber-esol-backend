import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import { requireEsolLearner } from "../middlewares/orgScopingMiddleware";
import {
  createSessionValidation,
  listSessionsValidation,
  sessionIdParamValidation,
  submitTurnValidation,
  joinSessionValidation,
} from "../validations/esolAISession.validation";
import {
  createSession,
  listSessions,
  getSession,
  submitTurn,
  completeSession,
  getTeacherPrep,
  generateSessionToken,
  joinSession,
} from "../controllers/esolAISession.controller";
import { NextFunction, Request, Response } from "express";
import { IUserDecoded } from "../middlewares/authMiddleWare";
import ApiError from "../errors/apiError";

// Allows tutor, org_admin, or platform admin (anyone who can create / manage sessions)
const isSessionManager = (
  req: Request & { user?: IUserDecoded },
  _res: Response,
  next: NextFunction
) => {
  const role = req.user?.role;
  if (role === "tutor" || role === "org_admin" || role === "admin") {
    return next();
  }
  return next(new ApiError(403, "Session management access required"));
};

const router = Router();

router.use(isAuthenticated);

// Create session (teacher | org_admin | admin)
router.post("/", isSessionManager, createSessionValidation(), createSession);

// List sessions — every authenticated role; service filters by role
router.get("/", listSessionsValidation(), listSessions);

// Learner joins a session via one-time access token
router.post(
  "/join",
  requireEsolLearner,
  joinSessionValidation(),
  joinSession
);

// Get a single session (admin / teacher / org_admin / learner — service authorises)
router.get("/:sessionId", sessionIdParamValidation(), getSession);

// Submit a learner turn — runs the 5-stage pipeline
router.post(
  "/:sessionId/turns",
  requireEsolLearner,
  submitTurnValidation(),
  submitTurn
);

// Complete a session
router.patch(
  "/:sessionId/complete",
  isSessionManager,
  sessionIdParamValidation(),
  completeSession
);

// Teacher prep note (auto-generates on first request)
router.get(
  "/:sessionId/prep",
  isSessionManager,
  sessionIdParamValidation(),
  getTeacherPrep
);

// Generate one-time session access token for the learner
router.post(
  "/:sessionId/access-token",
  isSessionManager,
  sessionIdParamValidation(),
  generateSessionToken
);

export default router;
