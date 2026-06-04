import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import ApiError from "../errors/apiError";

/**
 * Requires the `x-bull-board-token` header (or `?token=` query param as
 * fallback) to match BULL_BOARD_TOKEN env var.
 *
 * Defence-in-depth on top of `isAuthenticated + isAdmin`. Even with a stolen
 * admin JWT, an attacker also needs the server-side secret to reach Bull
 * Board's queue introspection / job purge UI.
 *
 * The query-param fallback exists because a browser cannot inject a custom
 * header into an `<iframe src>` or top-level navigation. Final Addendum §1
 * wires Bull Board into the admin dashboard as a new-tab link; the page
 * fetches a signed link via /api/admin/queues/link and the resulting
 * `?token=` is read here. Caveats of the query-param path:
 *
 *   - The token appears in browser history and server access logs for the
 *     single open-tab navigation. Bull Board's own subsequent requests use
 *     cookies, so the token only lands in one URL. Live with this trade-off
 *     for the MVP; revisit when we have a cookie-based signed-session flow.
 *   - The query-param read is still subject to the same timing-safe
 *     comparison the header read uses.
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

  // Header first (the original path); query-param is the iframe / new-tab
  // fallback. Either form is acceptable; both must be a non-empty string.
  const headerVal = req.headers["x-bull-board-token"];
  const queryVal = (req.query as Record<string, unknown>)?.token;
  const provided =
    typeof headerVal === "string" && headerVal.length > 0
      ? headerVal
      : typeof queryVal === "string" && queryVal.length > 0
        ? queryVal
        : null;
  if (provided === null) {
    return next(
      new ApiError(
        403,
        "Bull Board token missing — send x-bull-board-token header or ?token= query param",
      ),
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
