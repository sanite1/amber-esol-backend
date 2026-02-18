import { Request, Response, NextFunction } from "express";
import { ExpressFunction } from "../interfaces/helper.interface";
import {
  ISetScheduleRequest,
  IUpdateSettingsRequest,
  ICreateOverrideRequest,
  IAvailableSlotsQuery,
} from "../interfaces/availability.interface";
import {
  getAvailabilityService,
  setScheduleService,
  updateSettingsService,
  createOverrideService,
  deleteOverrideService,
  getAvailableSlotsService,
} from "../services/availability.service";

/* ── Get Availability (public) ── */

export const getAvailability = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { tutorId } = req.params;
    const data = await getAvailabilityService(tutorId);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Set / Replace Weekly Schedule (authenticated tutor) ── */

export const setSchedule: ExpressFunction<ISetScheduleRequest> = async (
  req,
  res,
  next
) => {
  try {
    const tutorId = req.user?.id?.toString();
    if (!tutorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await setScheduleService(tutorId, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Update Booking Settings (authenticated tutor) ── */

export const updateSettings: ExpressFunction<IUpdateSettingsRequest> = async (
  req,
  res,
  next
) => {
  try {
    const tutorId = req.user?.id?.toString();
    if (!tutorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await updateSettingsService(tutorId, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Create Date Override (authenticated tutor) ── */

export const createOverride: ExpressFunction<ICreateOverrideRequest> = async (
  req,
  res,
  next
) => {
  try {
    const tutorId = req.user?.id?.toString();
    if (!tutorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await createOverrideService(tutorId, req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Delete Date Override (authenticated tutor) ── */

export const deleteOverride = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const tutorId = (req as any).user?.id?.toString();
    if (!tutorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await deleteOverrideService(tutorId, req.params.id);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Get Available Slots for a Date (public) ── */

export const getAvailableSlots = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { tutorId } = req.params;
    const query = req.query as unknown as IAvailableSlotsQuery;
    const data = await getAvailableSlotsService(tutorId, query);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
