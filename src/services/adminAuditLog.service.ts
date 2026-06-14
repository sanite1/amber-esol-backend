/**
 * Amber-admin CROSS-ORGANISATION audit search — Final Addendum §6
 * ("Amber admin view: full cross-organisation audit search for
 * support, investigation, and compliance reporting").
 *
 * Backs GET /api/admin/audit-log. Reuses the org-admin audit-log
 * building blocks (filter validation, $facet with actor/learner
 * lookups, row normalisation) with ONE difference: the org scope is
 * an OPTIONAL filter instead of a mandatory gate. With no org_id the
 * search spans every organisation — that's the point of the surface,
 * and it's why the route is hard-gated to role === "admin".
 *
 * Each row additionally carries org_id + org_name (resolved in one
 * batched query per page) so a cross-org result list is readable
 * without per-row drill-in.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AuditLog from "../models/AuditLog";
import Organisation from "../models/Organisation";
import {
  applyAuditLogQueryFilters,
  buildAuditLogFacet,
  normaliseAuditLogRow,
  OrgAdminAuditLogQuery,
} from "./orgAdminAuditLog.service";

const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

export interface AdminAuditLogQuery extends OrgAdminAuditLogQuery {
  /** Optional — omit to search across every organisation. */
  org_id?: string;
}

export const listAdminAuditLogService = async (
  query: AdminAuditLogQuery,
): Promise<ApiResponse> => {
  // ── Match clause — org scope is optional here ──────────────────
  const match: Record<string, unknown> = {};
  if (query.org_id) {
    if (!Types.ObjectId.isValid(query.org_id)) {
      throw new ApiError(400, "org_id must be a valid ObjectId");
    }
    match.org_id = new Types.ObjectId(query.org_id);
  }
  applyAuditLogQueryFilters(match, query);

  // ── Pagination — same bounds as the org-admin surface ──────────
  const rawPage = parseInt(query.page ?? "1", 10);
  const rawLimit = parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10);
  if (query.page !== undefined && (!Number.isFinite(rawPage) || rawPage < 1)) {
    throw new ApiError(400, "page must be an integer ≥ 1");
  }
  if (
    query.limit !== undefined &&
    (!Number.isFinite(rawLimit) ||
      rawLimit < MIN_PAGE_SIZE ||
      rawLimit > MAX_PAGE_SIZE)
  ) {
    throw new ApiError(
      400,
      `limit must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`,
    );
  }
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Math.min(
    Math.max(
      Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : DEFAULT_PAGE_SIZE,
      MIN_PAGE_SIZE,
    ),
    MAX_PAGE_SIZE,
  );
  const skip = (page - 1) * limit;

  // ── Query — shared facet keeps lookups identical to org-admin ──
  // We also project org_id through the facet via a pre-stage $set so
  // the normalised rows can be joined to org names below.
  const [facetResult] = await AuditLog.aggregate([
    { $match: match },
    buildAuditLogFacet({ skip, limit }),
  ]);

  const rawRows = (facetResult?.rows ?? []) as Array<Record<string, unknown>>;
  const rows = rawRows.map((r) => ({
    ...normaliseAuditLogRow(r),
    org_id: r.org_id ? String(r.org_id) : null,
  }));
  const total = (facetResult?.total?.[0]?.value as number | undefined) ?? 0;

  // ── Resolve org names in one batched query per page ────────────
  const orgIds = Array.from(
    new Set(rows.map((r) => r.org_id).filter((v): v is string => Boolean(v))),
  );
  const orgs = orgIds.length
    ? await Organisation.find({
        _id: { $in: orgIds.map((id) => new Types.ObjectId(id)) },
      })
        .select("name")
        .lean()
    : [];
  const orgNameById = new Map(orgs.map((o) => [o._id.toString(), o.name]));

  return new ApiResponse(200, "Cross-organisation audit log retrieved", {
    rows: rows.map((r) => ({
      ...r,
      org_name: r.org_id ? (orgNameById.get(r.org_id) ?? null) : null,
    })),
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
  });
};
