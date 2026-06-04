/**
 * Demo-mode response-header middleware — brief Function 16.
 *
 * Stamps `X-Demo-Mode: true` on every HTTP response when the server
 * is running in DEMO_MODE. The frontend reads this on the first
 * response it receives (typically the GET /me or any other
 * authenticated call) and flips the global demo-banner state.
 *
 * Why every response, not just /me?
 *
 *   - The same axios instance runs every API call. Setting the
 *     header globally means the banner flips on regardless of which
 *     page the user lands on first.
 *   - A future endpoint we forget to flag would silently fail to
 *     trigger the banner. "Set it on everything" is safer than "set
 *     it on the routes we remember".
 *
 * CORS interaction
 *
 *   The default `cors` middleware sets `Access-Control-Expose-Headers`
 *   only to the safelisted set, which does NOT include custom
 *   `X-*` headers. We extend it explicitly via the cors config in
 *   src/index.ts so the browser surfaces this header to fetch/axios.
 */

import { Request, Response, NextFunction } from "express";
import { IS_DEMO_MODE, DEMO_MODE_HEADER } from "../config/demoMode";

export const demoModeHeader = (
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (IS_DEMO_MODE) {
    res.setHeader(DEMO_MODE_HEADER, "true");
  }
  next();
};
