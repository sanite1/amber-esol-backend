/**
 * Shared environment + helper utilities for every k6 scenario.
 *
 * k6 doesn't read .env files — every variable must be passed via
 * `-e KEY=value` on the command line. The README documents the
 * canonical invocations; this module surfaces friendly defaults
 * and fail-closed errors when a required var is missing.
 *
 * One module, no external deps — k6 ESM doesn't support imports
 * beyond what the runtime ships with.
 */

/**
 * Read a required environment variable. Fail-fast with a clear
 * message rather than letting the scenario run against an undefined
 * host (which would noise up the report with "TypeError" rows).
 */
export function requireEnv(name) {
  const v = __ENV[name];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(
      `Missing required env var ${name}. Pass it with -e ${name}=…`,
    );
  }
  return v;
}

/** Read an env var with a default fallback. */
export function envOr(name, fallback) {
  const v = __ENV[name];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/**
 * Base URL of the API. Defaults to local dev so a developer can
 * smoke-test a scenario without setting env vars; staging runs
 * MUST set this explicitly.
 *
 *   -e BASE_URL=https://api-staging.ambertraining.co.uk
 */
export const BASE_URL = envOr("BASE_URL", "http://localhost:4000");

/**
 * Auth token. Either a single org-admin token (for dashboard /
 * ILR / CSV import scenarios) or a learner token (for AI sessions).
 * Generate via the staging login endpoint and pass through.
 *
 *   -e AUTH_TOKEN=eyJhbGciOi…
 */
export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * Format a duration in ms to "<n>s" or "<n>ms" — used in console
 * summaries so a 4500ms p95 reads as "4.5 s" rather than "4500".
 */
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "?";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(0)} ms`;
}
