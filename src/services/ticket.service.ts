import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Ticket from "../models/Ticket";
import User from "../models/User";
import {
  IAdminTicketsQuery,
  ICreateTicketRequest,
  IReplyTicketRequest,
  IUpdateTicketStatusRequest,
  IUpdateTicketPriorityRequest,
  TicketStatus,
} from "../interfaces/ticket.interface";
import { createNotification } from "./notification.service";
import logger from "../config/logger";

/* ══════════════════════════════════════════════
   CREATE TICKET (student / tutor)
   ══════════════════════════════════════════════ */

export const createTicketService = async (
  userId: string,
  data: ICreateTicketRequest,
) => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found");
  if (user.role !== "student" && user.role !== "tutor") {
    throw new ApiError(400, "Only students and tutors can create tickets");
  }

  const ticket = await Ticket.create({
    subject: data.subject,
    category: data.category,
    priority: data.priority || "medium",
    status: "open",
    submitterId: user._id,
    submitterName: `${user.firstname} ${user.lastname}`,
    submitterEmail: user.email,
    submitterType: user.role as "student" | "tutor",
    relatedLessonId: data.relatedLessonId
      ? new Types.ObjectId(data.relatedLessonId)
      : undefined,
    relatedTutorId: data.relatedTutorId
      ? new Types.ObjectId(data.relatedTutorId)
      : undefined,
    relatedStudentId: data.relatedStudentId
      ? new Types.ObjectId(data.relatedStudentId)
      : undefined,
    messages: [
      {
        senderId: user._id,
        senderName: `${user.firstname} ${user.lastname}`,
        senderType: user.role,
        message: data.message,
        createdAt: new Date(),
      },
    ],
  });

  return new ApiResponse(201, "Ticket created successfully", ticket.toJSON());
};

/* ══════════════════════════════════════════════
   GET MY TICKETS (student / tutor)
   ══════════════════════════════════════════════ */

