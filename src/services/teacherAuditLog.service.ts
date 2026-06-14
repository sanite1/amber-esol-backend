/**
 * Teacher-scoped audit log endpoint — Final Addendum §6 (BE-C surface).
 *
 * Backs `GET /api/teacher/learners/:id/audit-log`. A teacher sees the
 * audit log for ONE of their assigned learners. The endpoint
 * enforces:
 *   • The learner exists (`role === "student"`) — 404 otherwise.
 *   • The learner is assigned to the calling teacher — 403 otherwise.
 *     (The 404-vs-403 disambiguation matches `teacherLearnerDetail`'s
 *     gate to avoid leaking learner existence via crafted GETs.)
 *
 * Response shape matches the org-admin endpoint so the frontend's
 * `AuditLog.tsx` can be reused in embedded mode.
 *
 * Build pattern: share helpers with the org-admin service for the
 * expensive $lookup + projection logic. The Phase 1 refactor extracted
 * `applyAuditLogQueryFilters`, `buildAuditLogFacet`, and
 * `normaliseAuditLogRow` for that purpose.
 */

import { PipelineStage, Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AuditLog from "../models/AuditLog";
import User from "../models/User";
import {
  applyAuditLogQueryFilters,
  buildAuditLogFacet,
  normaliseAuditLogRow,
  OrgAdminAuditLogQuery,
  OrgAdminAuditLogRow,
} from "./orgAdminAuditLog.service";

export type TeacherAuditLogRow = OrgAdminAuditLogRow;

// Teacher endpoint accepts action + date range + pagination. learner_id
// comes from the route param (locked to the assigned learner).
export interface TeacherAuditLogQuery {
  action?: string;
  from?: string;
  to?: string;
  page?: string;
  limit?: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MIN_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

export const listTeacherAuditLogService = async (
  teacherId: string,
  learnerId: string,
  query: TeacherAuditLogQuery,
): Promise<ApiResponse> => {
  if (!teacherId || !Types.ObjectId.isValid(teacherId)) {
    throw new ApiError(400, "Teacher context is required");
  }
  if (!learnerId || !Types.ObjectId.isValid(learnerId)) {
    throw new ApiError(400, "learner id must be a valid ObjectId");
  }

  // ── Access control gate — matches teacherLearnerDetail.service ──
  // Narrow projection just to check assignment; the audit query is
  // separate. 404 first (learner not found at all), then 403
  // (exists but not assigned), to avoid leaking learner-ULN
  // existence via crafted GETs.
  const assignmentCheck = await User.findById(learnerId)
    .select("_id assigned_teacher_id role orgId")
    .lean();
  if (!assignmentCheck) {
    throw new ApiError(404, "Learner not found");
  }
  if ((assignmentCheck as { role?: string }).role !== "student") {
    throw new ApiError(404, "Learner not found");
  }
  const assignedTo = (
    assignmentCheck as { assigned_teacher_id?: Types.ObjectId | null }
  ).assigned_teacher_id;
  if (!assignedTo || assignedTo.toString() !== teacherId) {
    throw new ApiError(403, "Forbidden — this learner is not assigned to you.");
  }

  // ── Pagination ─────────────────────────────────────────────────
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

  // ── Pre-lookup match — locked to this learner, scoped to their
  //    org_id as defence-in-depth (the gate above already ensured the
  //    teacher belongs to this org, but pinning the audit query to the
  //    same org_id means a future bug elsewhere can't leak across).
  const match: Record<string, unknown> = {
    learner_id: new Types.ObjectId(learnerId),
  };
  const learnerOrgId = (assignmentCheck as { orgId?: Types.ObjectId | null })
    .orgId;
  if (learnerOrgId) {
    match.org_id = learnerOrgId;
  }

  // Share the date/action filter logic with the org-admin path.
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
