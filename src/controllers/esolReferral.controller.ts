import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import { IUseReferralTokenRequest } from "../interfaces/referralToken.interface";
import {
  createReferralTokenService,
  listReferralTokensService,
  validateReferralTokenService,
  registerViaReferralService,
  verifyReferralTokenService,
  revokeReferralTokenService,
  remindReferralTokenService,
} from "../services/esolReferralToken.service";

export const createReferralToken: ExpressFunction = async (req, res, next) => {
  try {
    const data = await createReferralTokenService(
      req.body,
      req.user!.orgId,
      req.user!.role,
    );
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

export const listReferralTokens: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listReferralTokensService(
      req.user!.orgId,
      req.user!.role,
      req.query as any,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── PATCH /api/esol/referrals/:id/revoke ── */

export const revokeReferralToken: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const data = await revokeReferralTokenService(
      id,
      req.user!.orgId,
      req.user!.role,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── POST /api/esol/referrals/:id/remind ── */

export const remindReferralToken: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const data = await remindReferralTokenService(
      id,
      req.user!.orgId,
      req.user!.role,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const validateReferralToken: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await validateReferralTokenService(params.token);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const registerViaReferral: ExpressFunction<
  IUseReferralTokenRequest
> = async (req, res, next) => {
  try {
    const data = await registerViaReferralService(req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── POST /api/esol/verify-token (brief Function 2 To-Do 1) ───────── */

export const verifyReferralToken: ExpressFunction = async (req, res, next) => {
  try {
    const { token } = (req.body || {}) as { token?: string };
    if (!token || typeof token !== "string") {
      return next(new ApiError(401, "Invalid or expired link"));
    }
    const data = await verifyReferralTokenService(token);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
