import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listLearnersService,
  getLearnerService,
  updateLearnerService,
  getLearnerVocabLedgerService,
  getLearnerSessionsService,
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

/**
 * GET /api/esol/learners/:learnerId/vocab-ledger
 *
 * The service does the ACL: org_admin must match learner.orgId,
 * admin bypasses. We pass req.user.role + req.user.orgId in and let
 * the service decide.
 */
export const getLearnerVocabLedger: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await getLearnerVocabLedgerService(
      params.learnerId,
      req.user!.role,
      req.user!.orgId
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/esol/learners/:learnerId/sessions
 *
 * `?page=1&limit=20` — page is 1-indexed, limit capped at 100 in
 * the service.
 */
export const getLearnerSessions: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const query = req.query as Record<string, string | undefined>;
    const page = query.page ? Number(query.page) : undefined;
    const limit = query.limit ? Number(query.limit) : undefined;
    const data = await getLearnerSessionsService(
      params.learnerId,
      req.user!.role,
      req.user!.orgId,
      {
        page: Number.isFinite(page) ? page : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      }
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
