import { NextFunction, Request, Response } from "express";
import ApiError from "../errors/apiError";
import { ExpressFunction, IdParam } from "../interfaces/helper.interface";
import {
  ICreateStudentRequest,
  ICreateTutorRequest,
  ICreateAdminRequest,
  ILoginRequest,
  IRefreshTokenRequest,
  IForgotPasswordRequest,
  IResetPasswordRequest,
  IUpdatePasswordRequest,
  IUpdateUserRequest,
  IVerifyParams,
} from "../interfaces/user.interface";
import User from "../models/User";
import { cloudinaryImageUpload } from "../services/cloudinary.service";
import {
  registerStudentService,
  registerTutorService,
  registerAdminService,
  loginService,
  refreshService,
  verifyEmailService,
  forgotPasswordService,
  resetPasswordService,
  updatePasswordService,
  getUserByIdService,
  updateUserService,
  getTutorsService,
  TutorQueryOptions,
  deleteAccountService,
} from "../services/user.service";
import { Types } from "mongoose";

/* ── Register Student ── */

export const registerStudent: ExpressFunction<ICreateStudentRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const files = req.files as
      | { [fieldname: string]: Express.Multer.File[] }
      | undefined;

    if (files && files.profilePicture) {
      const profilePicture = files.profilePicture[0];
      if (profilePicture) {
        const result = await cloudinaryImageUpload(
          profilePicture.buffer,
          "Amber_Users",
        );
        req.body.profilePicture = result.secure_url;
      }
    }

    const data = await registerStudentService(req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Register Tutor ── */

export const registerTutor: ExpressFunction<ICreateTutorRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const files = req.files as
      | { [fieldname: string]: Express.Multer.File[] }
      | undefined;

    if (files && files.profilePicture) {
      const profilePicture = files.profilePicture[0];
      if (profilePicture) {
        const result = await cloudinaryImageUpload(
          profilePicture.buffer,
          "Amber_Users",
        );
        req.body.profilePicture = result.secure_url;
      }
    }

    const data = await registerTutorService(req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Register Admin ── */

export const registerAdmin: ExpressFunction<ICreateAdminRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const files = req.files as
      | { [fieldname: string]: Express.Multer.File[] }
      | undefined;

    if (files && files.profilePicture) {
      const profilePicture = files.profilePicture[0];
      if (profilePicture) {
        const result = await cloudinaryImageUpload(
          profilePicture.buffer,
          "Amber_Users",
        );
        req.body.profilePicture = result.secure_url;
      }
    }

    const data = await registerAdminService(req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Login ── */

export const login: ExpressFunction<ILoginRequest> = async (req, res, next) => {
  try {
    const data = await loginService(req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Refresh Token ── */

export const refresh: ExpressFunction<IRefreshTokenRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const data = await refreshService(req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Verify Email ── */

export const verifyEmail: ExpressFunction = async (req, res, next) => {
  try {
    const { id, token } = req.params as { id: string; token: string };
    const objectId = new Types.ObjectId(id);
    const data = await verifyEmailService({ id: objectId, token });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Forgot Password ── */

export const forgotPassword: ExpressFunction<IForgotPasswordRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const data = await forgotPasswordService(req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Reset Password ── */

export const resetPassword: ExpressFunction<IResetPasswordRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const { id, token } = req.params as { id: string; token: string };
    const objectId = new Types.ObjectId(id);
    const data = await resetPasswordService({ id: objectId, token }, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Update Password ── */

export const updatePassword: ExpressFunction<IUpdatePasswordRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const response = await updatePasswordService(
      (req as any).user!.id,
      req.body,
    );
    return res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

/* ── Get User By Id ── */

export const getUserById: ExpressFunction = async (req, res, next) => {
  try {
    const data = await getUserByIdService(req.params as IdParam);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Update User Profile ── */

export const updateUser: ExpressFunction<IUpdateUserRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const files = req.files as
      | { [fieldname: string]: Express.Multer.File[] }
      | undefined;

    if (files && files.profilePicture) {
      const profilePicture = files.profilePicture[0];
      if (profilePicture) {
        const result = await cloudinaryImageUpload(
          profilePicture.buffer,
          "Amber_Users",
        );
        req.body.profilePicture = result.secure_url;
      }
    }

    const data = await updateUserService(req.params as IdParam, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/* ── Get Tutors (public) ── */

export const getTutors = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const data = await getTutorsService(req.query as TutorQueryOptions);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const deleteAccount = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await deleteAccountService(
      req.params.id as string,
      req.body,
    );
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};
