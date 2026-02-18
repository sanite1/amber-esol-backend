import { Router, raw } from "express";
import {
  isAuthenticated,
  isStudent,
  isTutor,
} from "../middlewares/authMiddleWare";
import {
  createBookingValidation,
  listBookingsValidation,
  upcomingBookingsValidation,
  getBookingByIdValidation,
  confirmBookingValidation,
  declineBookingValidation,
  cancelBookingValidation,
  completeBookingValidation,
  noShowBookingValidation,
} from "../validations/booking.validation";
import {
  createBooking,
  stripeWebhook,
  listBookings,
  getBookingById,
  confirmBooking,
  declineBooking,
  cancelBooking,
  completeBooking,
  noShowBooking,
  upcomingBookings,
  bookingStats,
} from "../controllers/booking.controller";

const router = Router();

// ── Stripe Webhook (MUST be before express.json() — uses raw body) ──
// NOTE: This route uses express.raw() for Stripe signature verification.
// It is mounted separately in index.ts BEFORE the global express.json() middleware.
// See index.ts for details.

// ── Authenticated: Create booking (student) ──
router.post(
  "/",
  isAuthenticated,
  isStudent,
  createBookingValidation(),
  createBooking
);

// ── Authenticated: List bookings (role-aware) ──
router.get("/", isAuthenticated, listBookingsValidation(), listBookings);

// ── Authenticated: Upcoming bookings (dashboard widget) ──
router.get(
  "/upcoming",
  isAuthenticated,
  upcomingBookingsValidation(),
  upcomingBookings
);

// ── Authenticated: Booking stats ──
router.get("/stats", isAuthenticated, bookingStats);

// ── Authenticated: Single booking detail ──
router.get("/:id", isAuthenticated, getBookingByIdValidation(), getBookingById);

// ── Authenticated: Tutor confirms booking ──
router.patch(
  "/:id/confirm",
  isAuthenticated,
  isTutor,
  confirmBookingValidation(),
  confirmBooking
);

// ── Authenticated: Tutor declines booking ──
router.patch(
  "/:id/decline",
  isAuthenticated,
  isTutor,
  declineBookingValidation(),
  declineBooking
);

// ── Authenticated: Cancel booking (student/tutor/admin) ──
router.patch(
  "/:id/cancel",
  isAuthenticated,
  cancelBookingValidation(),
  cancelBooking
);

// ── Authenticated: Complete booking (tutor/admin) ──
router.patch(
  "/:id/complete",
  isAuthenticated,
  completeBookingValidation(),
  completeBooking
);

// ── Authenticated: Mark no-show (tutor/admin) ──
router.patch(
  "/:id/no-show",
  isAuthenticated,
  noShowBookingValidation(),
  noShowBooking
);

export default router;
