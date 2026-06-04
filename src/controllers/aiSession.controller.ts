import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import {
  processTurnService,
  startSessionService,
  endSessionService,
} from "../services/aiSession.service";

const pullContext = (req: any): { learnerId: string; orgId: string } | null => {
  const learnerId = req.user?.id?.toString();
  const orgId = req.esol_context?.org_id;
  if (!learnerId || !orgId) return null;
  return { learnerId, orgId };
};

/**
 * POST /api/esol/session/turn — brief Function 7 To-Do 5.
 *
 * Thin: pull the body + identity from the request, hand off to the
 * service. Auth chain (isAuthenticated + requireOrgContext +
 * aiTurnLimiter) is enforced at the route layer.
 */
export const processTurn: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) return next(new ApiError(401, "Unauthorized"));

    const ctx = (req as typeof req & {
      esol_context?: { org_id: string };
    }).esol_context;
    if (!ctx?.org_id) {
      return next(new ApiError(403, "Organisation context required"));
    }

    const body = req.body as { session_id?: string; message?: string };
    const data = await processTurnService({
      sessionId: body.session_id ?? "",
      message: body.message ?? "",
      learnerId,
      orgId: ctx.org_id,
    });
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/esol/session/start — brief Function 7 To-Do 6.
 */
export const startSession: ExpressFunction = async (req, res, next) => {
  try {
    const ctx = pullContext(req);
    if (!ctx) return next(new ApiError(403, "Auth + org context required"));

    const body = req.body as { scenario_id?: string };
    const data = await startSessionService({
      scenarioId: body.scenario_id ?? "",
      learnerId: ctx.learnerId,
      orgId: ctx.orgId,
    });
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/esol/session/end — brief Function 7 To-Do 6.
 */
export const endSession: ExpressFunction = async (req, res, next) => {
  try {
    const ctx = pullContext(req);
    if (!ctx) return next(new ApiError(403, "Auth + org context required"));

    const body = req.body as { session_id?: string };
    const data = await endSessionService({
      sessionId: body.session_id ?? "",
      learnerId: ctx.learnerId,
      orgId: ctx.orgId,
    });
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
