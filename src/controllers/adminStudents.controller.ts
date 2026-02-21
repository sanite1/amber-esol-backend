import { Request, Response, NextFunction } from "express";
import {
  getAdminStudentsService,
  adminUpdateStudentStatusService,
} from "../services/adminStudents.service";
import {
  IAdminStudentsQuery,
  IAdminUpdateStudentStatusRequest,
} from "../interfaces/adminStudents.interface";

/* ── GET /api/admin-students ── */

export const getAdminStudents = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await getAdminStudentsService(
      req.query as unknown as IAdminStudentsQuery
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

/* ── PATCH /api/admin-students/:id/status ── */

export const updateStudentStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await adminUpdateStudentStatusService(
      req.params.id,
      req.body as IAdminUpdateStudentStatusRequest
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};
