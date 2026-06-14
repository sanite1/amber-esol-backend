/**
 * CORS allow-list — Project Silk single-host model (M0.4).
 *
 * The ESOL frontend is one CRA build deployed to one host:
 *
 *   esol.ambertraining.co.uk    (production)
 *   localhost:3000              (local dev)
 *
 * Audience-shells (learner / teacher / admin) are differentiated by
 * URL path prefix, not subdomain, so this list stays short.
 *
 * The apex `ambertraining.co.uk` and `www.ambertraining.co.uk` host
 * Amber's first-aid product line — a separate frontend that doesn't
 * talk to this API. They are NOT whitelisted.
 *
 * Adding a new host requires:
 *   1. DNS A/CNAME record pointing at the frontend
 *   2. An entry below (or the EXTRA_CORS_ORIGINS env var for
 *      ephemeral preview deploys)
 *
 * Wildcards are NOT used — keeping the list explicit means a
 * compromised host can't broaden access to the API.
 *
 * EXTRA_CORS_ORIGINS
 * ──────────────────
 * Comma-separated list of additional origins for staging / Vercel
 * preview deploys whose hostnames aren't known at build time.
 *
 *   EXTRA_CORS_ORIGINS=https://amber-esol-mvp-git-pr42-amber.vercel.app
 */

const PRODUCTION_ORIGINS = ["https://esol.ambertraining.co.uk"];

const DEV_ORIGINS = [
  "http://localhost:3000",
  // Retained for any team member still on the legacy port-split
  // convention from before path-prefix routing landed.
  "http://localhost:3001",
  "http://localhost:3002",
];

const extraOriginsFromEnv = (): string[] => {
  const raw = process.env.EXTRA_CORS_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const ALLOWED_ORIGINS: string[] = [
  ...PRODUCTION_ORIGINS,
  ...(process.env.NODE_ENV !== "production" ? DEV_ORIGINS : []),
  ...extraOriginsFromEnv(),
];

export default ALLOWED_ORIGINS;
