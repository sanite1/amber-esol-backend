import { ExpressFunction } from "../interfaces/helper.interface";
import {
  submitLearnerFeedbackService,
  submitTeacherFeedbackService,
  getSessionFeedbackService,
} from "../services/esolSessionFeedback.service";

export const submitLearnerFeedback: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await submitLearnerFeedbackService(
      params.sessionId,
      req.body as any,
      {
        callerId: req.user!.id.toString(),
        callerRole: req.user!.role,
        callerOrgId: req.user!.orgId,
      },
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const submitTeacherFeedback: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await submitTeacherFeedbackService(
      params.sessionId,
      req.body as any,
      {
        callerId: req.user!.id.toString(),
        callerRole: req.user!.role,
        callerOrgId: req.user!.orgId,
      },
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const getSessionFeedback: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await getSessionFeedbackService(params.sessionId, {
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
