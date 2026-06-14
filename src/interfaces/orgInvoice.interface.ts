import { Types, Document } from "mongoose";

export type OrgInvoiceStatus =
  | "draft"
  | "issued"
  | "paid"
  | "overdue"
  | "cancelled";

export interface IOrgInvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  bookingIds?: Types.ObjectId[];
}

export interface IOrgInvoice extends Document {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  invoiceNumber: string;
  periodStart: Date;
  periodEnd: Date;
  lineItems: IOrgInvoiceLineItem[];
  subtotal: number;
  vatAmount: number;
  vatRate: number;
  totalAmount: number;
  currency: string;
  status: OrgInvoiceStatus;
  issuedAt?: Date;
  dueAt?: Date;
  paidAt?: Date;
  pdfUrl?: string;
  stripeInvoiceId?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMarkInvoicePaidRequest {
  paidAt?: string;
  notes?: string;
}
