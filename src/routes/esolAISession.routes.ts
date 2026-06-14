import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import { requireEsolLearner } from "../middlewares/orgScopingMiddleware";
import {
  createSessionValidation,
  listSessionsValidation,
  sessionIdParamValidation,
  submitTurnValidation,
} from "../validations/esolAISession.validation";
import {
  createSession,
  listSessions,
  getSession,
  submitTurn,
  completeSession,
  getTeacherPrep,
} from "../controllers/esolAISession.controller";
import { NextFunction, Request, Response } from "express";
import { IUserDecoded } from "../middlewares/authMiddleWare";
import ApiError from "../errors/apiError";

const isSessionManager = (
  req: Request & { user?: IUserDecoded },
  _res: Response,
  next: NextFunction,
) => {
  const role = req.user?.role;
  if (role === "tutor" || role === "org_admin" || role === "admin") {
    return next();
  }
  return next(new ApiError(403, "Session management access required"));
};

const router = Router();

router.use(isAuthenticated);

router.post("/", isSessionManager, createSessionValidation(), createSession);
router.get("/", listSessionsValidation(), listSessions);
router.get("/:sessionId", sessionIdParamValidation(), getSession);
router.post(
  "/:sessionId/turns",
  requireEsolLearner,
  submitTurnValidation(),
  submitTurn,
);
router.patch(
  "/:sessionId/complete",
  isSessionManager,
  sessionIdParamValidation(),
  completeSession,
);
router.get(
  "/:sessionId/prep",
  isSessionManager,
  sessionIdParamValidation(),
  getTeacherPrep,
);

export default router;
