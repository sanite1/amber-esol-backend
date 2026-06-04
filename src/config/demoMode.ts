/**
 * Demo-mode toggle — brief Function 16.
 *
 * `DEMO_MODE=true` flips the server into a fully isolated demo
 * deployment:
 *
 *   - Mongo connects to `DEMO_MONGODB_URI` instead of `MONGODB_URI`
 *     (see config/db.ts).
 *   - Outbound emails get a `[DEMO]` subject prefix so a recipient
 *     who lands in an inbox can instantly spot they're looking at
 *     fictional data (see services/nodemailer/nodemailer.ts).
 *   - Every API response carries the `X-Demo-Mode: true` header so
 *     the frontend can render the persistent banner.
 *
 * The toggle is read ONCE at module load. Flipping the env var means
 * restarting the process — that's deliberate: a half-demo-half-prod
 * runtime is the failure mode this guard exists to prevent.
 */

const RAW = process.env.DEMO_MODE;

/**
 * True when the server is running in demo mode.
 *
 * Accepted truthy values: "true", "1", "yes" (case-insensitive). Any
 * other value (including the env var being unset) is false.
 */
export const IS_DEMO_MODE: boolean = (() => {
  if (typeof RAW !== "string") return false;
  return ["true", "1", "yes"].includes(RAW.trim().toLowerCase());
})();

/** Header name set by the demo-mode middleware. */
export const DEMO_MODE_HEADER = "X-Demo-Mode";

/** Subject prefix applied to every outbound email in demo mode. */
export const DEMO_EMAIL_PREFIX = "[DEMO] ";
