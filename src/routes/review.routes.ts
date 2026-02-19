import { Router } from "express";
import {
  isAuthenticated,
  isStudent,
  isTutor,
  isAdmin,
} from "../middlewares/authMiddleWare";
import {
  createReviewValidation,
  getTutorReviewsValidation,
  getMyReviewsValidation,
  updateReviewValidation,
  deleteReviewValidation,
  addReplyValidation,
  updateReplyValidation,
  deleteReplyValidation,
  reportReviewValidation,
  helpfulReviewValidation,
  reviewStatsValidation,
  adminListReviewsValidation,
  adminReviewActionValidation,
  adminReportActionValidation,
} from "../validations/review.validation";
import {
  createReview,
  getTutorReviews,
  getMyReviews,
  updateReview,
  deleteReview,
  addReply,
  updateReply,
  deleteReply,
  reportReview,
  toggleHelpful,
  getReviewStats,
  adminListReviews,
  adminHideReview,
  adminUnhideReview,
  adminRemoveReview,
  adminRestoreReview,
  adminHandleReport,
} from "../controllers/review.controller";

const router = Router();

// ── Student: Create review ──
router.post(
  "/",
  isAuthenticated,
  isStudent,
  createReviewValidation(),
  createReview
);

// ── Authenticated: My reviews (student's own reviews) ──
router.get("/me", isAuthenticated, getMyReviewsValidation(), getMyReviews);

// ── Public: Tutor reviews ──
router.get("/tutor/:tutorId", getTutorReviewsValidation(), getTutorReviews);

// ── Public: Review stats for a tutor ──
router.get("/stats/:tutorId", reviewStatsValidation(), getReviewStats);

// ── Student: Update own review ──
router.patch(
  "/:id",
  isAuthenticated,
  isStudent,
  updateReviewValidation(),
  updateReview
);

// ── Student: Delete own review ──
router.delete(
  "/:id",
  isAuthenticated,
  isStudent,
  deleteReviewValidation(),
  deleteReview
);

// ── Tutor: Reply CRUD ──
router.post(
  "/:id/reply",
  isAuthenticated,
  isTutor,
  addReplyValidation(),
  addReply
);
router.patch(
  "/:id/reply",
  isAuthenticated,
  isTutor,
  updateReplyValidation(),
  updateReply
);
router.delete(
  "/:id/reply",
  isAuthenticated,
  isTutor,
  deleteReplyValidation(),
  deleteReply
);

// ── Authenticated: Report a review ──
router.post(
  "/:id/report",
  isAuthenticated,
  reportReviewValidation(),
  reportReview
);

// ── Authenticated: Toggle helpful ──
router.post(
  "/:id/helpful",
  isAuthenticated,
  helpfulReviewValidation(),
  toggleHelpful
);

// ── Admin: List all reviews ──
router.get(
  "/admin",
  isAuthenticated,
  isAdmin,
  adminListReviewsValidation(),
  adminListReviews
);

// ── Admin: Hide / Unhide / Remove / Restore ──
router.patch(
  "/:id/hide",
  isAuthenticated,
  isAdmin,
  adminReviewActionValidation(),
  adminHideReview
);
router.patch(
  "/:id/unhide",
  isAuthenticated,
  isAdmin,
  adminReviewActionValidation(),
  adminUnhideReview
);
router.patch(
  "/:id/remove",
  isAuthenticated,
  isAdmin,
  adminReviewActionValidation(),
  adminRemoveReview
);
router.patch(
  "/:id/restore",
  isAuthenticated,
  isAdmin,
  adminReviewActionValidation(),
  adminRestoreReview
);

// ── Admin: Handle individual report ──
router.patch(
  "/:id/reports/:reportId",
  isAuthenticated,
  isAdmin,
  adminReportActionValidation(),
  adminHandleReport
);

export default router;
