import { Router } from "express";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import { requireEsolLearner } from "../middlewares/orgScopingMiddleware";
import {
  sessionIdParamValidation,
  submitLearnerFeedbackValidation,
  submitTeacherFeedbackValidation,
} from "../validations/esolSessionFeedback.validation";
import {
  submitLearnerFeedback,
  submitTeacherFeedback,
  getSessionFeedback,
} from "../controllers/esolSessionFeedback.controller";
import { NextFunction, Request, Response } from "express";
import { IUserDecoded } from "../middlewares/authMiddleWare";
import ApiError from "../errors/apiError";

const isTutor = (
  req: Request & { user?: IUserDecoded },
  _res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "tutor") {
    return next(new ApiError(403, "Tutor access required"));
  }
  next();
};

const router = Router();

router.use(isAuthenticated);

// Get feedback for a session
router.get("/:sessionId", sessionIdParamValidation(), getSessionFeedback);

// Submit learner feedback
router.post(
  "/:sessionId/learner",
  requireEsolLearner,
  submitLearnerFeedbackValidation(),
  submitLearnerFeedback,
);

// Submit teacher feedback
router.post(
  "/:sessionId/teacher",
  isTutor,
  submitTeacherFeedbackValidation(),
  submitTeacherFeedback,
);

export default router;
