import { Schema, model } from "mongoose";
import { IPayout } from "../interfaces/payment.interface";

const payoutSchema = new Schema<IPayout>(
  {
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "GBP" },
    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "flagged"],
      default: "pending",
    },
    method: { type: String, required: true },
    reference: { type: String, trim: true },
    requestedAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
    notes: { type: String, trim: true },
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

const Payout = model<IPayout>("Payout", payoutSchema);

export default Payout;
