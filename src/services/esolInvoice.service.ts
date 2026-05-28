import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import OrgInvoice from "../models/OrgInvoice";
import Booking from "../models/Booking";
import Organisation from "../models/Organisation";
import User from "../models/User";
import { IOrgInvoiceLineItem } from "../interfaces/orgInvoice.interface";
import logger from "../config/logger";

const VAT_RATE = 0.2;

interface CallerContext {
  callerRole: string;
  callerOrgId?: string | null;
}

const generateInvoiceNumber = async (): Promise<string> => {
  const year = new Date().getFullYear();
  const count = await OrgInvoice.countDocuments({
    invoiceNumber: new RegExp(`^INV-${year}-`),
  });
  const seq = String(count + 1).padStart(4, "0");
  return `INV-${year}-${seq}`;
};

/* ── Generate invoice for org + period ── */

export const generateInvoiceService = async (data: {
  orgId: string;
  periodStart: string;
  periodEnd: string;
  notes?: string;
}) => {
  const org = await Organisation.findById(data.orgId);
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  const periodStart = new Date(data.periodStart);
  const periodEnd = new Date(data.periodEnd);
  if (periodEnd < periodStart) {
    throw new ApiError(400, "Period end must be after period start");
  }

  // Aggregate completed bookings with org_invoiced payment status
  const bookings = await Booking.find({
    orgId: data.orgId,
    paymentStatus: "org_invoiced",
    status: "completed",
    completedAt: { $gte: periodStart, $lte: periodEnd },
  })
    .populate("studentId", "firstname lastname")
    .populate("tutorId", "firstname lastname")
    .lean();

  if (bookings.length === 0) {
    throw new ApiError(
      400,
      "No invoiceable bookings found for this organisation in the selected period"
    );
  }

  const lineItems: IOrgInvoiceLineItem[] = bookings.map((b: any) => {
    const tutor = b.tutorId as any;
    const learner = b.studentId as any;
    const tutorName = tutor
      ? `${tutor.firstname} ${tutor.lastname}`
      : "Tutor";
    const learnerName = learner
      ? `${learner.firstname} ${learner.lastname}`
      : "Learner";
    return {
      description: `Lesson on ${b.date} — ${tutorName} with ${learnerName}`,
      quantity: 1,
      unitPrice: b.price,
      amount: b.price,
      bookingIds: [b._id],
    };
  });

  const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
  const vatAmount = Math.round(subtotal * VAT_RATE * 100) / 100;
  const totalAmount = Math.round((subtotal + vatAmount) * 100) / 100;

  const dueAt = new Date();
  dueAt.setDate(dueAt.getDate() + 30); // Net-30 default

  // Retry on duplicate-key collision: countDocuments-based numbering can
  // race when two invoices are created concurrently. Up to 3 attempts.
  let invoice = null;
  let lastErr: any = null;
  for (let attempt = 0; attempt < 3 && !invoice; attempt++) {
    const invoiceNumber = await generateInvoiceNumber();
    try {
      invoice = await OrgInvoice.create({
        orgId: org._id,
        invoiceNumber,
        periodStart,
        periodEnd,
        lineItems,
        subtotal,
        vatAmount,
        vatRate: VAT_RATE,
        totalAmount,
        currency: "GBP",
        status: "issued",
        issuedAt: new Date(),
        dueAt,
        notes: data.notes,
      });
    } catch (err: any) {
      lastErr = err;
      // Mongo duplicate key error code
      if (err?.code !== 11000) throw err;
    }
  }
  if (!invoice) {
    throw new ApiError(
      500,
      `Could not generate invoice number after retries: ${lastErr?.message ?? "unknown"}`
    );
  }

  return new ApiResponse(201, "Invoice generated successfully", invoice.toJSON());
};

/* ── List invoices ── */

