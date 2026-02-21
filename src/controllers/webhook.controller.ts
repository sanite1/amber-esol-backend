import { Request, Response, NextFunction } from "express";
import { handleStripeWebhookService } from "../services/webhook.service";

/* ── Unified Stripe Webhook ── */

export const stripeWebhook = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const signature = req.headers["stripe-signature"] as string;
    if (!signature) {
      return res.status(400).json({ message: "Missing Stripe signature" });
    }
    const data = await handleStripeWebhookService(req.body, signature);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
