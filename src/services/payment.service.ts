import Stripe from "stripe";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import Transaction from "../models/Transaction";
import Wallet from "../models/Wallet";
import Payout from "../models/Payout";
import PaymentMethod from "../models/PaymentMethod";
import Booking from "../models/Booking";
import User from "../models/User";
import {
  ICreatePaymentIntentRequest,
  IRequestPayoutRequest,
  IRefundRequest,
  IFlagTransactionRequest,
  IAddPaymentMethodRequest,
  IApprovePayoutRequest,
  IRejectPayoutRequest,
  ICompletePayoutRequest,
  ITransactionQuery,
  IPayoutQuery,
  IMonthlyChartQuery,
} from "../interfaces/payment.interface";
import {
  sendPayoutRequestedMail,
  sendPayoutCompletedMail,
  sendPayoutRejectedMail,
  sendRefundIssuedMail,
} from "./nodemailer/mail.service";

/* ── Stripe init ── */

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

/* ── Platform commission rate ── */

const PLATFORM_COMMISSION_RATE = 0.15; // 15%

/* ── Helper: get or create wallet ── */

const getOrCreateWallet = async (tutorId: string) => {
  let wallet = await Wallet.findOne({ tutorId });
  if (!wallet) {
    wallet = await Wallet.create({ tutorId });
  }
  return wallet;
};

/* ══════════════════════════════════════════════
   Service functions
   ══════════════════════════════════════════════ */

/* ── Create Payment Intent ── */

export const createPaymentIntentService = async (
  userId: string,
  data: ICreatePaymentIntentRequest
) => {
  const booking = await Booking.findById(data.bookingId);
  if (!booking) {
    throw new ApiError(404, "Booking not found");
  }

  if (booking.studentId.toString() !== userId) {
    throw new ApiError(403, "You are not authorized to pay for this booking");
  }

  if (booking.paymentStatus === "paid") {
    throw new ApiError(400, "This booking has already been paid");
  }

  if (booking.price <= 0) {
    throw new ApiError(400, "No payment required for this booking");
  }

  // Check if a transaction already exists and is pending
  const existingTx = await Transaction.findOne({
    bookingId: booking._id,
    status: "pending",
  });

  if (existingTx && existingTx.stripePaymentIntentId) {
    // Return existing payment intent
    const intent = await stripe.paymentIntents.retrieve(
      existingTx.stripePaymentIntentId
    );
    return new ApiResponse(200, "Payment intent retrieved", {
      clientSecret: intent.client_secret,
      transactionId: existingTx._id,
    });
  }

  const amountInPence = Math.round(booking.price * 100);
  const commission =
    Math.round(booking.price * PLATFORM_COMMISSION_RATE * 100) / 100;
  const tutorEarnings = Math.round((booking.price - commission) * 100) / 100;

  // Create Stripe PaymentIntent
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountInPence,
    currency: booking.currency.toLowerCase(),
    metadata: {
      bookingId: booking._id.toString(),
      studentId: userId,
      tutorId: booking.tutorId.toString(),
    },
  });

  // Create Transaction record
  const transaction = await Transaction.create({
    bookingId: booking._id,
    studentId: userId,
    tutorId: booking.tutorId,
    amount: booking.price,
    platformCommission: commission,
    tutorEarnings,
    currency: booking.currency,
    status: "pending",
    type: booking.type === "trial" ? "trial" : "lesson",
    paymentMethod: "card",
    stripePaymentIntentId: paymentIntent.id,
    stripeCheckoutSessionId: booking.stripeCheckoutSessionId,
  });

  return new ApiResponse(201, "Payment intent created", {
    clientSecret: paymentIntent.client_secret,
    transactionId: transaction._id,
  });
};

/* ── Stripe Webhook for Payments ── */

