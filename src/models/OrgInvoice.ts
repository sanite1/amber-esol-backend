import { Schema, model } from "mongoose";
import { IOrgInvoice } from "../interfaces/orgInvoice.interface";

const lineItemSchema = new Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
    bookingIds: [{ type: Schema.Types.ObjectId, ref: "Booking" }],
  },
  { _id: false },
);

const orgInvoiceSchema = new Schema<IOrgInvoice>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    invoiceNumber: { type: String, required: true, unique: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    lineItems: { type: [lineItemSchema], default: [] },
    subtotal: { type: Number, required: true, min: 0 },
    vatAmount: { type: Number, required: true, min: 0 },
    vatRate: { type: Number, required: true, default: 0.2 },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "GBP" },
    status: {
      type: String,
      enum: ["draft", "issued", "paid", "overdue", "cancelled"],
      default: "draft",
    },
    issuedAt: { type: Date },
    dueAt: { type: Date },
    paidAt: { type: Date },
    pdfUrl: { type: String },
    stripeInvoiceId: { type: String },
    notes: { type: String },
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

orgInvoiceSchema.index({ orgId: 1, status: 1 });
orgInvoiceSchema.index({ orgId: 1, periodStart: -1 });
// invoiceNumber uniqueness is declared via `unique: true` on the field above.

const OrgInvoice = model<IOrgInvoice>("OrgInvoice", orgInvoiceSchema);

export default OrgInvoice;
