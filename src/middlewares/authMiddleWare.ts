import jwt, { JwtPayload } from "jsonwebtoken";
import ApiError from "../errors/apiError";
import { ExpressFunction } from "../interfaces/helper.interface";

import { Request } from "express";
import { Types } from "mongoose";
import User from "../models/User";

export interface IUserDecoded extends JwtPayload {
  id: Types.ObjectId;
  firstname: string;
  lastname: string;
  email: string;
  role: string;
  profilePicture: string;
}

export const isAuthenticated: ExpressFunction = (req, _res, next) => {
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

    (req as Request & { user?: IUserDecoded }).user = decoded;
    next();
  } catch (error) {
    next(error);
  }
};

export const isAdmin: ExpressFunction = async (req, _res, next) => {
  try {
    const user = await User.findById(req.user?.id);
    if (!user || user.role !== "admin") {
      throw new ApiError(403, "Forbidden: Admin access required");
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const isTutor: ExpressFunction = async (req, _res, next) => {
  try {
    const user = await User.findById(req.user?.id);
    if (!user || user.role !== "tutor") {
      throw new ApiError(403, "Forbidden: Tutor access required");
    }
    next();
  } catch (error) {
    next(error);
  }
};

export const isStudent: ExpressFunction = async (req, _res, next) => {
  try {
    const user = await User.findById(req.user?.id);
    if (!user || user.role !== "student") {
      throw new ApiError(403, "Forbidden: Student access required");
    }
    next();
  } catch (error) {
    next(error);
  }
};
