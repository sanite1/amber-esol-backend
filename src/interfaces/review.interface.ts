import { Types, Document } from "mongoose";

/* ── Enums / Unions ── */

export type ReviewStatus = "published" | "hidden" | "removed";

export type ReportStatus = "pending" | "reviewed" | "dismissed";

/* ══════════════════════════════════════════════
   Review
   ══════════════════════════════════════════════ */

export interface IReport {
  reporterId: Types.ObjectId;
  reason: string;
  status: ReportStatus;
  reviewedAt?: Date;
  createdAt: Date;
}

export interface IReply {
  text: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface IReview extends Document {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  studentId: Types.ObjectId;
  tutorId: Types.ObjectId;

  rating: number; // 1–5
  comment: string;

  lessonTopic?: string;
  lessonType?: "trial" | "regular";

  reply?: IReply;

  reported: boolean;
  reports: IReport[];

  status: ReviewStatus;

  helpfulCount: number;
  helpfulBy: Types.ObjectId[]; // user IDs who found it helpful

  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   Request body interfaces
   ══════════════════════════════════════════════ */

export interface ICreateReviewRequest {
  bookingId: string;
  rating: number;
  comment: string;
}

export interface IUpdateReviewRequest {
  rating?: number;
  comment?: string;
}

export interface IReplyRequest {
  text: string;
}

export interface IReportRequest {
  reason: string;
}

export interface IAdminReviewActionRequest {
  reason?: string;
}

export interface IAdminReportActionRequest {
  status: "reviewed" | "dismissed";
}

/* ══════════════════════════════════════════════
   Query interfaces
   ══════════════════════════════════════════════ */

export interface IReviewQuery {
  page?: string;
  limit?: string;
  rating?: string; // "1", "2", "3", "4", "5"
  sort?: string; // "newest", "oldest", "rating_high", "rating_low", "most_helpful"
}

export interface IAdminReviewQuery {
  page?: string;
  limit?: string;
  status?: string; // "published", "hidden", "removed"
  reported?: string; // "true" or "false"
  sort?: string;
  search?: string;
}

/* ══════════════════════════════════════════════
   Email contexts
   ══════════════════════════════════════════════ */

export interface ReviewEmailContext {
  studentName: string;
  studentEmail: string;
  tutorName: string;
  tutorEmail: string;
  rating: number;
  comment: string;
  lessonTopic?: string;
  reviewUrl: string;
}

export interface ReviewReplyEmailContext {
  studentName: string;
  studentEmail: string;
  tutorName: string;
  replyText: string;
  reviewUrl: string;
}

export interface ReviewReportEmailContext {
  reviewId: string;
  reporterName: string;
  reason: string;
  adminUrl: string;
}
