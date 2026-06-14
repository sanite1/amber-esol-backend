import { Schema, model } from "mongoose";
import { IPaymentMethod } from "../interfaces/payment.interface";

const paymentMethodSchema = new Schema<IPaymentMethod>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: ["card", "paypal", "bank"],
      required: true,
    },
    last4: { type: String, required: true, match: /^\d{4}$/ },
    brand: { type: String, trim: true },
    isDefault: { type: Boolean, default: false },
    stripePaymentMethodId: { type: String },
    bankName: { type: String, trim: true },
    accountHolderName: { type: String, trim: true },
    paypalEmail: { type: String, trim: true, lowercase: true },
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

paymentMethodSchema.index({ userId: 1 });

const PaymentMethod = model<IPaymentMethod>(
  "PaymentMethod",
  paymentMethodSchema,
);

export default PaymentMethod;
