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

const router = Router();

// ── Registration ──
router.post(
  "/register/student",
  upload.fields([{ name: "profilePicture", maxCount: 1 }]),
  parseJsonFields,
  registerStudentValidation(),
  registerStudent
);

router.post(
  "/register/tutor",
  upload.fields([{ name: "profilePicture", maxCount: 1 }]),
  parseJsonFields,
  registerTutorValidation(),
  registerTutor
);

router.post(
  "/register/admin",
  upload.fields([{ name: "profilePicture", maxCount: 1 }]),
  registerAdminValidation(),
  registerAdmin
);

// ── Auth ──
router.post("/login", loginValidation(), login);
router.post("/refresh", refreshTokenValidation(), refresh);
router.post("/forgot-password", forgotPasswordValidation(), forgotPassword);

// ── Email Verification ──
router.get("/verify/:id/:token", verifyEmailValidation(), verifyEmail);

// ── Password Reset ──
router.patch(
  "/reset-password/:id/:token",
  resetPasswordValidation(),
  resetPassword
);

// ── Password Update (authenticated) ──
router.patch(
  "/update-password/:id",
  isAuthenticated,
  updatePasswordValidation(),
  updatePassword
);

// ── Tutor Listing (public) ──
router.get("/tutors", getTutorsValidation(), getTutors);

// ── User Profile (authenticated) ──
router
  .route("/:id")
  .get(isAuthenticated, getUserByIdValidation(), getUserById)
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
