import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import {
  listEsolTeachersService,
  approveTeacherService,
  updateTeacherQualificationsService,
  revokeTeacherApprovalService,
  applyEsolTeacherService,
  rejectEsolTeacherService,
} from "../services/esolTeacher.service";

export const listEsolTeachers: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listEsolTeachersService(req.query as any);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const approveTeacher: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await approveTeacherService(params.tutorId, req.body as any);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const updateTeacherQualifications: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await updateTeacherQualificationsService(
      params.tutorId,
      req.user!.id.toString(),
      req.user!.role,
      req.body as any,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const revokeTeacherApproval: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await revokeTeacherApprovalService(params.tutorId);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Tutor self-application: POST /api/esol/teachers/apply ───────── */

export const applyEsolTeacher: ExpressFunction = async (req, res, next) => {
  try {
    const callerId = req.user?.id?.toString();
    if (!callerId) {
      return next(new ApiError(401, "Unauthorized"));
    }
    if (req.user?.role !== "tutor") {
      return next(
        new ApiError(403, "Only tutors can apply for ESOL teacher status"),
      );
    }
    const data = await applyEsolTeacherService(callerId, req.body as any);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Admin approve via /api/admin/users/:id/approve-esol-teacher ── */

export const adminApproveEsolTeacher: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const body = (req.body || {}) as { notes?: string };
    const data = await approveTeacherService(params.id, {
      esolTeacherNotes: body.notes,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Admin reject via /api/admin/users/:id/reject-esol-teacher ──── */

export const adminRejectEsolTeacher: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const body = req.body as { reason: string };
    const data = await rejectEsolTeacherService(params.id, body.reason);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
