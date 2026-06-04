import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import {
  getOrStartAttempt,
  submitAnswer,
  scorePlacement,
} from "../services/placement.service";

/**
 * GET /api/esol/placement/start  — open or resume an attempt, return first question.
 * POST /api/esol/placement/answer — record one answer, return next question.
 * POST /api/esol/placement/submit — finalise after 20 answers, hand off to scorer.
 *
 * The user's prompt asked for two routes (answer + submit). `start` is
 * added so the wizard has somewhere to get the first question_id from
 * — overloading `/answer` with "if body empty, start" would mean the
 * answer endpoint silently changes semantics. Three explicit routes is
 * the smaller maintenance surface.
 */

export const startPlacement: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) return next(new ApiError(401, "Unauthorized"));
    const orgId = req.user?.orgId ? String(req.user.orgId) : null;
    const data = await getOrStartAttempt(learnerId, orgId);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

export const answerPlacement: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) return next(new ApiError(401, "Unauthorized"));
    const body = req.body as { question_id: string; answer: string };
    const data = await submitAnswer(learnerId, body);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

export const submitPlacement: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) return next(new ApiError(401, "Unauthorized"));
    const body = req.body as {
      answers: { question_id: string; answer: string }[];
    };
    const data = await scorePlacement(learnerId, body);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
