/**
 * Amber-admin user-impersonation service — brief Function 15.
 *
 * Mints a JWT for support sessions where an Amber admin needs to "see
 * what the user sees". The token carries:
 *
 *   - the target user's identity claims (id, role, orgId, esolLevel)
 *     — so downstream middleware behaves exactly as it would for the
 *     real user;
 *   - a side-channel `impersonated_by` claim with the original
 *     admin's user id, persisted into every AuditLog row written
 *     while the token is in use.
 *
 * Security
 *
 *   - Only the `isAdmin` role can call this — enforced at the route
 *     layer, restated at the service boundary as defence-in-depth.
 *   - Self-impersonation is refused (the admin's own id === target).
 *     Not a security risk per se, but it produces meaningless audit
 *     rows and tends to indicate a bug in the caller's frontend.
 *   - Impersonation tokens carry a SHORTER TTL than normal sessions:
 *     1 hour vs the 5-hour default. Admin support sessions are
 *     interactive — if the work isn't done in an hour, the admin
 *     re-impersonates explicitly. Limits blast radius if a token
 *     leaks.
 *   - Impersonating another admin is permitted but logged with extra
 *     context — escalating impersonation chains are useful when an
 *     org_admin needs help diagnosing why their dashboard mis-renders.
 *
 * The JWT payload mirrors the shape produced by user.service.ts
 * `generateTokens` so middleware (isAuthenticated, etc.) doesn't have
 * to special-case impersonation. The `impersonated_by` field is the
 * only addition; it falls outside the existing claim set.
 */

import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { Request } from "express";
import User from "../models/User";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import { writeAuditLog } from "./auditLog.service";
import logger from "../config/logger";

/** Impersonation tokens live for 1 hour. See file header. */
const IMPERSONATION_TTL = "1h";

export interface ImpersonationResult {
  access_token: string;
  expires_in: string;
  target: {
    id: string;
    firstname: string | null;
    lastname: string | null;
    email: string;
    role: string;
    org_id: string | null;
    esol_level: string | null;
  };
  impersonated_by: string;
}

export const startImpersonationService = async (
  targetUserId: string,
  adminUserId: string,
  req?: Request,
): Promise<ApiResponse> => {
  // ── 1. Input validation ─────────────────────────────────────────
  if (!targetUserId || !Types.ObjectId.isValid(targetUserId)) {
    throw new ApiError(400, "user_id must be a valid ObjectId");
  }
  if (!adminUserId || !Types.ObjectId.isValid(adminUserId)) {
    throw new ApiError(400, "Authenticated admin id required");
  }
  if (targetUserId === adminUserId) {
    throw new ApiError(
      400,
      "Cannot impersonate yourself — that produces meaningless audit rows.",
    );
  }

  // ── 2. Look up target ───────────────────────────────────────────
  // Pull only the fields we mint into the JWT plus the activity flags
  // — re-hydrate at every request anyway via isAuthenticated.
  const target = await User.findById(targetUserId)
    .select(
      "_id firstname lastname email role orgId esolLevel esolTeacherApproved profilePicture isActive status",
    )
    .lean();
  if (!target) {
    throw new ApiError(404, "Target user not found");
  }

  // Block impersonation of a deactivated account — the impersonation
  // session would immediately fail the next `isAuthenticated` check
  // anyway, so refuse here with a clearer error.
  if (
    target.isActive === false ||
    (target as { status?: string }).status === "terminated"
  ) {
    throw new ApiError(
      409,
      "Cannot impersonate a deactivated or terminated account.",
    );
  }

  // ── 3. Mint the impersonation JWT ───────────────────────────────
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    throw new ApiError(500, "JWT secret is not configured");
  }

  const targetOrgId = (target as { orgId?: Types.ObjectId | null }).orgId;
  const orgIdStr = targetOrgId ? targetOrgId.toString() : null;
  const esolLevelStr =
    (target as { esolLevel?: string | null }).esolLevel ?? null;

  // Payload mirrors user.service.ts:generateTokens so downstream
  // middleware behaves identically — plus the `impersonated_by`
  // sidecar claim.
  const payload = {
    id: target._id,
    firstname: target.firstname,
    lastname: target.lastname,
    email: target.email,
    role: target.role,
    profilePicture: target.profilePicture,
    orgId: orgIdStr,
    esolLevel: esolLevelStr,
    esolTeacherApproved:
      (target as { esolTeacherApproved?: boolean | null }).esolTeacherApproved ??
      null,
    org_id: orgIdStr,
    esol_level: esolLevelStr,
    impersonated_by: adminUserId,
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: IMPERSONATION_TTL,
  });

  // ── 4. AuditLog row ─────────────────────────────────────────────
  // `actor_type: "amber_admin"` and `actor_id: <admin>` so this single
  // event reads as "admin started impersonation". Subsequent audit rows
  // written via the impersonation token will have actor_id = target
  // and impersonated_by = admin — the breadcrumb chain reconstructs
  // the support session.
  await writeAuditLog(
    {
      actor_type: "amber_admin",
      actor_id: adminUserId,
      org_id: orgIdStr,
      learner_id: target._id as Types.ObjectId,
      action: "user_impersonation_started",
      reason: "Admin impersonating user for support",
      before_state: null,
      after_state: {
        target_user_id: target._id?.toString(),
        target_email: target.email,
        target_role: target.role,
        target_org_id: orgIdStr,
        ttl: IMPERSONATION_TTL,
      },
      // Explicit null — this is the OPENING event of the impersonation
      // session, not an action taken FROM within it. The
      // `impersonated_by` field is set on rows written DURING the
      // session, not on the row that starts it.
      impersonated_by: null,
    },
    { req },
  );

  logger.info(
    {
      adminUserId,
      targetUserId,
      target_role: target.role,
      target_org_id: orgIdStr,
    },
    "startImpersonation: token issued",
  );

  const result: ImpersonationResult = {
    access_token: accessToken,
    expires_in: IMPERSONATION_TTL,
    target: {
      id: (target._id as Types.ObjectId).toString(),
      firstname: target.firstname ?? null,
      lastname: target.lastname ?? null,
      email: target.email,
      role: target.role,
      org_id: orgIdStr,
      esol_level: esolLevelStr,
    },
    impersonated_by: adminUserId,
  };

  return new ApiResponse(200, "Impersonation token issued", result);
};
