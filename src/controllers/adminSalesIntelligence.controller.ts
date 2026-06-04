/**
 * Amber-admin sales-intelligence controller — Final Addendum §13.
 *
 *   GET   /api/admin/sales-intelligence/roi-submissions
 *   PATCH /api/admin/sales-intelligence/roi-submissions/:id/contacted
 *
 * Thin adapters. Auth + role gate live at the route layer
 * (isAuthenticated + isAdmin).
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listRoiSubmissionsService,
  ListRoiSubmissionsQuery,
  markRoiSubmissionContactedService,
} from "../services/adminSalesIntelligence.service";

const readAdminId = (req: Parameters<ExpressFunction>[0]): string => {
  const userAny = req.user as { id?: string; _id?: string } | undefined;
  return userAny?._id ?? userAny?.id ?? "";
};

export const listRoiSubmissions: ExpressFunction = async (req, res, next) => {
  try {
    const result = await listRoiSubmissionsService(
      req.query as unknown as ListRoiSubmissionsQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const markRoiSubmissionContacted: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const { id } = req.params as { id: string };
    const result = await markRoiSubmissionContactedService({
      submission_id: id,
      admin_user_id: readAdminId(req),
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
