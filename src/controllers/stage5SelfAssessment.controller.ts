/**
 * Stage 5 learner self-assessment controller — brief Function 17.
 *
 *   POST /api/esol/stage5/:reviewId/self-assessment
 *
 * Thin adapter — auth at the route layer, validation via Joi, and
 * the service does the privacy + single-shot guards. Critically,
 * the controller passes `req.user.id` to the service so the
 * "caller is the learner" check happens on the JWT-bound identity,
 * not on anything the body might claim.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  submitStage5SelfAssessmentService,
  SubmitStage5SelfAssessmentBody,
} from "../services/stage5SelfAssessment.service";
import {
  getPendingStage5ForLearnerService,
  getStage5ForLearnerService,
} from "../services/stage5Read.service";

// GET /api/esol/stage5/pending — learner's open reviews
export const listPendingStage5: ExpressFunction = async (req, res, next) => {
  try {
    const callerId = req.user?.id?.toString() ?? "";
    const result = await getPendingStage5ForLearnerService(callerId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/esol/stage5/:reviewId — learner-scoped detail
export const getStage5Review: ExpressFunction = async (req, res, next) => {
  try {
    const { reviewId } = req.params as { reviewId: string };
    const callerId = req.user?.id?.toString() ?? "";
    const result = await getStage5ForLearnerService(reviewId, callerId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const submitStage5SelfAssessment: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const { reviewId } = req.params as { reviewId: string };
    const callerId = req.user?.id?.toString() ?? "";
    const callerOrgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ?? "";
    const body = (req.body ?? {}) as SubmitStage5SelfAssessmentBody;

    const result = await submitStage5SelfAssessmentService({
      review_id: reviewId,
      caller_id: callerId,
      caller_org_id: callerOrgId,
      body,
      req,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
