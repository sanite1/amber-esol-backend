import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listLearnersService,
  getLearnerService,
  updateLearnerService,
} from "../services/esolLearner.service";

export const listLearners: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listLearnersService(
      req.user!.orgId,
      req.user!.role,
      req.query as any
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const getLearner: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const orgId =
      req.user!.role === "org_admin"
        ? req.user!.orgId!
        : ((req.query as any).orgId as string) || req.user!.orgId!;

    const data = await getLearnerService(
      orgId,
      params.learnerId,
      req.user!.role,
      req.user!.orgId
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const updateLearner: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const body = req.body as any;
    const orgId =
      req.user!.role === "org_admin"
        ? req.user!.orgId!
        : (body.orgId as string) || req.user!.orgId!;

    const data = await updateLearnerService(orgId, params.learnerId, body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