export const listInvoicesService = async (
  options: {
    page?: string;
    limit?: string;
    status?: string;
    orgId?: string;
  },
  caller: CallerContext
) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "20", 10);
  const skip = (page - 1) * limit;

  const query: any = {};

  if (caller.callerRole === "org_admin") {
    if (!caller.callerOrgId) {
      throw new ApiError(400, "Organisation context required");
    }
    query.orgId = caller.callerOrgId;
  } else if (caller.callerRole === "admin" && options.orgId) {
    query.orgId = options.orgId;
  }

  if (options.status) query.status = options.status;

  const [invoices, total] = await Promise.all([
    OrgInvoice.find(query)
      .sort({ issuedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("orgId", "name slug"),
    OrgInvoice.countDocuments(query),
  ]);

  return new ApiResponse(200, "Invoices retrieved successfully", {
    invoices,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Get single invoice ── */

export const getInvoiceService = async (
  invoiceId: string,
  caller: CallerContext
) => {
  const invoice = await OrgInvoice.findById(invoiceId).populate(
    "orgId",
    "name slug contactEmail contactName address ilrProviderRef"
  );

  if (!invoice) {
    throw new ApiError(404, "Invoice not found");
  }

  if (
    caller.callerRole === "org_admin" &&
    invoice.orgId.toString() !== caller.callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this invoice");
  }

  return new ApiResponse(200, "Invoice retrieved successfully", invoice.toJSON());
};

/* ── Mark invoice paid ── */

export const markInvoicePaidService = async (
  invoiceId: string,
  data: { paidAt?: string; notes?: string }
) => {
  const invoice = await OrgInvoice.findById(invoiceId);
  if (!invoice) {
    throw new ApiError(404, "Invoice not found");
  }
  if (invoice.status === "paid") {
    throw new ApiError(400, "This invoice is already marked as paid");
  }
  if (invoice.status === "cancelled") {
    throw new ApiError(400, "Cannot mark a cancelled invoice as paid");
  }

  invoice.status = "paid";
  invoice.paidAt = data.paidAt ? new Date(data.paidAt) : new Date();
  if (data.notes) {
    invoice.notes = invoice.notes
      ? `${invoice.notes}\n\nPayment received: ${data.notes}`
      : `Payment received: ${data.notes}`;
  }
  await invoice.save();

  return new ApiResponse(200, "Invoice marked as paid", invoice.toJSON());
};

/* ── Auto-generate monthly invoices (cron) ── */

export const autoGenerateInvoicesCronService = async () => {
  const now = new Date();
  // Last full month: from the 1st of last month to last day of last month
  const periodEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  const periodStart = new Date(
    periodEnd.getFullYear(),
    periodEnd.getMonth(),
    1,
    0,
    0,
    0
  );

  const orgs = await Organisation.find({
    isActive: true,
    paymentModel: "invoiced",
  });

  const results: { orgId: string; orgName: string; status: string }[] = [];

  for (const org of orgs) {
    try {
      const result = await generateInvoiceService({
        orgId: org._id.toString(),
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      });
      results.push({
        orgId: org._id.toString(),
        orgName: org.name,
        status: "generated",
      });
      logger.info(
        { orgId: org._id, invoiceNumber: (result.data as any).invoiceNumber },
        "Auto-generated invoice"
      );
    } catch (err: any) {
      const reason = err?.message || "unknown error";
      results.push({
        orgId: org._id.toString(),
        orgName: org.name,
        status: `skipped: ${reason}`,
      });
      logger.warn({ orgId: org._id, err: reason }, "Skipped invoice generation");
    }
  }

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    orgsProcessed: orgs.length,
    results,
  };
};

/* ── Helper to load invoice + populated org for PDF generation ── */

export const loadInvoiceForPdf = async (
  invoiceId: string,
  caller: CallerContext
) => {
  const invoice = await OrgInvoice.findById(invoiceId).populate(
    "orgId",
    "name slug contactEmail contactName address ilrProviderRef phoneNumber"
  );

  if (!invoice) {
    throw new ApiError(404, "Invoice not found");
  }
  if (
    caller.callerRole === "org_admin" &&
    (invoice.orgId as any)._id.toString() !== caller.callerOrgId
  ) {
    throw new ApiError(403, "Access denied to this invoice");
  }

  return invoice;
};
