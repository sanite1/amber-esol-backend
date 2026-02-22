import { Router } from "express";
import { upload } from "../config/upload";
import { isAuthenticated } from "../middlewares/authMiddleWare";
import {
  parseJsonFields,
  registerStudentValidation,
  registerTutorValidation,
  registerAdminValidation,
  loginValidation,
  refreshTokenValidation,
  forgotPasswordValidation,
  verifyEmailValidation,
  resetPasswordValidation,
  updatePasswordValidation,
  getUserByIdValidation,
  updateUserValidation,
  getTutorsValidation,
  deleteAccountValidation,
} from "../validations/user.validation";
import {
  registerStudent,
  registerTutor,
  registerAdmin,
  login,
  refresh,
  verifyEmail,
  forgotPassword,
  resetPassword,
  updatePassword,
  getUserById,
  updateUser,
  getTutors,
  deleteAccount,
} from "../controllers/user.controller";
import { authLimiter, passwordResetLimiter } from "../config/rateLimiter";

const router = Router();

// ── Registration ──
router.post(
  "/register/student",
  upload.fields([{ name: "profilePicture", maxCount: 1 }]),
  parseJsonFields,
  authLimiter,
  registerStudentValidation(),
  registerStudent
);

router.post(
  "/register/tutor",
  upload.fields([{ name: "profilePicture", maxCount: 1 }]),
  parseJsonFields,
  authLimiter,
  registerTutorValidation(),
  registerTutor
);

router.post(
  "/register/admin",
  upload.fields([{ name: "profilePicture", maxCount: 1 }]),
  authLimiter,
  registerAdminValidation(),
  registerAdmin
);

// ── Auth ──
router.post("/login", authLimiter, loginValidation(), login);
router.post("/refresh", authLimiter, refreshTokenValidation(), refresh);
router.post(
  "/forgot-password",
  passwordResetLimiter,
  forgotPasswordValidation(),
  forgotPassword
);

// ── Email Verification ──
router.get(
  "/verify/:id/:token",
  authLimiter,
  verifyEmailValidation(),
  verifyEmail
);

// ── Password Reset ──
router.patch(
  "/reset-password/:id/:token",
  passwordResetLimiter,
  resetPasswordValidation(),
  resetPassword
);

// ── Password Update (authenticated) ──
router.patch(
  "/update-password",
  isAuthenticated,
  updatePasswordValidation(),
  updatePassword
);

// ── Tutor Listing (public) ──
router.get("/tutors", getTutorsValidation(), getTutors);

// ── User Profile (authenticated) ──
router
  .route("/:id")
  .get(getUserByIdValidation(), getUserById)
  .patch(
    isAuthenticated,
    upload.fields([{ name: "profilePicture", maxCount: 1 }]),
    parseJsonFields,
    updateUserValidation(),
    updateUser
  );

router.delete(
  "/:id",
  isAuthenticated,
  deleteAccountValidation(),
  deleteAccount
);

export default router;
