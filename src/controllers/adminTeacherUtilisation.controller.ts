/**
 * Amber-admin teacher utilisation controllers — Final Addendum §4.
 *
 *   GET /api/admin/teacher-utilisation              getTeacherUtilisation
 *   GET /api/admin/teacher-utilisation/:teacherId/history
 *                                                  getTeacherHistory
 *
 * Thin adapters — auth at the route layer, work in the service.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getTeacherUtilisationService,
  getTeacherHistoryService,
} from "../services/adminTeacherUtilisation.service";

export const getTeacherUtilisation: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const orgId = (req.query as Record<string, unknown>).org_id as
      | string
      | undefined;
    const result = await getTeacherUtilisationService(orgId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const getTeacherHistory: ExpressFunction = async (req, res, next) => {
  try {
    const { teacherId } = req.params as { teacherId: string };
    const rawLimit = (req.query as Record<string, unknown>).limit;
    const limit =
      typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : undefined;
    const result = await getTeacherHistoryService(
      teacherId,
      Number.isFinite(limit) ? (limit as number) : undefined,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