export const handlePaymentWebhookService = async (
  rawBody: Buffer,
  signature: string
) => {
  const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
  if (!WEBHOOK_SECRET) {
    throw new ApiError(500, "Stripe webhook secret is not configured");
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
  } catch (err: any) {
    throw new ApiError(
      400,
      `Webhook signature verification failed: ${err.message}`
    );
  }

  switch (event.type) {
    case "payment_intent.succeeded": {
      const intent = event.data.object as Stripe.PaymentIntent;

      const transaction = await Transaction.findOne({
        stripePaymentIntentId: intent.id,
      });

      if (transaction && transaction.status !== "paid") {
        transaction.status = "paid";
        await transaction.save();

        // Update booking payment status
        await Booking.findByIdAndUpdate(transaction.bookingId, {
          $set: {
            paymentStatus: "paid",
            stripePaymentIntentId: intent.id,
          },
        });

        // Credit tutor's wallet (pending until lesson completes)
        const wallet = await getOrCreateWallet(transaction.tutorId.toString());
        wallet.pendingBalance += transaction.tutorEarnings;
        wallet.totalEarned += transaction.tutorEarnings;
        wallet.lifetimeEarnings += transaction.tutorEarnings;
        await wallet.save();
      }
      break;
    }

    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent;

      const transaction = await Transaction.findOne({
        stripePaymentIntentId: intent.id,
      });

      if (transaction) {
        transaction.status = "failed";
        await transaction.save();

        await Booking.findByIdAndUpdate(transaction.bookingId, {
          $set: { paymentStatus: "failed" },
        });
      }
      break;
    }
  }

  return new ApiResponse(200, "Webhook processed successfully");
};

/* ── List Transactions (role-aware) ── */

