import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import ApiError from "../errors/apiError";

/**
 * Requires the `x-bull-board-token` header to match BULL_BOARD_TOKEN env var.
 *
 * Defence-in-depth on top of `isAuthenticated + isAdmin`. Even with a stolen
 * admin JWT, an attacker also needs the server-side secret to reach Bull
 * Board's queue introspection / job purge UI.
 *
 * Comparison is timing-safe to avoid leaking the token byte-by-byte through
 * response latency.
 */
export const requireBullBoardToken = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  const expected = process.env.BULL_BOARD_TOKEN;

  if (!expected) {
    return next(
      new ApiError(
        500,
        "BULL_BOARD_TOKEN is not configured. Generate one with `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"` and set in .env."
      )
    );
  }

  const provided = req.headers["x-bull-board-token"];
  if (typeof provided !== "string" || provided.length === 0) {
    return next(
      new ApiError(403, "Bull Board token missing — send x-bull-board-token header")
    );
  }

  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");

  // Length-mismatch shortcut. timingSafeEqual throws if buffers differ in
  // length, so we check first — but to keep timing analysis hard we still
  // run the comparison against a zero buffer when lengths differ.
  if (expectedBuf.length !== providedBuf.length) {
    timingSafeEqual(expectedBuf, Buffer.alloc(expectedBuf.length));
    return next(new ApiError(403, "Bull Board token invalid"));
  }

  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return next(new ApiError(403, "Bull Board token invalid"));
  }

  next();
};
