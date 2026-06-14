import { Schema, model } from "mongoose";
import { IBooking } from "../interfaces/booking.interface";

/**
 * Booking — marketplace lessons + ESOL consolidation sessions.
 *
 * Two booking types share this collection:
 *   - "trial"               — marketplace, free first lesson
 *   - "regular"             — marketplace, paid via Stripe
 *   - "esol_consolidation"  — ESOL learner with org-managed teacher,
 *                              invoiced to the org (paymentStatus = org_invoiced)
 *
 * Field-name note: the ESOL fields (orgId, aiSessionId, teacherPrepViewed,
 * teacherNotesPosted) are camelCase because they predate the Project Silk
 * brief's snake_case convention. They're preserved as-is so the existing
 * services that read them keep working. New ESOL fields elsewhere in the
 * codebase use the brief's snake_case names.
 */

const bookingSchema = new Schema<IBooking>(
  {
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      // Brief specifies "esol_consolidation" (snake_case). The codebase
      // previously used "esolConsolidation" — any existing data must be
      // renamed via one-off updateMany BEFORE deploying this change.
      enum: ["trial", "regular", "esol_consolidation"],
      required: true,
    },
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, trim: true },

    status: {
      type: String,
      enum: [
        "pending",
        "confirmed",
        "completed",
        "cancelled_student",
        "cancelled_tutor",
        "cancelled_admin",
        "no_show",
      ],
      default: "pending",
    },
    bookingGroupId: { type: String, default: undefined },
    date: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"],
    },
    startTime: {
      type: String,
      required: true,
      match: [
        /^([01]\d|2[0-3]):([0-5]\d)$/,
        "Start time must be in HH:mm format",
      ],
    },
    endTime: {
      type: String,
      required: true,
      match: [
        /^([01]\d|2[0-3]):([0-5]\d)$/,
        "End time must be in HH:mm format",
      ],
    },
    timezone: { type: String, default: "Europe/London" },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "GBP" },
    specialty: { type: String, trim: true },
    notes: { type: String, trim: true },
    message: { type: String, trim: true },
    meetingUrl: { type: String },
    calendarEventId: { type: String },
    cancelReason: { type: String, trim: true },
    cancelledBy: {
      type: String,
      enum: ["student", "tutor", "admin"],
      default: undefined,
    },
    cancelledAt: { type: Date },
    stripePaymentIntentId: { type: String },
    stripeCheckoutSessionId: { type: String },
    paymentStatus: {
      type: String,
      // Brief specifies "org_invoiced" (snake_case). Previously
      // "orgInvoiced" — same migration concern as the type field above.
      enum: ["pending", "paid", "refunded", "failed", "free", "org_invoiced"],
      default: "pending",
    },
    completedAt: { type: Date },

    // ── ESOL fields (camelCase preserved from prior work) ────────────
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", default: null },
    aiSessionId: {
      type: Schema.Types.ObjectId,
      ref: "AISession",
      default: null,
    },
    teacherPrepViewed: { type: Boolean, default: false },
    teacherNotesPosted: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  },
);

// ── Indexes ────────────────────────────────────────────────────────────

// Tutor queries: availability checks, tutor dashboard, cron
bookingSchema.index({ tutorId: 1, status: 1, date: 1 });

// Student queries: student dashboard, my lessons
bookingSchema.index({ studentId: 1, status: 1, date: 1 });

// Admin/cron queries: auto-complete, admin stats
bookingSchema.index({ status: 1, date: 1 });

// ESOL org queries: org dashboard, invoice generation
bookingSchema.index({ orgId: 1, status: 1, date: 1 });

// NEW: org admin dashboard "show me ESOL consolidation bookings in date
// range" query. Field name in Mongo is orgId (camelCase) even though the
// brief writes it as org_id — the index uses the actual stored name.
bookingSchema.index({ orgId: 1, type: 1, date: 1 });

const Booking = model<IBooking>("Booking", bookingSchema);

export default Booking;