export const getMyTicketsService = async (
  userId: string,
  query: { page?: string; limit?: string; status?: string },
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  const filter: any = { submitterId: new Types.ObjectId(userId) };
  if (query.status && query.status !== "all") {
    filter.status = query.status;
  }

  const [tickets, total] = await Promise.all([
    Ticket.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    Ticket.countDocuments(filter),
  ]);

  return new ApiResponse(200, "Tickets retrieved successfully", {
    tickets,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ══════════════════════════════════════════════
   USER REPLY TO TICKET
   ══════════════════════════════════════════════ */

export const userReplyTicketService = async (
  userId: string,
  ticketId: string,
  data: IReplyTicketRequest,
) => {
  const user = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found");

  const ticket = await Ticket.findOne({
    _id: ticketId,
    submitterId: new Types.ObjectId(userId),
  });
  if (!ticket) throw new ApiError(404, "Ticket not found");

  if (ticket.status === "closed") {
    throw new ApiError(400, "Cannot reply to a closed ticket");
  }

  ticket.messages.push({
    senderId: user._id,
    senderName: `${user.firstname} ${user.lastname}`,
    senderType: user.role as "student" | "tutor",
    message: data.message,
    createdAt: new Date(),
  });

  // If ticket was awaiting_user, move to in_progress
  if (ticket.status === "awaiting_user") {
    ticket.status = "in_progress";
  }

  await ticket.save();

  return new ApiResponse(200, "Reply sent successfully", ticket.toJSON());
};

/* ══════════════════════════════════════════════
   ADMIN: GET ALL TICKETS (with stats)
   ══════════════════════════════════════════════ */

export const getAdminTicketsService = async (query: IAdminTicketsQuery) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "8", 10);
  const skip = (page - 1) * limit;

  /* ── Filter ── */
  const filter: any = {};

  if (query.status && query.status !== "all") {
    filter.status = query.status;
  }
  if (query.category && query.category !== "all") {
    filter.category = query.category;
  }
  if (query.priority && query.priority !== "all") {
    filter.priority = query.priority;
  }
  if (query.submitterType && query.submitterType !== "all") {
    filter.submitterType = query.submitterType;
  }
  if (query.search && query.search.trim()) {
    const q = new RegExp(query.search.trim(), "i");
    filter.$or = [
      { subject: q },
      { submitterName: q },
      { submitterEmail: q },
      { "messages.message": q },
    ];
  }

  /* ── Sort ── */
  let sortOption: any = { createdAt: -1 };
  switch (query.sort) {
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "priority_high":
      // Sort by priority weight then by date
      sortOption = { _priorityWeight: 1, createdAt: -1 };
      break;
    case "last_updated":
      sortOption = { updatedAt: -1 };
      break;
    default:
      sortOption = { createdAt: -1 };
  }

  /* ── Stats (parallel) ── */
  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay() + 1);
  startOfWeek.setHours(0, 0, 0, 0);

  const [
    totalTickets,
    openTickets,
    inProgressTickets,
    awaitingUserTickets,
    resolvedTickets,
    closedTickets,
    urgentTickets,
    studentTickets,
    tutorTickets,
    ticketsThisWeek,
    resolvedWithTimes,
  ] = await Promise.all([
    Ticket.countDocuments(),
    Ticket.countDocuments({ status: "open" }),
    Ticket.countDocuments({ status: "in_progress" }),
    Ticket.countDocuments({ status: "awaiting_user" }),
    Ticket.countDocuments({ status: "resolved" }),
    Ticket.countDocuments({ status: "closed" }),
    Ticket.countDocuments({
      priority: "urgent",
      status: { $nin: ["resolved", "closed"] },
    }),
    Ticket.countDocuments({ submitterType: "student" }),
    Ticket.countDocuments({ submitterType: "tutor" }),
    Ticket.countDocuments({ createdAt: { $gte: startOfWeek } }),
    // For avg response/resolution times: sample resolved tickets
    Ticket.find({ resolvedAt: { $exists: true } })
      .select("createdAt resolvedAt messages")
      .sort({ resolvedAt: -1 })
      .limit(50)
      .lean(),
  ]);

  // Calculate average response time (time from ticket creation to first admin reply)
  // and average resolution time
  let totalResponseMs = 0;
  let responseCount = 0;
  let totalResolutionMs = 0;
  let resolutionCount = 0;

  for (const t of resolvedWithTimes) {
    // First admin reply
    const firstAdminMsg = t.messages.find((m: any) => m.senderType === "admin");
    if (firstAdminMsg) {
      totalResponseMs +=
        new Date(firstAdminMsg.createdAt).getTime() -
        new Date(t.createdAt).getTime();
      responseCount++;
    }
    if (t.resolvedAt) {
      totalResolutionMs +=
        new Date(t.resolvedAt).getTime() - new Date(t.createdAt).getTime();
      resolutionCount++;
    }
  }

  const avgResponseTimeHours =
    responseCount > 0
      ? Math.round((totalResponseMs / responseCount / 3600000) * 10) / 10
      : 0;
  const avgResolutionTimeHours =
    resolutionCount > 0
      ? Math.round((totalResolutionMs / resolutionCount / 3600000) * 10) / 10
      : 0;

  const stats = {
    totalTickets,
    openTickets,
    inProgressTickets,
    awaitingUserTickets,
    resolvedTickets,
    closedTickets,
    avgResponseTimeHours,
    avgResolutionTimeHours,
    ticketsThisWeek,
    studentTickets,
    tutorTickets,
    urgentTickets,
  };

  /* ── Fetch tickets ── */
  // For priority sort, we need an aggregation pipeline
  let tickets: any[];
  let filteredTotal: number;

  if (query.sort === "priority_high") {
    const priorityWeight: Record<string, number> = {
      urgent: 0,
      high: 1,
      medium: 2,
      low: 3,
    };

    const pipeline: any[] = [
      { $match: filter },
      {
        $addFields: {
          _priorityWeight: {
            $switch: {
              branches: [
                { case: { $eq: ["$priority", "urgent"] }, then: 0 },
                { case: { $eq: ["$priority", "high"] }, then: 1 },
                { case: { $eq: ["$priority", "medium"] }, then: 2 },
                { case: { $eq: ["$priority", "low"] }, then: 3 },
              ],
              default: 4,
            },
          },
        },
      },
      { $sort: { _priorityWeight: 1, createdAt: -1 } },
    ];

    const countResult = await Ticket.aggregate([
      ...pipeline,
      { $count: "total" },
    ]);
    filteredTotal = countResult.length > 0 ? countResult[0].total : 0;

    tickets = await Ticket.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: limit },
      { $project: { _priorityWeight: 0, __v: 0 } },
    ]);
  } else {
    [tickets, filteredTotal] = await Promise.all([
      Ticket.find(filter).sort(sortOption).skip(skip).limit(limit).lean(),
      Ticket.countDocuments(filter),
    ]);
  }

  // Map to frontend shape
  const mappedTickets = tickets.map((t: any) => ({
    id: (t._id || t.id).toString(),
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    submitterId: t.submitterId.toString(),
    submitterName: t.submitterName,
    submitterEmail: t.submitterEmail,
    submitterType: t.submitterType,
    assignedTo: t.assignedTo || undefined,
    relatedLessonId: t.relatedLessonId?.toString() || undefined,
    relatedTutorId: t.relatedTutorId?.toString() || undefined,
    relatedStudentId: t.relatedStudentId?.toString() || undefined,
    messages: (t.messages || []).map((m: any) => ({
      id: (m._id || m.id || "").toString(),
      senderId: m.senderId.toString(),
      senderName: m.senderName,
      senderType: m.senderType,
      message: m.message,
      createdAt:
        m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
      attachments: m.attachments || [],
    })),
    createdAt:
      t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
    updatedAt:
      t.updatedAt instanceof Date ? t.updatedAt.toISOString() : t.updatedAt,
    resolvedAt: t.resolvedAt
      ? t.resolvedAt instanceof Date
        ? t.resolvedAt.toISOString()
        : t.resolvedAt
      : undefined,
  }));

  return new ApiResponse(200, "Admin tickets retrieved successfully", {
    stats,
    tickets: mappedTickets,
    pagination: {
      page,
      limit,
      total: filteredTotal,
      totalPages: Math.ceil(filteredTotal / limit),
    },
  });
};

