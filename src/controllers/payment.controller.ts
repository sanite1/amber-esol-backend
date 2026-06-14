import { Request, Response, NextFunction } from "express";
import { ExpressFunction } from "../interfaces/helper.interface";
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
  createPaymentIntentService,
  listTransactionsService,
  getTransactionByIdService,
  paymentSummaryService,
  getWalletService,
  requestPayoutService,
  listPayoutsService,
  approvePayoutService,
  rejectPayoutService,
  completePayoutService,
  refundTransactionService,
  flagTransactionService,
  listPaymentMethodsService,
  addPaymentMethodService,
  removePaymentMethodService,
  setDefaultPaymentMethodService,
  monthlyChartService,
} from "../services/payment.service";

/* ── Create Payment Intent ── */

export const createPaymentIntent: ExpressFunction<
  ICreatePaymentIntentRequest
> = async (req, res, next) => {
  try {
    const userId = req.user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await createPaymentIntentService(userId, req.body);
    return res.status(data.statusCode).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── List Transactions ── */

export const listTransactions = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await listTransactionsService(
      userId,
      role,
      req.query as unknown as ITransactionQuery,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Get Transaction By Id ── */

export const getTransactionById = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await getTransactionByIdService(req.params.id, userId, role);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Payment Summary ── */

export const paymentSummary = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await paymentSummaryService(userId, role);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Get Wallet ── */

export const getWallet = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await getWalletService(userId);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Request Payout ── */

export const requestPayout: ExpressFunction<IRequestPayoutRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const userId = req.user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await requestPayoutService(userId, req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── List Payouts ── */

export const listPayouts = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await listPayoutsService(
      userId,
      role,
      req.query as unknown as IPayoutQuery,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Approve Payout (admin) ── */

export const approvePayout: ExpressFunction<IApprovePayoutRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const data = await approvePayoutService(req.params.id, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Reject Payout (admin) ── */

export const rejectPayout: ExpressFunction<IRejectPayoutRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const data = await rejectPayoutService(req.params.id, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Complete Payout (admin) ── */

export const completePayout: ExpressFunction<ICompletePayoutRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const data = await completePayoutService(req.params.id, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Refund Transaction ── */

export const refundTransaction: ExpressFunction<IRefundRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await refundTransactionService(
      req.params.transactionId,
      userId,
      role,
      req.body,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Flag Transaction (admin) ── */

export const flagTransaction: ExpressFunction<IFlagTransactionRequest> = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const data = await flagTransactionService(req.params.id, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── List Payment Methods ── */

export const listPaymentMethods = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await listPaymentMethodsService(userId);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Add Payment Method ── */

export const addPaymentMethod: ExpressFunction<
  IAddPaymentMethodRequest
> = async (req, res, next) => {
  try {
    const userId = req.user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await addPaymentMethodService(userId, req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Remove Payment Method ── */

export const removePaymentMethod = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await removePaymentMethodService(userId, req.params.id);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Set Default Payment Method ── */

export const setDefaultPaymentMethod = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await setDefaultPaymentMethodService(userId, req.params.id);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Monthly Chart ── */

export const monthlyChart = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const userId = (req as any).user?.id?.toString();
    const role = (req as any).user?.role;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    const data = await monthlyChartService(
      userId,
      role,
      req.query as unknown as IMonthlyChartQuery,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
