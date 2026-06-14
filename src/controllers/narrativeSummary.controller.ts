/**
 * Cohort narrative summary controller — brief Function 12 To-Do 3.
 *
 * Thin layer: pull the caller's org context (set by requireOrgContext),
 * hand off to the service. The service owns the cache lookup, the
 * Gemini call, and the persistence — controllers stay free of
 * business logic.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import { getCohortNarrativeService } from "../services/narrativeSummary.service";

export const getCohortNarrativeSummary: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const orgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ??
      (req.user?.orgId as string | null | undefined) ??
      "";

    const result = await getCohortNarrativeService(orgId);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
