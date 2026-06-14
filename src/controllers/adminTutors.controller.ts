import { Request, Response, NextFunction } from "express";
import {
  getAdminTutorsService,
  adminUpdateTutorStatusService,
} from "../services/adminTutors.service";
import {
  IAdminTutorsQuery,
  IAdminUpdateTutorStatusRequest,
} from "../interfaces/adminTutors.interface";

/* ── GET /api/admin-tutors ── */

export const getAdminTutors = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await getAdminTutorsService(
      req.query as unknown as IAdminTutorsQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

/* ── PATCH /api/admin-tutors/:id/status ── */

export const updateTutorStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await adminUpdateTutorStatusService(
      req.params.id,
      req.body as IAdminUpdateTutorStatusRequest,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};
