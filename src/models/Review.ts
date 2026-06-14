import { Schema, model } from "mongoose";
import { IReview } from "../interfaces/review.interface";

const ReportSchema = new Schema(
  {
    reporterId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    reason: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "reviewed", "dismissed"],
      default: "pending",
    },
    reviewedAt: { type: Date },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const ReplySchema = new Schema(
  {
    text: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
  },
  { _id: false },
);

const reviewSchema = new Schema<IReview>(
  {
    bookingId: {
      type: Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
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
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      required: true,
      trim: true,
    },
    lessonTopic: { type: String, trim: true },
    lessonType: {
      type: String,
      enum: ["trial", "regular"],
    },
    reply: { type: ReplySchema, default: undefined },
    reported: { type: Boolean, default: false },
    reports: { type: [ReportSchema], default: [] },
    status: {
      type: String,
      enum: ["published", "hidden", "removed"],
      default: "published",
    },
    helpfulCount: { type: Number, default: 0 },
    helpfulBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
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

// Compound index: one review per student per booking
reviewSchema.index({ bookingId: 1, studentId: 1 }, { unique: true });

// Index for tutor review lookups
reviewSchema.index({ tutorId: 1, status: 1, createdAt: -1 });

const Review = model<IReview>("Review", reviewSchema);

export default Review;
