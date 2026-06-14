/**
 * Learner-self audit log controller — Final Addendum §6 (BE-A).
 *
 * Thin layer: pull learner identity from `req.user` (set by
 * isAuthenticated), hand off to the service. Query params travel
 * unchanged.
 *
 * Auth chain: `isAuthenticated` only. No extra role check needed —
 * the service hardcodes `learner_id = req.user._id`, so even if a
 * non-learner reaches this route they can only see their OWN
 * non-existent learner-scoped events. Defence in depth.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listLearnerAuditLogService,
  LearnerAuditLogQuery,
} from "../services/learnerAuditLog.service";

export const listLearnerAuditLog: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = (req.user?.id ?? req.user?._id ?? "") as string;
    const orgId = (req.user?.orgId ?? null) as string | null;

    const result = await listLearnerAuditLogService(
      learnerId,
      orgId,
      req.query as unknown as LearnerAuditLogQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
