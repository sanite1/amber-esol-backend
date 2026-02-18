import { Types, Document } from "mongoose";
import { IUser } from "./user.interface";

/* ── Enums / Unions ── */

export type BookingType = "trial" | "regular";

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "cancelled_student"
  | "cancelled_tutor"
  | "cancelled_admin"
  | "no_show";

export type PaymentStatus = "pending" | "paid" | "refunded" | "failed" | "free";

export type CancelledBy = "student" | "tutor" | "admin";

/* ── Main Booking document ── */

export interface IBooking extends Document {
  _id: Types.ObjectId;
  studentId: Types.ObjectId;
  tutorId: Types.ObjectId;

  type: BookingType;
  status: BookingStatus;

  // Grouping: multi-slot bookings from one purchase share a bookingGroupId
  bookingGroupId?: string;

  // Schedule
  date: string; // "YYYY-MM-DD"
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
  timezone: string;

  // Pricing
  price: number; // 0 for trials
  currency: string;

  // Lesson details
  specialty?: string;
  notes?: string;
  message?: string; // Student's message to tutor on request

  // Meeting
  meetingUrl?: string;
  calendarEventId?: string;

  // Cancellation
  cancelReason?: string;
  cancelledBy?: CancelledBy;
  cancelledAt?: Date;

  // Payment
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
  paymentStatus: PaymentStatus;

  completedAt?: Date;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

/* ── Request body interfaces ── */

export interface ISlotSelection {
  date: string; // "YYYY-MM-DD"
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
}

export interface ICreateBookingRequest {
  tutorId: string;
  type: BookingType;
  slots: ISlotSelection[]; // 1 slot for trial, 1+ for regular
  specialty?: string;
  notes?: string;
  message?: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface ICancelBookingRequest {
  reason?: string;
}

export interface IDeclineBookingRequest {
  reason?: string;
}

/* ── Query interfaces ── */

export interface IBookingQuery {
  page?: string;
  limit?: string;
  status?: string;
  type?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: string;
}

export interface IUpcomingQuery {
  limit?: string;
}

/* ══════════════════════════════════════════════
   Booking email functions
   ══════════════════════════════════════════════ */

export interface BookingEmailContext {
  student: IUser;
  tutor: IUser;
  bookings: IBooking[];
  totalPrice: number;
  isTrial?: boolean;
  bookingGroupId?: string;
}

export interface SingleBookingEmailContext {
  student: IUser;
  tutor: IUser;
  booking: IBooking;
  reason?: string;
  refunded?: boolean;
}

export interface PaymentEmailContext {
  student: IUser;
  tutor: IUser;
  bookings: IBooking[];
  totalPrice: number;
}

export const formatBookingDate = (dateStr: string) => {
  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};
