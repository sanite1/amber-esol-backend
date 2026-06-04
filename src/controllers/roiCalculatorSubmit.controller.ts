/**
 * ROI calculator submission controller — Final Addendum §13.
 *
 *   POST /api/public/roi-calculator/submit
 *
 * Thin adapter — pulls ip + user-agent from the request and
 * hands them to the service. Auth is intentionally absent;
 * the rate limiter at the route layer is the only abuse gate.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  submitRoiCalculatorService,
  RoiCalculatorSubmitBody,
} from "../services/roiCalculatorSubmit.service";

export const submitRoiCalculator: ExpressFunction = async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as RoiCalculatorSubmitBody;
    // `req.ip` respects Express's `trust proxy` setting. The
    // platform sits behind Vercel which sets x-forwarded-for;
    // trust proxy is enabled in src/index.ts so req.ip is the
    // real client IP, not a load-balancer hop. If a future
    // deploy disables it, the hashes degrade to per-deployment
    // single-value — not catastrophic but worth catching.
    const ip = req.ip ?? "0.0.0.0";
    const userAgent =
      typeof req.headers["user-agent"] === "string"
        ? (req.headers["user-agent"] as string).slice(0, 500)
        : null;

    const result = await submitRoiCalculatorService({
      body,
      ip_address: ip,
      user_agent: userAgent,
    });

    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
