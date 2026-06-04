/**
 * Teacher assignment controllers — brief Final Addendum §4.
 *
 * Thin layer: pull caller identity + org from req.user, hand off to
 * the services. The PATCH learner→teacher endpoint lives under
 * /api/org-admin/learners/:learnerId/teacher and is wired into the
 * existing orgAdminLearners router; the other three live under
 * /api/org-admin/teachers in their own router.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listOrgTeachersService,
  addTeacherToOrgService,
  removeTeacherFromOrgService,
  assignTeacherToLearnerService,
  AssignTeacherToLearnerBody,
} from "../services/teacherAssignment.service";

const resolveOrgId = (
  req: Parameters<ExpressFunction>[0],
): string =>
  (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
    ?.org_id ??
  (req.user?.orgId as string | null | undefined) ??
  "";

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/teachers
// ─────────────────────────────────────────────────────────────────────

export const listOrgTeachers: ExpressFunction = async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const result = await listOrgTeachersService(orgId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/org-admin/teachers/:teacherId
// ─────────────────────────────────────────────────────────────────────

export const addTeacherToOrg: ExpressFunction = async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { teacherId } = req.params as { teacherId: string };
    const callerId = req.user!.id.toString();
    const result = await addTeacherToOrgService(orgId, teacherId, callerId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/org-admin/teachers/:teacherId
// ─────────────────────────────────────────────────────────────────────

export const removeTeacherFromOrg: ExpressFunction = async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { teacherId } = req.params as { teacherId: string };
    const callerId = req.user!.id.toString();
    const result = await removeTeacherFromOrgService(orgId, teacherId, callerId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/org-admin/learners/:learnerId/teacher
// ─────────────────────────────────────────────────────────────────────

export const assignTeacherToLearner: ExpressFunction = async (req, res, next) => {
  try {
    const orgId = resolveOrgId(req);
    const { learnerId } = req.params as { learnerId: string };
    const callerId = req.user!.id.toString();
    const result = await assignTeacherToLearnerService(
      orgId,
      learnerId,
      req.body as AssignTeacherToLearnerBody,
      callerId,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
