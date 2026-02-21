import { Request, Response, NextFunction } from "express";
import { ExpressFunction } from "../interfaces/helper.interface";
import {
  ICreateBookingRequest,
  ICancelBookingRequest,
  IDeclineBookingRequest,
  IBookingQuery,
  IUpcomingQuery,
  IFlagBookingRequest,
} from "../interfaces/booking.interface";
import {
  createBookingService,
  listBookingsService,
  getBookingByIdService,
  confirmBookingService,
  declineBookingService,
  cancelBookingService,
  completeBookingService,
  noShowBookingService,
  upcomingBookingsService,
  bookingStatsService,
  flagBookingService,
  adminLessonStatsService,
  updateMeetingUrlService,
} from "../services/booking.service";

/* ── Create Booking (student) ── */

export const createBooking: ExpressFunction<ICreateBookingRequest> = async (
  req,
  res,
  next
) => {
  try {
    const studentId = req.user?.id?.toString();
    if (!studentId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await createBookingService(studentId, req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── List Bookings (role-aware) ── */

export const listBookings = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await listBookingsService(
      userId,
      role,
      req.query as unknown as IBookingQuery
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Get Booking By Id ── */

export const getBookingById = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await getBookingByIdService(req.params.id, userId, role);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Confirm Booking (tutor) ── */

export const confirmBooking = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const tutorId = (req as any).user?.id?.toString();
    if (!tutorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await confirmBookingService(req.params.id, tutorId);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Decline Booking (tutor) ── */

export const declineBooking: ExpressFunction<IDeclineBookingRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const tutorId = (req as any).user?.id?.toString();
    if (!tutorId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await declineBookingService(req.params.id, tutorId, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Cancel Booking (student/tutor/admin) ── */

export const cancelBooking: ExpressFunction<ICancelBookingRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId || !role) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await cancelBookingService(
      req.params.id,
      userId,
      role,
      req.body
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Complete Booking (tutor/admin) ── */

export const completeBooking = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await completeBookingService(req.params.id, userId, role);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── No-Show (tutor/admin) ── */

export const noShowBooking = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await noShowBookingService(req.params.id, userId, role);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Upcoming Bookings (dashboard widget) ── */

export const upcomingBookings = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await upcomingBookingsService(
      userId,
      role,
      req.query as unknown as IUpcomingQuery
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Booking Stats ── */

export const bookingStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const data = await bookingStatsService(userId, role);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Flag Booking (admin) ── */

export const flagBooking: ExpressFunction<IFlagBookingRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await flagBookingService(req.params.id, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Admin Lesson Stats ── */

export const adminLessonStats = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const data = await adminLessonStatsService();
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Update Meeting URL (tutor) ── */

export const updateMeetingUrl = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const data = await updateMeetingUrlService(
      req.params.id,
      userId.toString(),
      req.body.meetingUrl
    );
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};
