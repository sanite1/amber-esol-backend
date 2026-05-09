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
  orgId?: string | null;
  esolLevel?: string | null;
  esolTeacherApproved?: boolean | null;
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
      .select("isActive status role orgId esolLevel esolTeacherApproved")
      .lean();

    if (!user || !user.isActive || user.status === "terminated") {
      throw new ApiError(401, "Account is deactivated");
    }

    const fresh: IUserDecoded = {
      ...decoded,
      role: user.role,
      orgId: user.orgId ? user.orgId.toString() : null,
      esolLevel: user.esolLevel ?? null,
      esolTeacherApproved: user.esolTeacherApproved ?? null,
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
  next: NextFunction
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
