/**
 * Amber-admin all-orgs overview controller — brief Function 15 To-Do 1.
 *
 *   GET /api/admin/orgs/overview
 *
 * Auth chain (applied at the route layer):
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin" (Amber super-admin)
 *
 * Thin adapter: the heavy lifting (aggregation pipeline + revenue
 * rollup) lives in adminOrgsOverview.service.ts. This file exists
 * so the service stays testable in isolation without a Request
 * fixture.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import { getAdminOrgsOverview } from "../services/adminOrgsOverview.service";

export const getAdminOrgsOverviewController: ExpressFunction = async (
  _req,
  res,
  next,
) => {
  try {
    const data = await getAdminOrgsOverview();
    return res.status(200).json({
      message: "All-orgs overview",
      data,
    });
  } catch (err) {
    next(err);
  }
};
