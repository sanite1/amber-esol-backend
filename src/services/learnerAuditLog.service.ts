/**
 * Learner-self audit log endpoint — Final Addendum §6 (BE-A surface).
 *
 * Backs `GET /api/learner/me/audit-log`. The learner sees ONLY events
 * scoped to themselves — `learner_id == req.user._id`. No org_id
 * filter is needed because every audit entry the learner can see is
 * already tied to them, but we DO include an org_id check as a
 * defence-in-depth safety net (the learner's events should never be
 * for a different org than their own).
 *
 * Differences from `orgAdminAuditLog.service`:
 *   • Hardcoded `learner_id` match — no learner_id query param accepted
 *     (the learner cannot pivot to other learners; that's the whole
 *     point of this surface).
 *   • No `action` filter exposed — the timeline is short enough that
 *     filters aren't needed; the frontend can do client-side filtering
 *     if it ever has to.
 *   • Same `from`/`to` date-range support — useful for "show me what
 *     happened this term."
 *   • Same response shape as the org-admin endpoint so the frontend
 *     `AuditLog.tsx` component can be reused in an embedded mode.
 *
 * Privacy guarantees enforced here:
 *   • The pre-lookup match is `{ learner_id: req.user._id, org_id:
 *     req.user.orgId }`. Even if the user's JWT is somehow tampered
 *     with to advertise a different orgId, the LEARNER_ID match
 *     prevents seeing other people's events.
 *   • `before_state` / `after_state` are returned verbatim — same as
 *     the org-admin endpoint. The fields stored by writers are
 *     already PII-aware (no other learners' names are in a learner's
 *     own audit row).
 *
 * Build pattern: share helpers with the org-admin service so the
 * expensive $lookup + projection logic isn't duplicated. The Phase 1
 * refactor extracted `applyAuditLogQueryFilters`, `buildAuditLogFacet`,
 * and `normaliseAuditLogRow` for that purpose.
 */

import { PipelineStage, Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AuditLog from "../models/AuditLog";
import {
  applyAuditLogQueryFilters,
  buildAuditLogFacet,
  normaliseAuditLogRow,
  OrgAdminAuditLogQuery,
  OrgAdminAuditLogRow,
} from "./orgAdminAuditLog.service";

// Same response row shape as the org-admin endpoint — frontend reuse.
export type LearnerAuditLogRow = OrgAdminAuditLogRow;

// Learner endpoint accepts ONLY date range + pagination. learner_id is
// hardcoded from the JWT; action filter is omitted by design (the
// learner's timeline is short enough that filters add noise without
// value).
export interface LearnerAuditLogQuery {
  from?: string;
  to?: string;
  page?: string;
  limit?: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

export const listLearnerAuditLogService = async (
  learnerId: string,
  orgId: string | null | undefined,
  query: LearnerAuditLogQuery,
): Promise<ApiResponse> => {
  if (!learnerId || !Types.ObjectId.isValid(learnerId)) {
    throw new ApiError(
      400,
      "Learner context is required and must be a valid id",
    );
  }

  // Pagination — same bounds as org-admin endpoint for consistency.
  const rawPage = parseInt(query.page ?? "1", 10);
  const rawLimit = parseInt(query.limit ?? String(DEFAULT_PAGE_SIZE), 10);

  if (query.page !== undefined && (!Number.isFinite(rawPage) || rawPage < 1)) {
    throw new ApiError(400, "page must be an integer ≥ 1");
  }
  if (query.limit !== undefined) {
    if (
      !Number.isFinite(rawLimit) ||
      rawLimit < MIN_PAGE_SIZE ||
      rawLimit > MAX_PAGE_SIZE
    ) {
      throw new ApiError(
        400,
        `limit must be an integer between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE}`,
      );
    }
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

  // Pre-lookup match — hardcoded learner_id + defence-in-depth org_id.
  const match: Record<string, unknown> = {
    learner_id: new Types.ObjectId(learnerId),
  };
  if (orgId && Types.ObjectId.isValid(orgId)) {
    match.org_id = new Types.ObjectId(orgId);
  }

  // Reuse shared filter applier for date range (it skips
  // learner_id/action because those aren't on the LearnerAuditLogQuery
  // type — TypeScript guarantees they're absent at this point).
  applyAuditLogQueryFilters(match, query as OrgAdminAuditLogQuery);

  const pipeline: PipelineStage[] = [
    { $match: match },
    buildAuditLogFacet({ skip, limit }),
  ];

  const [facetResult] = await AuditLog.aggregate(pipeline);
  const rows = (
    (facetResult?.rows ?? []) as Array<Record<string, unknown>>
  ).map((r) => normaliseAuditLogRow(r));
  const total = (facetResult?.total?.[0]?.value as number | undefined) ?? 0;

  return new ApiResponse(200, "Audit log retrieved", {
    rows,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.ceil(total / limit) || 1,
    },
  });
};