/* ══════════════════════════════════════════════
   ADMIN: REPLY TO TICKET
   ══════════════════════════════════════════════ */

export const adminReplyTicketService = async (
  adminId: string,
  ticketId: string,
  data: IReplyTicketRequest,
) => {
  const admin = await User.findById(adminId);
  if (!admin) throw new ApiError(404, "Admin not found");

  const ticket = await Ticket.findById(ticketId);
  if (!ticket) throw new ApiError(404, "Ticket not found");

  ticket.messages.push({
    senderId: admin._id,
    senderName: `${admin.firstname} ${admin.lastname}`,
    senderType: "admin",
    message: data.message,
    createdAt: new Date(),
  });

  // Auto-update status from open → in_progress
  if (ticket.status === "open") {
    ticket.status = "in_progress";
  }

  ticket.assignedTo = `${admin.firstname} ${admin.lastname}`;
  await ticket.save();

  // Notify the ticket submitter
  createNotification({
    userId: ticket.submitterId,
    type: "system",
    title: "New reply on your support ticket",
    message: `An admin replied to your ticket: "${ticket.subject}"`,
    data: {
      ticketId: ticket._id.toString(),
      subject: ticket.subject,
    },
  }).catch((err) =>
    logger.error({ err }, "Error creating ticket notification"),
  );

  return new ApiResponse(200, "Reply sent successfully", ticket.toJSON());
};

/* ══════════════════════════════════════════════
   ADMIN: UPDATE TICKET STATUS
   ══════════════════════════════════════════════ */

export const adminUpdateTicketStatusService = async (
  ticketId: string,
  data: IUpdateTicketStatusRequest,
) => {
  const ticket = await Ticket.findById(ticketId);
  if (!ticket) throw new ApiError(404, "Ticket not found");

  const oldStatus = ticket.status;
  ticket.status = data.status;

  if (data.status === "resolved" && !ticket.resolvedAt) {
    ticket.resolvedAt = new Date();
  }
  if (data.status === "closed" && !ticket.resolvedAt) {
    ticket.resolvedAt = new Date();
  }
  // If reopening, clear resolvedAt
  if (
    data.status === "open" &&
    (oldStatus === "resolved" || oldStatus === "closed")
  ) {
    ticket.resolvedAt = undefined;
  }

  await ticket.save();

  // Notify submitter of status change
  if (data.status === "resolved" || data.status === "closed") {
    createNotification({
      userId: ticket.submitterId,
      type: "system",
      title: `Support ticket ${data.status}`,
      message: `Your ticket "${ticket.subject}" has been ${data.status}.`,
      data: {
        ticketId: ticket._id.toString(),
        subject: ticket.subject,
        newStatus: data.status,
      },
    }).catch((err) =>
      logger.error({ err }, "Error creating status notification"),
    );
  }

  return new ApiResponse(200, "Ticket status updated successfully", {
    id: ticket._id.toString(),
    status: ticket.status,
    resolvedAt: ticket.resolvedAt?.toISOString() || undefined,
  });
};

/* ══════════════════════════════════════════════
   ADMIN: UPDATE TICKET PRIORITY
   ══════════════════════════════════════════════ */

export const adminUpdateTicketPriorityService = async (
  ticketId: string,
  data: IUpdateTicketPriorityRequest,
) => {
  const ticket = await Ticket.findById(ticketId);
  if (!ticket) throw new ApiError(404, "Ticket not found");

  ticket.priority = data.priority;
  await ticket.save();

  return new ApiResponse(200, "Ticket priority updated successfully", {
    id: ticket._id.toString(),
    priority: ticket.priority,
  });
};