export const listTransactionsService = async (
  userId: string,
  role: string,
  query: ITransactionQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  const filter: any = {};

  if (role === "student") {
    filter.studentId = userId;
  } else if (role === "tutor") {
    filter.tutorId = userId;
  }
  // Admin sees all

  if (query.status) filter.status = query.status;
  if (query.type) filter.type = query.type;

  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
    if (query.dateTo) {
      const to = new Date(query.dateTo);
      to.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = to;
    }
  }

  if (query.search) {
    const searchRegex = new RegExp(query.search, "i");
    const matchingUsers = await User.find({
      $or: [{ firstname: searchRegex }, { lastname: searchRegex }],
    }).select("_id");
    const matchingIds = matchingUsers.map((u) => u._id);

    if (role === "student") {
      filter.tutorId = { $in: matchingIds };
    } else if (role === "tutor") {
      filter.studentId = { $in: matchingIds };
    } else {
      filter.$or = [
        { studentId: { $in: matchingIds } },
        { tutorId: { $in: matchingIds } },
      ];
    }
  }

  let sortOption: any = { createdAt: -1 };
  switch (query.sort) {
    case "newest":
      sortOption = { createdAt: -1 };
      break;
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "amount_high":
      sortOption = { amount: -1 };
      break;
    case "amount_low":
      sortOption = { amount: 1 };
      break;
  }

  const [transactions, total] = await Promise.all([
    Transaction.find(filter)
      .populate("studentId", "firstname lastname profilePicture")
      .populate("tutorId", "firstname lastname profilePicture")
      .populate("bookingId", "date startTime endTime type specialty")
      .sort(sortOption)
      .skip(skip)
      .limit(limit),
    Transaction.countDocuments(filter),
  ]);

  return new ApiResponse(200, "Transactions retrieved successfully", {
    transactions: transactions.map((t) => t.toJSON()),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Get Transaction By Id ── */

export const getTransactionByIdService = async (
  transactionId: string,
  userId: string,
  role: string
) => {
  const transaction = await Transaction.findById(transactionId)
    .populate("studentId", "firstname lastname profilePicture email")
    .populate("tutorId", "firstname lastname profilePicture email")
    .populate("bookingId");

  if (!transaction) {
    throw new ApiError(404, "Transaction not found");
  }

  const isStudent = transaction.studentId._id.toString() === userId;
  const isTutor = transaction.tutorId._id.toString() === userId;
  const isAdmin = role === "admin";

  if (!isStudent && !isTutor && !isAdmin) {
    throw new ApiError(403, "You are not authorized to view this transaction");
  }

  return new ApiResponse(
    200,
    "Transaction retrieved successfully",
    transaction.toJSON()
  );
};

/* ── Payment Summary (student spending or tutor earnings) ── */

export const paymentSummaryService = async (userId: string, role: string) => {
  const filter: any = { status: "paid" };

  if (role === "student") {
    filter.studentId = userId;
  } else if (role === "tutor") {
    filter.tutorId = userId;
  }

  const transactions = await Transaction.find(filter);

  const totalAmount = transactions.reduce((sum, t) => sum + t.amount, 0);
  const totalCommission = transactions.reduce(
    (sum, t) => sum + t.platformCommission,
    0
  );
  const totalEarnings = transactions.reduce(
    (sum, t) => sum + t.tutorEarnings,
    0
  );

  // This month
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const thisMonth = transactions.filter((t) => t.createdAt >= startOfMonth);
  const thisMonthAmount = thisMonth.reduce((sum, t) => sum + t.amount, 0);
  const thisMonthEarnings = thisMonth.reduce(
    (sum, t) => sum + t.tutorEarnings,
    0
  );

  // Last month
  const startOfLastMonth = new Date(startOfMonth);
  startOfLastMonth.setMonth(startOfLastMonth.getMonth() - 1);
  const lastMonth = transactions.filter(
    (t) => t.createdAt >= startOfLastMonth && t.createdAt < startOfMonth
  );
  const lastMonthAmount = lastMonth.reduce((sum, t) => sum + t.amount, 0);
  const lastMonthEarnings = lastMonth.reduce(
    (sum, t) => sum + t.tutorEarnings,
    0
  );

  // Refunded
  const refundedCount = await Transaction.countDocuments({
    ...(role === "student" ? { studentId: userId } : { tutorId: userId }),
    status: "refunded",
  });

  return new ApiResponse(200, "Payment summary retrieved successfully", {
    totalTransactions: transactions.length,
    totalAmount,
    totalCommission,
    totalEarnings,
    thisMonthAmount,
    thisMonthEarnings,
    lastMonthAmount,
    lastMonthEarnings,
    refundedCount,
    currency: "GBP",
  });
};

/* ── Tutor Wallet ── */

export const getWalletService = async (tutorId: string) => {
  const wallet = await getOrCreateWallet(tutorId);
  return new ApiResponse(200, "Wallet retrieved successfully", wallet.toJSON());
};

/* ── Request Payout (tutor) ── */

export const requestPayoutService = async (
  tutorId: string,
  data: IRequestPayoutRequest
) => {
  const wallet = await getOrCreateWallet(tutorId);

  if (data.amount > wallet.availableBalance) {
    throw new ApiError(
      400,
      `Insufficient balance. Available: £${wallet.availableBalance.toFixed(2)}`
    );
  }

  if (data.amount < 10) {
    throw new ApiError(400, "Minimum payout amount is £10.00");
  }

  // Check for existing pending payout
  const pendingPayout = await Payout.findOne({
    tutorId,
    status: { $in: ["pending", "processing"] },
  });
  if (pendingPayout) {
    throw new ApiError(
      400,
      "You already have a pending payout request. Please wait for it to be processed."
    );
  }

  // Move amount from available to processing
  wallet.availableBalance -= data.amount;
  wallet.processingBalance += data.amount;
  await wallet.save();

  const payout = await Payout.create({
    tutorId,
    amount: data.amount,
    currency: wallet.currency,
    status: "pending",
    method: data.method,
    notes: data.notes,
    requestedAt: new Date(),
  });

  // Send email notification
  const tutor = await User.findById(tutorId);
  if (tutor) {
    sendPayoutRequestedMail({
      tutorName: tutor.firstname,
      tutorEmail: tutor.email,
      amount: data.amount,
      currency: wallet.currency,
      status: "pending",
    }).catch((err) =>
      console.error("Error sending payout requested email:", err)
    );
  }

  return new ApiResponse(
    201,
    "Payout request submitted successfully",
    payout.toJSON()
  );
};

/* ── List Payouts ── */

export const listPayoutsService = async (
  userId: string,
  role: string,
  query: IPayoutQuery
) => {
  const page = parseInt(query.page || "1", 10);
  const limit = parseInt(query.limit || "10", 10);
  const skip = (page - 1) * limit;

  const filter: any = {};

  if (role === "tutor") {
    filter.tutorId = userId;
  }
  // Admin sees all

  if (query.status) filter.status = query.status;

  let sortOption: any = { createdAt: -1 };
  switch (query.sort) {
    case "newest":
      sortOption = { createdAt: -1 };
      break;
    case "oldest":
      sortOption = { createdAt: 1 };
      break;
    case "amount_high":
      sortOption = { amount: -1 };
      break;
    case "amount_low":
      sortOption = { amount: 1 };
      break;
  }

  const [payouts, total] = await Promise.all([
    Payout.find(filter)
      .populate("tutorId", "firstname lastname profilePicture email")
      .sort(sortOption)
      .skip(skip)
      .limit(limit),
    Payout.countDocuments(filter),
  ]);

  return new ApiResponse(200, "Payouts retrieved successfully", {
    payouts: payouts.map((p) => p.toJSON()),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Approve Payout (admin) ── */

export const approvePayoutService = async (
  payoutId: string,
  data: IApprovePayoutRequest
) => {
  const payout = await Payout.findById(payoutId);
  if (!payout) {
    throw new ApiError(404, "Payout not found");
  }

  if (payout.status !== "pending") {
    throw new ApiError(
      400,
      `Cannot approve a payout with status "${payout.status}"`
    );
  }

  payout.status = "processing";
  if (data.notes) payout.notes = data.notes;
  await payout.save();

  return new ApiResponse(
    200,
    "Payout approved and is now processing",
    payout.toJSON()
  );
};

/* ── Reject Payout (admin) ── */

export const rejectPayoutService = async (
  payoutId: string,
  data: IRejectPayoutRequest
) => {
  const payout = await Payout.findById(payoutId);
  if (!payout) {
    throw new ApiError(404, "Payout not found");
  }

  if (payout.status !== "pending" && payout.status !== "processing") {
    throw new ApiError(
      400,
      `Cannot reject a payout with status "${payout.status}"`
    );
  }

  // Return funds to wallet
  const wallet = await getOrCreateWallet(payout.tutorId.toString());
  wallet.processingBalance -= payout.amount;
  wallet.availableBalance += payout.amount;
  await wallet.save();

  payout.status = "failed";
  payout.flagReason = data.reason;
  payout.processedAt = new Date();
  await payout.save();

  // Notify tutor
  const tutor = await User.findById(payout.tutorId);
  if (tutor) {
    sendPayoutRejectedMail({
      tutorName: tutor.firstname,
      tutorEmail: tutor.email,
      amount: payout.amount,
      currency: payout.currency,
      status: "failed",
      reason: data.reason,
    }).catch((err) =>
      console.error("Error sending payout rejected email:", err)
    );
  }

  return new ApiResponse(200, "Payout rejected", payout.toJSON());
};

/* ── Complete Payout (admin) ── */

export const completePayoutService = async (
  payoutId: string,
  data: ICompletePayoutRequest
) => {
  const payout = await Payout.findById(payoutId);
  if (!payout) {
    throw new ApiError(404, "Payout not found");
  }

  if (payout.status !== "processing") {
    throw new ApiError(
      400,
      `Cannot complete a payout with status "${payout.status}"`
    );
  }

  // Remove from processing balance
  const wallet = await getOrCreateWallet(payout.tutorId.toString());
  wallet.processingBalance -= payout.amount;
  await wallet.save();

  payout.status = "completed";
  payout.processedAt = new Date();
  if (data.reference) payout.reference = data.reference;
  if (data.notes) payout.notes = data.notes;
  await payout.save();

  // Notify tutor
  const tutor = await User.findById(payout.tutorId);
  if (tutor) {
    sendPayoutCompletedMail({
      tutorName: tutor.firstname,
      tutorEmail: tutor.email,
      amount: payout.amount,
      currency: payout.currency,
      status: "completed",
      reference: data.reference,
    }).catch((err) =>
      console.error("Error sending payout completed email:", err)
    );
  }

  return new ApiResponse(200, "Payout completed successfully", payout.toJSON());
};

/* ── Refund Transaction ── */

export const refundTransactionService = async (
  transactionId: string,
  userId: string,
  role: string,
  data: IRefundRequest
) => {
  const transaction = await Transaction.findById(transactionId)
    .populate("studentId", "firstname lastname email")
    .populate("tutorId", "firstname lastname email");

  if (!transaction) {
    throw new ApiError(404, "Transaction not found");
  }

  // Only admin or the student can initiate a refund
  const isStudent = transaction.studentId._id.toString() === userId;
  const isAdmin = role === "admin";

  if (!isStudent && !isAdmin) {
    throw new ApiError(
      403,
      "You are not authorized to refund this transaction"
    );
  }

  if (transaction.status !== "paid") {
    throw new ApiError(
      400,
      `Cannot refund a transaction with status "${transaction.status}"`
    );
  }

  // Issue Stripe refund
  if (transaction.stripePaymentIntentId) {
    try {
      await stripe.refunds.create({
        payment_intent: transaction.stripePaymentIntentId,
      });
    } catch (err: any) {
      throw new ApiError(500, `Stripe refund failed: ${err.message}`);
    }
  }

  transaction.status = "refunded";
  transaction.refundReason = data.reason || "Refund requested";
  transaction.refundedAt = new Date();
  await transaction.save();

  // Update booking
  await Booking.findByIdAndUpdate(transaction.bookingId, {
    $set: { paymentStatus: "refunded" },
  });

  // Deduct from tutor wallet
  const wallet = await getOrCreateWallet(transaction.tutorId._id.toString());
  if (wallet.pendingBalance >= transaction.tutorEarnings) {
    wallet.pendingBalance -= transaction.tutorEarnings;
  } else if (wallet.availableBalance >= transaction.tutorEarnings) {
    wallet.availableBalance -= transaction.tutorEarnings;
  }
  wallet.totalEarned -= transaction.tutorEarnings;
  await wallet.save();

  // Send refund email to student
  const student = transaction.studentId as any;
  const tutor = transaction.tutorId as any;
  const booking = await Booking.findById(transaction.bookingId);

  if (student && tutor) {
    sendRefundIssuedMail({
      studentName: student.firstname,
      studentEmail: student.email,
      tutorName: `${tutor.firstname} ${tutor.lastname}`,
      amount: transaction.amount,
      currency: transaction.currency,
      reason: data.reason,
      bookingDate: booking?.date || "",
    }).catch((err) => console.error("Error sending refund email:", err));
  }

  return new ApiResponse(
    200,
    "Refund issued successfully",
    transaction.toJSON()
  );
};

/* ── Flag / Unflag Transaction (admin) ── */

export const flagTransactionService = async (
  transactionId: string,
  data: IFlagTransactionRequest
) => {
  const transaction = await Transaction.findById(transactionId);
  if (!transaction) {
    throw new ApiError(404, "Transaction not found");
  }

  transaction.flagged = data.flagged;
  transaction.flagReason = data.flagged ? data.flagReason || "" : undefined;
  await transaction.save();

  const message = data.flagged
    ? "Transaction flagged successfully"
    : "Transaction unflagged successfully";

  return new ApiResponse(200, message, transaction.toJSON());
};

/* ── List Payment Methods ── */

export const listPaymentMethodsService = async (userId: string) => {
  const methods = await PaymentMethod.find({ userId }).sort({
    isDefault: -1,
    createdAt: -1,
  });
  return new ApiResponse(
    200,
    "Payment methods retrieved successfully",
    methods.map((m) => m.toJSON())
  );
};

/* ── Add Payment Method ── */

export const addPaymentMethodService = async (
  userId: string,
  data: IAddPaymentMethodRequest
) => {
  // If setting as default, unset all others
  if (data.isDefault) {
    await PaymentMethod.updateMany({ userId }, { $set: { isDefault: false } });
  }

  // If this is the first method, make it default
  const existingCount = await PaymentMethod.countDocuments({ userId });
  const isDefault = existingCount === 0 ? true : data.isDefault || false;

  const method = await PaymentMethod.create({
    userId,
    type: data.type,
    last4: data.last4,
    brand: data.brand,
    isDefault,
    stripePaymentMethodId: data.stripePaymentMethodId,
    bankName: data.bankName,
    accountHolderName: data.accountHolderName,
    paypalEmail: data.paypalEmail,
  });

  return new ApiResponse(
    201,
    "Payment method added successfully",
    method.toJSON()
  );
};

/* ── Remove Payment Method ── */

export const removePaymentMethodService = async (
  userId: string,
  methodId: string
) => {
  const method = await PaymentMethod.findOneAndDelete({
    _id: methodId,
    userId,
  });

  if (!method) {
    throw new ApiError(404, "Payment method not found");
  }

  // If removed the default, set the first remaining as default
  if (method.isDefault) {
    const nextDefault = await PaymentMethod.findOne({ userId });
    if (nextDefault) {
      nextDefault.isDefault = true;
      await nextDefault.save();
    }
  }

  return new ApiResponse(200, "Payment method removed successfully");
};

/* ── Set Default Payment Method ── */

export const setDefaultPaymentMethodService = async (
  userId: string,
  methodId: string
) => {
  const method = await PaymentMethod.findOne({ _id: methodId, userId });
  if (!method) {
    throw new ApiError(404, "Payment method not found");
  }

  // Unset all defaults
  await PaymentMethod.updateMany({ userId }, { $set: { isDefault: false } });

  method.isDefault = true;
  await method.save();

  return new ApiResponse(
    200,
    "Default payment method updated",
    method.toJSON()
  );
};

/* ── Monthly Earnings Chart ── */

export const monthlyChartService = async (
  userId: string,
  role: string,
  query: IMonthlyChartQuery
) => {
  const year = parseInt(query.year || String(new Date().getFullYear()), 10);
  const monthsCount = parseInt(query.months || "12", 10);

  const filter: any = { status: "paid" };
  if (role === "tutor") {
    filter.tutorId = userId;
  }
  // Admin sees platform-wide

  const data: {
    month: string;
    earnings: number;
    transactions: number;
    commission: number;
  }[] = [];

  const now = new Date();
  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(year, now.getMonth() - i, 1);
    const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    const endOfMonth = new Date(
      d.getFullYear(),
      d.getMonth() + 1,
      0,
      23,
      59,
      59,
      999
    );

    const monthTx = await Transaction.find({
      ...filter,
      createdAt: { $gte: startOfMonth, $lte: endOfMonth },
    });

    const monthLabel = startOfMonth.toLocaleDateString("en-GB", {
      month: "short",
      year: "numeric",
    });

    data.push({
      month: monthLabel,
      earnings:
        role === "tutor"
          ? monthTx.reduce((sum, t) => sum + t.tutorEarnings, 0)
          : monthTx.reduce((sum, t) => sum + t.amount, 0),
      transactions: monthTx.length,
      commission: monthTx.reduce((sum, t) => sum + t.platformCommission, 0),
    });
  }

  return new ApiResponse(200, "Monthly chart data retrieved successfully", {
    chartData: data,
    currency: "GBP",
  });
};

/* ══════════════════════════════════════════════
   Wallet credit helper (called from booking service)
   ══════════════════════════════════════════════ */

/**
 * Call this when a lesson is marked as completed
 * to move the tutor's earnings from pending → available.
 */
export const creditTutorForCompletedLesson = async (bookingId: string) => {
  const transaction = await Transaction.findOne({
    bookingId,
    status: "paid",
  });

  if (!transaction) return; // no transaction (free lesson)

  const wallet = await getOrCreateWallet(transaction.tutorId.toString());
  const amount = transaction.tutorEarnings;

  if (wallet.pendingBalance >= amount) {
    wallet.pendingBalance -= amount;
    wallet.availableBalance += amount;
    await wallet.save();
  }
};
