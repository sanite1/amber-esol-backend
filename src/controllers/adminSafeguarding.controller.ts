/**
 * Admin safeguarding controllers — brief Function 10 / Function 15.
 *
 * Thin layer: deserialise req, call service, return JSON. All access
 * control happens at the route layer via isAdmin / isOrgAdmin
 * middleware. The services trust the role gate; this controller's
 * responsibility is to pick the right caller identity off req.user
 * and to return the service's ApiResponse verbatim.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listAdminSafeguardingAlertsService,
  getAdminSafeguardingSummaryService,
  getAdminSafeguardingAlertService,
  resolveAdminSafeguardingAlertService,
  getOrgAdminSafeguardingCountService,
  AdminListSafeguardingQuery,
  ResolveAdminSafeguardingBody,
  OrgAdminCountQuery,
} from "../services/adminSafeguarding.service";

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/safeguarding
// ─────────────────────────────────────────────────────────────────────

export const listAdminSafeguardingAlerts: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    const query = req.query as unknown as AdminListSafeguardingQuery;
    // Function 15 To-Do 2 — `?summary=true` returns aggregate counts
    // instead of the paginated alert list. Same auth (admin only),
    // same shared filters (org_id, category, days). Dispatching here
    // keeps the path GET /api/admin/safeguarding stable for both
    // modes — clients pick which response shape they want via the
    // query param rather than learning a new URL.
    if (query.summary === "true") {
      const result = await getAdminSafeguardingSummaryService(query);
      return res.status(result.statusCode).json({
        message: result.message,
        data: result.data,
      });
    }
    const result = await listAdminSafeguardingAlertsService(query);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/safeguarding/:id
// ─────────────────────────────────────────────────────────────────────

export const getAdminSafeguardingAlert: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    const { id } = req.params as { id: string };
    const result = await getAdminSafeguardingAlertService(id);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/admin/safeguarding/:id
// ─────────────────────────────────────────────────────────────────────

export const resolveAdminSafeguardingAlert: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    const { id } = req.params as { id: string };
    const callerId = req.user!.id.toString();
    const result = await resolveAdminSafeguardingAlertService(
      id,
      req.body as ResolveAdminSafeguardingBody,
      callerId
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/org-admin/safeguarding/count
// ─────────────────────────────────────────────────────────────────────

export const getOrgAdminSafeguardingCount: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    const orgId = req.user!.orgId ?? null;
    const result = await getOrgAdminSafeguardingCountService(
      orgId,
      req.query as unknown as OrgAdminCountQuery
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
