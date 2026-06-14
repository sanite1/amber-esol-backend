import jwt, { JwtPayload } from "jsonwebtoken";
import ApiError from "../errors/apiError";
import { ExpressFunction } from "../interfaces/helper.interface";

import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import User from "../models/User";

export interface IUserDecoded extends JwtPayload {
  id: Types.ObjectId;
  firstname: string;
  lastname: string;
  email: string;
  role: string;
  profilePicture: string;
  // Existing camelCase fields (preserved for back-compat with services
  // that read req.user.orgId / req.user.esolLevel).
  orgId?: string | null;
  esolLevel?: string | null;
  esolTeacherApproved?: boolean | null;
  // Snake_case aliases per Project Silk brief Section 1 Task 10. Emitted
  // by generateTokens alongside the camelCase forms; populated here by
  // the DB re-hydration. Either form is safe to read.
  org_id?: string | null;
  esol_level?: string | null;
  /**
   * Final Addendum §9 — teacher-role gating. Snake_case aliases of
   * `esolTeacherApproved` and `dbsCheckStatus`, populated on every
   * authenticated request by the DB re-hydration below. Read by
   * `requireTeacherRole` (src/middlewares/teacherMiddleware.ts);
   * never trust the JWT-issued value for authorisation decisions —
   * both fields can be revoked between issue and expiry.
   */
  esol_teacher_approved?: boolean | null;
  dbs_check_status?: string | null;
  /**
   * Function 15 — present on JWTs issued via the
   * /api/admin/impersonate route. Carries the original Amber admin's
   * user id; the rest of the token's claims (id, role, orgId) reflect
   * the impersonated user. The audit-log helper reads this claim off
   * `req.user` to stamp `impersonated_by` on every row written during
   * the impersonation session.
   */
  impersonated_by?: string | null;
}

export const isAuthenticated: ExpressFunction = async (req, _res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new ApiError(401, "Unauthorized");
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      throw new ApiError(401, "Unauthorized");
    }

    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      throw new ApiError(500, "JWT secret is not configured");
    }

    const decoded = jwt.verify(token, JWT_SECRET) as IUserDecoded;

    if (decoded.exp && decoded.exp * 1000 < Date.now()) {
      throw new ApiError(401, "Token has expired");
    }

    // ── Verify account is still active AND re-hydrate role / orgId /
    // esolTeacherApproved from the database. The JWT carries these fields
    // for convenience but they can be revoked between issue and expiry,
    // so we never trust the JWT copy for authorisation decisions.
    const user = await User.findById(decoded.id)
      .select(
        "isActive status role orgId esolLevel esolTeacherApproved dbsCheckStatus",
      )
      .lean();

    if (!user || !user.isActive || user.status === "terminated") {
      throw new ApiError(401, "Account is deactivated");
    }

    // ── Org-context drift check (brief §1 Task 10) ─────────────────
    // If the user's organisation assignment has changed since the JWT
    // was issued (org_admin moved them between orgs, or they were
    // removed from an org), force a re-login. Continuing with a stale
    // org context would let the request operate on the wrong cohort.
    //
    // Compare DB value against EITHER naming form on the JWT (older
    // tokens issued before snake_case was added carry only `orgId`).
    const dbOrgId = user.orgId ? user.orgId.toString() : null;
    const jwtOrgId = (decoded.org_id ?? decoded.orgId ?? null) as string | null;
    if (dbOrgId !== jwtOrgId) {
      throw new ApiError(401, "Org context changed, please log in again");
    }

    const fresh: IUserDecoded = {
      ...decoded,
      role: user.role,
      orgId: dbOrgId,
      esolLevel: user.esolLevel ?? null,
      esolTeacherApproved: user.esolTeacherApproved ?? null,
      // Mirror snake_case forms so downstream code can read either.
      org_id: dbOrgId,
      esol_level: user.esolLevel ?? null,
      // Final Addendum §9 — re-hydrated snake_case teacher fields read
      // by `requireTeacherRole`. NEVER trust the JWT-issued values for
      // authorisation; both fields can be revoked between issue + expiry.
      esol_teacher_approved: user.esolTeacherApproved ?? null,
      dbs_check_status:
        (user as { dbsCheckStatus?: string | null }).dbsCheckStatus ?? null,
    };

    (req as Request & { user?: IUserDecoded }).user = fresh;
    next();
  } catch (error) {
    next(error);
  }
};

export const isAdmin: ExpressFunction = async (req, _res, next) => {
  try {
    // org_admin is explicitly excluded — use isOrgAdmin for org-scoped admin routes
    if (req.user?.role !== "admin") {
      return next(new ApiError(403, "Admin access required"));
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const isOrgAdmin: ExpressFunction = async (req, _res, next) => {
  try {
    const role = req.user?.role;
    if (role !== "org_admin" && role !== "admin") {
      return next(new ApiError(403, "Organisation admin access required"));
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const isTutor: ExpressFunction = async (req, _res, next) => {
  try {
    if (req.user?.role !== "tutor") {
      return next(new ApiError(403, "Tutor access required"));
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const isStudent: ExpressFunction = async (req, _res, next) => {
  try {
    if (req.user?.role !== "student") {
      return next(new ApiError(403, "Student access required"));
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const isCronAuthorized = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return next(new ApiError(500, "CRON_SECRET is not configured"));
  }

  const authHeader = req.headers.authorization;

  if (authHeader === `Bearer ${secret}`) {
    return next();
  }

  return next(new ApiError(401, "Unauthorized"));
};
