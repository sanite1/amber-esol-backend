import { Router, raw } from "express";
import {
  isAuthenticated,
  isTutor,
  isAdmin,
} from "../middlewares/authMiddleWare";
import {
  createPaymentIntentValidation,
  listTransactionsValidation,
  getTransactionByIdValidation,
  requestPayoutValidation,
  listPayoutsValidation,
  approvePayoutValidation,
  rejectPayoutValidation,
  completePayoutValidation,
  refundTransactionValidation,
  flagTransactionValidation,
  addPaymentMethodValidation,
  removePaymentMethodValidation,
  setDefaultPaymentMethodValidation,
  monthlyChartValidation,
} from "../validations/payment.validation";
import {
  createPaymentIntent,
  listTransactions,
  getTransactionById,
  paymentSummary,
  getWallet,
  requestPayout,
  listPayouts,
  approvePayout,
  rejectPayout,
  completePayout,
  refundTransaction,
  flagTransaction,
  listPaymentMethods,
  addPaymentMethod,
  removePaymentMethod,
  setDefaultPaymentMethod,
  monthlyChart,
} from "../controllers/payment.controller";

const router = Router();

// ── Stripe Webhook (raw body for signature verification) ──
// NOTE: Mount this with express.raw() BEFORE express.json() in index.ts
// router.post("/webhook", raw({ type: "application/json" }), paymentWebhook);

// ── Authenticated: Create payment intent ──
router.post(
  "/create-intent",
  isAuthenticated,
  createPaymentIntentValidation(),
  createPaymentIntent
);

// ── Authenticated: Transaction history ──
router.get(
  "/transactions",
  isAuthenticated,
  listTransactionsValidation(),
  listTransactions
);

// ── Authenticated: Payment summary ──
router.get("/summary", isAuthenticated, paymentSummary);

// ── Authenticated: Monthly chart ──
router.get(
  "/chart/monthly",
  isAuthenticated,
  monthlyChartValidation(),
  monthlyChart
);

// ── Authenticated: Tutor wallet ──
router.get("/wallet", isAuthenticated, isTutor, getWallet);

// ── Authenticated: Payment methods ──
router.get("/methods", isAuthenticated, listPaymentMethods);
router.post(
  "/methods",
  isAuthenticated,
  addPaymentMethodValidation(),
  addPaymentMethod
);
router.delete(
  "/methods/:id",
  isAuthenticated,
  removePaymentMethodValidation(),
  removePaymentMethod
);
router.patch(
  "/methods/:id/default",
  isAuthenticated,
  setDefaultPaymentMethodValidation(),
  setDefaultPaymentMethod
);

// ── Authenticated: Payouts (tutor requests, admin manages) ──
router.post(
  "/payouts",
  isAuthenticated,
  isTutor,
  requestPayoutValidation(),
  requestPayout
);
router.get("/payouts", isAuthenticated, listPayoutsValidation(), listPayouts);
router.patch(
  "/payouts/:id/approve",
  isAuthenticated,
  isAdmin,
  approvePayoutValidation(),
  approvePayout
);
router.patch(
  "/payouts/:id/reject",
  isAuthenticated,
  isAdmin,
  rejectPayoutValidation(),
  rejectPayout
);
router.patch(
  "/payouts/:id/complete",
  isAuthenticated,
  isAdmin,
  completePayoutValidation(),
  completePayout
);

// ── Authenticated: Refund ──
router.post(
  "/refund/:transactionId",
  isAuthenticated,
  refundTransactionValidation(),
  refundTransaction
);

// ── Admin: Flag transaction ──
router.patch(
  "/transactions/:id/flag",
  isAuthenticated,
  isAdmin,
  flagTransactionValidation(),
  flagTransaction
);

// ── Authenticated: Transaction detail (must be after /transactions routes) ──
router.get(
  "/transactions/:id",
  isAuthenticated,
  getTransactionByIdValidation(),
  getTransactionById
);

export default router;
