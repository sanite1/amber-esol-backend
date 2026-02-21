import { Schema, model } from "mongoose";
import { ITicket } from "../interfaces/ticket.interface";

const TicketAttachmentSchema = new Schema(
  {
    name: { type: String, required: true },
    size: { type: String, required: true },
    url: { type: String },
  },
  { _id: false }
);

const TicketMessageSchema = new Schema(
  {
    senderId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    senderName: { type: String, required: true, trim: true },
    senderType: {
      type: String,
      enum: ["student", "tutor", "admin"],
      required: true,
    },
    message: { type: String, required: true, trim: true },
    attachments: { type: [TicketAttachmentSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ticketSchema = new Schema<ITicket>(
  {
    subject: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: [
        "billing",
        "technical",
        "lesson_issue",
        "account",
        "report",
        "other",
      ],
      required: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["open", "in_progress", "awaiting_user", "resolved", "closed"],
      default: "open",
    },

    submitterId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    submitterName: { type: String, required: true, trim: true },
    submitterEmail: { type: String, required: true, trim: true },
    submitterType: {
      type: String,
      enum: ["student", "tutor"],
      required: true,
    },

    assignedTo: { type: String },

    relatedLessonId: { type: Schema.Types.ObjectId, ref: "Booking" },
    relatedTutorId: { type: Schema.Types.ObjectId, ref: "User" },
    relatedStudentId: { type: Schema.Types.ObjectId, ref: "User" },

    messages: { type: [TicketMessageSchema], default: [] },

    resolvedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

/* ── Indexes ── */
ticketSchema.index({ status: 1, priority: 1, updatedAt: -1 });
ticketSchema.index({ submitterId: 1, createdAt: -1 });
ticketSchema.index({ submitterType: 1 });

const Ticket = model<ITicket>("Ticket", ticketSchema);

export default Ticket;
