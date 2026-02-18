import { Schema, model } from "mongoose";
import { IWallet } from "../interfaces/payment.interface";

const walletSchema = new Schema<IWallet>(
  {
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    availableBalance: { type: Number, default: 0, min: 0 },
    pendingBalance: { type: Number, default: 0, min: 0 },
    processingBalance: { type: Number, default: 0, min: 0 },
    totalEarned: { type: Number, default: 0, min: 0 },
    lifetimeEarnings: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "GBP" },
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

const Wallet = model<IWallet>("Wallet", walletSchema);

export default Wallet;
