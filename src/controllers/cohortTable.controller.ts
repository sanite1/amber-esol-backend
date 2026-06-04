/**
 * Cohort-table controller — brief Function 12 To-Do 1.
 *
 * Thin layer: pull the caller's org context (set by requireOrgContext)
 * and the query params, hand off to the service.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getCohortTableService,
  CohortTableQuery,
} from "../services/cohortTable.service";

export const getOrgAdminCohortTable: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    // requireOrgContext attaches req.esol_context.org_id; falling back
    // to req.user.orgId would also work (an admin without an esol_context
    // wouldn't pass the middleware) but reading from esol_context keeps
    // services pure — they never touch req.user themselves.
    const orgId =
      (req as typeof req & { esol_context?: { org_id?: string } }).esol_context
        ?.org_id ??
      (req.user?.orgId as string | null | undefined) ??
      "";

    const result = await getCohortTableService(
      orgId,
      req.query as unknown as CohortTableQuery
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
