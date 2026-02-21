import { Types, Document } from "mongoose";

/* ── Enums ── */

export type TicketCategory =
  | "billing"
  | "technical"
  | "lesson_issue"
  | "account"
  | "report"
  | "other";

export type TicketPriority = "low" | "medium" | "high" | "urgent";

export type TicketStatus =
  | "open"
  | "in_progress"
  | "awaiting_user"
  | "resolved"
  | "closed";

export type TicketSenderType = "student" | "tutor" | "admin";

/* ── Sub-documents ── */

export interface ITicketAttachment {
  name: string;
  size: string;
  url?: string;
}

export interface ITicketMessage {
  senderId: Types.ObjectId | string;
  senderName: string;
  senderType: TicketSenderType;
  message: string;
  attachments?: ITicketAttachment[];
  createdAt: Date;
}

/* ── Main Ticket document ── */

export interface ITicket extends Document {
  _id: Types.ObjectId;

  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;

  submitterId: Types.ObjectId;
  submitterName: string;
  submitterEmail: string;
  submitterType: "student" | "tutor";

  assignedTo?: string;

  relatedLessonId?: Types.ObjectId;
  relatedTutorId?: Types.ObjectId;
  relatedStudentId?: Types.ObjectId;

  messages: ITicketMessage[];

  resolvedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

/* ── Request body interfaces ── */

export interface ICreateTicketRequest {
  subject: string;
  category: TicketCategory;
  priority?: TicketPriority;
  message: string;
  relatedLessonId?: string;
  relatedTutorId?: string;
  relatedStudentId?: string;
}

export interface IReplyTicketRequest {
  message: string;
}

export interface IUpdateTicketStatusRequest {
  status: TicketStatus;
}

export interface IUpdateTicketPriorityRequest {
  priority: TicketPriority;
}

/* ── Query interfaces ── */

export interface IAdminTicketsQuery {
  page?: string;
  limit?: string;
  search?: string;
  status?: string;
  category?: string;
  priority?: string;
  submitterType?: string;
  sort?: string; // "newest" | "oldest" | "priority_high" | "last_updated"
}
