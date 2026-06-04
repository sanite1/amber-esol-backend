/**
 * Stage 5 org-admin confirmation controller — brief Function 17.
 *
 *   POST /api/org-admin/stage5/:reviewId/confirm
 *
 * Thin adapter — auth at the route layer (isAuthenticated +
 * isOrgAdmin + requireOrgContext). The service does the org-scope
 * check, single-shot guard, and audit-log write.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  confirmStage5ReviewService,
  ConfirmStage5ReviewBody,
} from "../services/stage5Confirm.service";
import { getStage5ForOrgAdminService } from "../services/stage5Read.service";

// GET /api/org-admin/stage5/:reviewId — org-admin-scoped detail
export const getStage5ReviewForOrgAdmin: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const { reviewId } = req.params as { reviewId: string };
    const callerOrgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ?? "";
    const result = await getStage5ForOrgAdminService(reviewId, callerOrgId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const confirmStage5Review: ExpressFunction = async (req, res, next) => {
  try {
    const { reviewId } = req.params as { reviewId: string };
    const callerId = req.user?.id?.toString() ?? "";
    const callerOrgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ?? "";
    const body = (req.body ?? {}) as ConfirmStage5ReviewBody;

    const result = await confirmStage5ReviewService({
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
