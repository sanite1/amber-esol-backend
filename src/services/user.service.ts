import * as bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomBytes } from "crypto";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
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
import { IdParam } from "../interfaces/helper.interface";
import {
  sendVerificationMail,
  sendForgotPasswordMail,
  sendWelcomeMail,
  sendAccountDeletedMail,
} from "./nodemailer/mail.service";
import { IUserDecoded } from "../middlewares/authMiddleWare";
import { createNotification } from "./notification.service";

const saltRounds = 13;

/* ── Helper: generate JWT tokens ── */

const generateTokens = (user: any) => {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    throw new ApiError(500, "JWT secret is not configured");
  }

  const payload = {
    id: user._id,
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email,
    role: user.role,
    profilePicture: user.profilePicture,
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "5h" });
  const refreshToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

  return { accessToken, refreshToken };
};

/* ── Register Student ── */

export const registerStudentService = async (data: ICreateStudentRequest) => {
  const existingUser = await User.findOne({ email: data.email });
  if (existingUser) {
    throw new ApiError(400, `User with ${data.email} already exists`);
  }

  const hashedPassword = await bcrypt.hash(data.password, saltRounds);
  const verificationToken = randomBytes(32).toString("hex");

  const student = await User.create({
    ...data,
    password: hashedPassword,
    verificationToken,
    role: "student",
    totalLessonsTaken: 0,
    totalHoursLearned: 0,
    currentStreak: 0,
    longestStreak: 0,
  });

  await sendVerificationMail(student);

  return new ApiResponse(
    201,
    "Student registered successfully. Please verify your email.",
    student.toJSON()
  );
};

/* ── Register Tutor ── */

export const registerTutorService = async (data: ICreateTutorRequest) => {
  const existingUser = await User.findOne({ email: data.email });
  if (existingUser) {
    throw new ApiError(400, `User with ${data.email} already exists`);
  }

  const hashedPassword = await bcrypt.hash(data.password, saltRounds);
  const verificationToken = randomBytes(32).toString("hex");

  const tutor = await User.create({
    ...data,
    password: hashedPassword,
    verificationToken,
    role: "tutor",
    ratings: [],
    averageRating: 0,
    totalLessons: 0,
    totalStudents: 0,
    numberOfReviews: 0,
    completionRate: 100,
  });

  await sendVerificationMail(tutor);

  return new ApiResponse(
    201,
    "Tutor registered successfully. Please verify your email.",
    tutor.toJSON()
  );
};

/* ── Register Admin ── */

export const registerAdminService = async (data: ICreateAdminRequest) => {
  const existingUser = await User.findOne({ email: data.email });
  if (existingUser) {
    throw new ApiError(400, `User with ${data.email} already exists`);
  }

  const hashedPassword = await bcrypt.hash(data.password, saltRounds);
  const verificationToken = randomBytes(32).toString("hex");

  const admin = await User.create({
    ...data,
    password: hashedPassword,
    verificationToken,
    role: "admin",
  });

  await sendVerificationMail(admin);

  return new ApiResponse(
    201,
    "Admin registered successfully. Please verify your email.",
    admin.toJSON()
  );
};

/* ── Login (all roles) ── */

export const loginService = async (data: ILoginRequest) => {
  const user = await User.findOne({ email: data.email });

  if (!user) {
    throw new ApiError(400, "Invalid email or password");
  }

  const isValidPassword = await bcrypt.compare(data.password, user.password);
  if (!isValidPassword) {
    throw new ApiError(400, "Invalid email or password");
  }

  if (!user.verified) {
    throw new ApiError(400, "Please verify your email before logging in");
  }

  if (!user.isActive) {
    throw new ApiError(
      403,
      "Your account has been suspended. Please contact support."
    );
  }

  // Update last login
  user.lastLogin = new Date();
  user.onlineStatus = "online";
  await user.save();

  const tokens = generateTokens(user);

  return new ApiResponse(200, "Login successful", {
    ...tokens,
    user: user.toJSON(),
  });
};

/* ── Refresh Token ── */

