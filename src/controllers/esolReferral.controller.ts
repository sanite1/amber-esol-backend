import { ExpressFunction } from "../interfaces/helper.interface";
import { IUseReferralTokenRequest } from "../interfaces/referralToken.interface";
import {
  createReferralTokenService,
  listReferralTokensService,
  validateReferralTokenService,
  registerViaReferralService,
} from "../services/esolReferralToken.service";

export const createReferralToken: ExpressFunction = async (req, res, next) => {
  try {
    const data = await createReferralTokenService(
      req.body,
      req.user!.orgId,
      req.user!.role
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
      req.query as any
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const validateReferralToken: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await validateReferralTokenService(params.token);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const registerViaReferral: ExpressFunction<IUseReferralTokenRequest> =
  async (req, res, next) => {
    try {
      const data = await registerViaReferralService(req.body);
      return res.status(201).json(data);
    } catch (error) {
      next(error);
    }
  };
