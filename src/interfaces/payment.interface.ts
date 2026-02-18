import { Types, Document } from "mongoose";

/* ── Enums / Unions ── */

export type TransactionType = "lesson" | "trial" | "package";

export type TransactionStatus = "pending" | "paid" | "refunded" | "failed";

export type PayoutStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "flagged";

export type PaymentMethodType = "card" | "paypal" | "bank";

/* ══════════════════════════════════════════════
   Transaction
   ══════════════════════════════════════════════ */

export interface ITransaction extends Document {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  studentId: Types.ObjectId;
  tutorId: Types.ObjectId;

  amount: number;
  platformCommission: number; // e.g. 15% of amount
  tutorEarnings: number; // amount - platformCommission
  currency: string;

  status: TransactionStatus;
  type: TransactionType;

  paymentMethod: string; // "card", "paypal", etc.
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;

  refundReason?: string;
  refundedAt?: Date;

  flagged: boolean;
  flagReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   Wallet
   ══════════════════════════════════════════════ */

export interface IWallet extends Document {
  _id: Types.ObjectId;
  tutorId: Types.ObjectId;

  availableBalance: number;
  pendingBalance: number;
  processingBalance: number;
  totalEarned: number;
  lifetimeEarnings: number;

  currency: string;

  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   Payout
   ══════════════════════════════════════════════ */

export interface IPayout extends Document {
  _id: Types.ObjectId;
  tutorId: Types.ObjectId;

  amount: number;
  currency: string;

  status: PayoutStatus;

  method: string; // "bank_transfer", "paypal", etc.
  reference?: string;

  requestedAt: Date;
  processedAt?: Date;

  notes?: string;
  flagReason?: string;

  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   PaymentMethod
   ══════════════════════════════════════════════ */

export interface IPaymentMethod extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;

  type: PaymentMethodType;
  last4: string;
  brand?: string; // "visa", "mastercard", etc.

  isDefault: boolean;

  stripePaymentMethodId?: string;

  // Bank-specific (optional)
  bankName?: string;
  accountHolderName?: string;

  // PayPal-specific (optional)
  paypalEmail?: string;

  createdAt: Date;
  updatedAt: Date;
}

/* ══════════════════════════════════════════════
   Request body interfaces
   ══════════════════════════════════════════════ */

export interface ICreatePaymentIntentRequest {
  bookingId: string;
}

export interface IRequestPayoutRequest {
  amount: number;
  method: string;
  notes?: string;
}

export interface IRefundRequest {
  reason?: string;
}

export interface IFlagTransactionRequest {
  flagged: boolean;
  flagReason?: string;
}

export interface IAddPaymentMethodRequest {
  type: PaymentMethodType;
  stripePaymentMethodId?: string;
  last4: string;
  brand?: string;
  isDefault?: boolean;
  bankName?: string;
  accountHolderName?: string;
  paypalEmail?: string;
}

export interface IApprovePayoutRequest {
  notes?: string;
}

export interface IRejectPayoutRequest {
  reason: string;
}

export interface ICompletePayoutRequest {
  reference?: string;
  notes?: string;
}

/* ══════════════════════════════════════════════
   Query interfaces
   ══════════════════════════════════════════════ */

export interface ITransactionQuery {
  page?: string;
  limit?: string;
  status?: string;
  type?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: string;
}

export interface IPayoutQuery {
  page?: string;
  limit?: string;
  status?: string;
  sort?: string;
}

export interface IMonthlyChartQuery {
  year?: string;
  months?: string; // number of months to return, default 12
}

/* ══════════════════════════════════════════════
   Email contexts
   ══════════════════════════════════════════════ */

export interface PayoutEmailContext {
  tutorName: string;
  tutorEmail: string;
  amount: number;
  currency: string;
  status: string;
  reference?: string;
  reason?: string;
}

export interface RefundEmailContext {
  studentName: string;
  studentEmail: string;
  tutorName: string;
  amount: number;
  currency: string;
  reason?: string;
  bookingDate: string;
}
