import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listEsolTeachersService,
  approveTeacherService,
  updateTeacherQualificationsService,
  revokeTeacherApprovalService,
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
  next
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await updateTeacherQualificationsService(
      params.tutorId,
      req.user!.id.toString(),
      req.user!.role,
      req.body as any
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const revokeTeacherApproval: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await revokeTeacherApprovalService(params.tutorId);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