export const refreshService = async (data: IRefreshTokenRequest) => {
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    throw new ApiError(500, "JWT secret is not configured");
  }

  const decoded = jwt.verify(data.token, JWT_SECRET) as IUserDecoded;
  if (!decoded) {
    throw new ApiError(400, "Invalid token");
  }

  if (decoded.exp && decoded.exp * 1000 < Date.now()) {
    throw new ApiError(401, "Refresh token has expired");
  }

  const user = await User.findById(decoded.id);
  if (!user) {
    throw new ApiError(401, "User not found");
  }

  if (!user.isActive) {
    throw new ApiError(403, "Account is suspended");
  }

  const payload = {
    id: user._id,
    firstname: user.firstname,
    lastname: user.lastname,
    email: user.email,
    role: user.role,
    profilePicture: user.profilePicture,
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: "5h" });

  return new ApiResponse(200, "Token refreshed successfully", { accessToken });
};

/* ── Verify Email ── */

export const verifyEmailService = async (params: IVerifyParams) => {
  const user = await User.findOne({
    _id: params.id,
    verificationToken: params.token,
  });

  if (!user) {
    throw new ApiError(400, "Invalid verification link");
  }

  user.verified = true;
  user.verificationToken = undefined;
  await user.save();

  // Send welcome email (non-blocking)
  sendWelcomeMail(user).catch(() => {});

  return new ApiResponse(200, "Email verified successfully");
};

/* ── Forgot Password ── */

export const forgotPasswordService = async (data: IForgotPasswordRequest) => {
  const user = await User.findOne({ email: data.email });

  if (!user) {
    // Don't reveal whether user exists
    return new ApiResponse(
      200,
      "If an account with that email exists, a reset link has been sent."
    );
  }

  if (!user.verified) {
    throw new ApiError(400, "Please verify your email first");
  }

  const token = randomBytes(32).toString("hex");
  user.resetToken = token;

  const expires = new Date();
  expires.setHours(expires.getHours() + 1);
  user.resetTokenExpires = expires;

  await user.save();
  await sendForgotPasswordMail(user);

  return new ApiResponse(
    200,
    "If an account with that email exists, a reset link has been sent."
  );
};

/* ── Reset Password ── */

export const resetPasswordService = async (
  params: IVerifyParams,
  data: IResetPasswordRequest
) => {
  const user = await User.findOne({
    _id: params.id,
    resetToken: params.token,
  });

  if (!user) {
    throw new ApiError(400, "Invalid or expired reset link");
  }

  if (user.resetTokenExpires && user.resetTokenExpires.getTime() < Date.now()) {
    user.resetToken = undefined;
    user.resetTokenExpires = undefined;
    await user.save();
    throw new ApiError(400, "Reset link has expired");
  }

  const hashedPassword = await bcrypt.hash(data.password, saltRounds);
  user.password = hashedPassword;
  user.resetToken = undefined;
  user.resetTokenExpires = undefined;

  await user.save();

  return new ApiResponse(200, "Password reset successfully");
};

/* ── Update Password (authenticated) ── */

export const updatePasswordService = async (
  params: IdParam,
  data: IUpdatePasswordRequest
) => {
  const user = await User.findById(params.id);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const isValidPassword = await bcrypt.compare(data.oldPassword, user.password);
  if (!isValidPassword) {
    throw new ApiError(400, "Current password is incorrect");
  }

  const hashedPassword = await bcrypt.hash(data.newPassword, saltRounds);
  user.password = hashedPassword;
  await user.save();

  return new ApiResponse(200, "Password updated successfully");
};

/* ── Get User By Id ── */

export const getUserByIdService = async (params: IdParam) => {
  const user = await User.findById(params.id);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  return new ApiResponse(200, "User retrieved successfully", user.toJSON());
};

/* ── Update User Profile ── */

export const updateUserService = async (
  params: IdParam,
  data: IUpdateUserRequest
) => {
  const user = await User.findByIdAndUpdate(params.id, data, {
    new: true,
    runValidators: true,
  });

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  // Return fresh tokens with updated profile data
  const tokens = generateTokens(user);

  return new ApiResponse(200, "Profile updated successfully", {
    ...tokens,
    user: user.toJSON(),
  });
};

/* ── Get Tutors (public listing with filters & pagination) ── */

export interface TutorQueryOptions {
  page?: string;
  limit?: string;
  search?: string;
  sort?: string;
  language?: string;
  specialization?: string;
  minPrice?: string;
  maxPrice?: string;
  level?: string;
}

