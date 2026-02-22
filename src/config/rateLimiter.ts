import rateLimit from "express-rate-limit";

/**
 * General API limiter — applies to every /api route.
 * Generous enough for normal usage, blocks obvious abuse.
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 200 requests per window per IP
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  message: {
    status: 429,
    message: "Too many requests. Please try again later.",
  },
});

/**
 * Auth limiter — login, register, verify.
 * Tight limit to prevent brute-force and account spam.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message:
      "Too many authentication attempts. Please try again in 15 minutes.",
  },
});

/**
 * Password reset / forgot-password limiter.
 * Very tight — prevents email spam to arbitrary addresses.
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many password reset requests. Please try again in an hour.",
  },
});

/**
 * Booking creation limiter.
 * Prevents rapid booking spam while allowing normal multi-slot bookings.
 */
export const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // 15 booking requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many booking requests. Please slow down.",
  },
});

/**
 * Webhook limiter — Stripe webhooks.
 * Higher limit since Stripe can send bursts, but still bounded.
 */
export const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 50, // 50 per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 429,
    message: "Too many webhook requests.",
  },
});
