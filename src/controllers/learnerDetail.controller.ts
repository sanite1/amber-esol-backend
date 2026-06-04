/**
 * Org-admin learner-detail controller — brief Function 12 To-Do 2.
 *
 * Thin layer: pull the learner id from the path, caller role + org
 * from req.user, query params for pagination. The service holds the
 * critical access-control check.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getLearnerDetailService,
  LearnerDetailQuery,
} from "../services/learnerDetail.service";

export const getOrgAdminLearnerDetail: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    const { id } = req.params as { id: string };
    const result = await getLearnerDetailService(
      id,
      req.user!.role,
      req.user!.orgId,
      req.query as unknown as LearnerDetailQuery
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
