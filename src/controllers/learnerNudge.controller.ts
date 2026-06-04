/**
 * Learner-nudge controller — brief Function 12 To-Do 4.
 *
 * Thin layer: pull learner id from the path, caller identity + org
 * from req.user, body from req.body, hand off to the service.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  sendLearnerNudgeService,
  NudgeLearnerBody,
} from "../services/learnerNudge.service";

export const nudgeLearner: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const callerId = req.user!.id.toString();
    const result = await sendLearnerNudgeService(
      id,
      req.user!.role,
      req.user!.orgId,
      callerId,
      req.body as NudgeLearnerBody
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
