import { Request, Response, NextFunction } from "express";
import {
  createTicketService,
  getMyTicketsService,
  userReplyTicketService,
  getAdminTicketsService,
  adminReplyTicketService,
  adminUpdateTicketStatusService,
  adminUpdateTicketPriorityService,
} from "../services/ticket.service";
import { IAdminTicketsQuery } from "../interfaces/ticket.interface";

/* ── POST /api/tickets (user creates ticket) ── */
export const createTicket = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id;
    const result = await createTicketService(userId, req.body);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

/* ── GET /api/tickets/my (user's tickets) ── */
export const getMyTickets = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id;
    const result = await getMyTicketsService(userId, req.query as any);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

/* ── POST /api/tickets/:id/reply (user replies) ── */
export const userReplyTicket = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const userId = (req as any).user?.id;
    const result = await userReplyTicketService(
      userId,
      req.params.id,
      req.body
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

/* ── GET /api/tickets/admin (admin lists all) ── */
export const getAdminTickets = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await getAdminTicketsService(
      req.query as unknown as IAdminTicketsQuery
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

/* ── POST /api/tickets/admin/:id/reply (admin replies) ── */
export const adminReplyTicket = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const adminId = (req as any).user?.id;
    const result = await adminReplyTicketService(
      adminId,
      req.params.id,
      req.body
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

/* ── PATCH /api/tickets/admin/:id/status ── */
export const adminUpdateTicketStatus = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await adminUpdateTicketStatusService(
      req.params.id,
      req.body
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};

/* ── PATCH /api/tickets/admin/:id/priority ── */
export const adminUpdateTicketPriority = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const result = await adminUpdateTicketPriorityService(
      req.params.id,
      req.body
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    next(error);
  }
};
