/**
 * Org-admin surfaces of the matching service.
 *
 *   GET  /api/org-admin/learners/:id/teacher-matches
 *   POST /api/org-admin/teachers/auto-assign
 *
 * Thin layer: pull caller identity + org from req.user / esol_context
 * (same convention as teacherAssignment.controller) and hand off.
 */
import { ExpressFunction } from "../interfaces/helper.interface";
import {
  rankTeachersForLearner,
  autoAssignUnassignedForOrg,
} from "../services/teacherMatching.service";

const resolveOrgId = (req: Parameters<ExpressFunction>[0]): string =>
  (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
    ?.org_id ??
  (req.user?.orgId as string | null | undefined) ??
  "";

export const getTeacherMatchesForLearner: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const result = await rankTeachersForLearner(resolveOrgId(req), params.id);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const autoAssignUnassigned: ExpressFunction = async (req, res, next) => {
  try {
    const result = await autoAssignUnassignedForOrg(
      resolveOrgId(req),
      req.user!.id.toString(),
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