export const getTutorsService = async (options: TutorQueryOptions) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "12", 10);
  const skip = (page - 1) * limit;

  // Build query
  const query: any = {
    role: "tutor",
    isActive: true,
    verified: true,
  };

  // Search by name
  if (options.search) {
    const searchRegex = new RegExp(options.search, "i");
    query.$or = [
      { firstname: searchRegex },
      { lastname: searchRegex },
      { bio: searchRegex },
      { specializations: searchRegex },
    ];
  }

  // Filter by language
  if (options.language) {
    query.languages = { $in: [options.language] };
  }

  // Filter by specialization
  if (options.specialization) {
    query.specializations = { $in: [options.specialization] };
  }

  // Filter by price range
  if (options.minPrice || options.maxPrice) {
    query.hourlyRate = {};
    if (options.minPrice) query.hourlyRate.$gte = parseFloat(options.minPrice);
    if (options.maxPrice) query.hourlyRate.$lte = parseFloat(options.maxPrice);
  }

  // Filter by preferred level
  if (options.level) {
    query["teachingPreferences.preferredLevels"] = { $in: [options.level] };
  }

  // Sort
  let sortOption: any = { averageRating: -1 }; // default: highest rated
  switch (options.sort) {
    case "rating":
      sortOption = { averageRating: -1 };
      break;
    case "price_low":
      sortOption = { hourlyRate: 1 };
      break;
    case "price_high":
      sortOption = { hourlyRate: -1 };
      break;
    case "experience":
      sortOption = { yearsOfExperience: -1 };
      break;
    case "newest":
      sortOption = { createdAt: -1 };
      break;
  }

  const [tutors, total] = await Promise.all([
    User.find(query).sort(sortOption).skip(skip).limit(limit),
    User.countDocuments(query),
  ]);

  return new ApiResponse(200, "Tutors retrieved successfully", {
    tutors,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
};

/* ── Update Online Status ── */

export const updateOnlineStatusService = async (
  userId: string,
  status: "online" | "offline" | "away"
) => {
  const updateData: any = { onlineStatus: status };
  if (status === "offline") {
    updateData.lastSeen = new Date();
  }

  await User.findByIdAndUpdate(userId, updateData);
};

/* ── Suspend User (admin) ── */

export const suspendUserService = async (
  userId: string,
  data: { reason: string }
) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  if (!user.isActive) {
    throw new ApiError(400, "User is already suspended");
  }

  user.isActive = false;
  user.status = "suspended";
  user.suspendedAt = new Date();
  user.suspendedReason = data.reason;
  await user.save();

  // Notify user via in-app notification
  createNotification({
    userId: user._id,
    type: "account_suspended",
    title: "Account Suspended",
    message: `Your account has been suspended.${data.reason ? ` Reason: ${data.reason}` : ""} Please contact support if you believe this is an error.`,
    data: {
      reason: data.reason,
      suspendedAt: user.suspendedAt.toISOString(),
    },
  }).catch((err) =>
    console.error("Error creating suspension notification:", err)
  );

  return new ApiResponse(200, "User suspended successfully", user.toJSON());
};

/* ── Reactivate User (admin) ── */

export const reactivateUserService = async (userId: string) => {
  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(404, "User not found");
  }

  if (user.isActive) {
    throw new ApiError(400, "User is already active");
  }

  user.isActive = true;
  user.status = "active";
  // user.suspendedAt = undefined;
  // user.suspendedReason = undefined;
  await user.save();

  // Notify user via in-app notification
  createNotification({
    userId: user._id,
    type: "account_reactivated",
    title: "Account Reactivated",
    message:
      "Your account has been reactivated. Welcome back! You can now access all features of the platform.",
    data: {
      reactivatedAt: new Date().toISOString(),
    },
  }).catch((err) =>
    console.error("Error creating reactivation notification:", err)
  );

  return new ApiResponse(200, "User reactivated successfully", user.toJSON());
};

/* ── Delete Account ── */

export const deleteAccountService = async (
  id: string,
  data: { reason: string; feedback?: string }
) => {
  const user = await User.findById(id);

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  if (user.status === "terminated") {
    throw new ApiError(400, "Account is already terminated");
  }

  // Update user status to terminated
  user.status = "terminated";

  // Optionally store deletion reason and feedback for analytics
  user.deletionReason = data.reason;
  user.deletionFeedback = data.feedback || "";
  user.deletedAt = new Date();

  await user.save();

  // Send account deletion confirmation email
  await sendAccountDeletedMail(user);

  return new ApiResponse(200, "Account has been successfully deleted");
};
