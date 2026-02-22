import { Schema, model } from "mongoose";
import { ITransaction } from "../interfaces/payment.interface";

const transactionSchema = new Schema<ITransaction>(
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
    amount: { type: Number, required: true, min: 0 },
    platformCommission: { type: Number, required: true, min: 0 },
    tutorEarnings: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "GBP" },
    status: {
      type: String,
      enum: ["pending", "paid", "refunded", "failed"],
      default: "pending",
    },
    type: {
      type: String,
      enum: ["lesson", "trial", "package"],
      required: true,
    },
    paymentMethod: { type: String, default: "card" },
    stripePaymentIntentId: { type: String },
    stripeCheckoutSessionId: { type: String },
    refundReason: { type: String, trim: true },
    refundedAt: { type: Date },
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, trim: true },
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

// Tutor earnings, payment summary
transactionSchema.index({ tutorId: 1, status: 1 });

// Lookup by booking (refunds, credit checks, duplicate guards)
transactionSchema.index({ bookingId: 1, status: 1 });

const Transaction = model<ITransaction>("Transaction", transactionSchema);

export default Transaction;
