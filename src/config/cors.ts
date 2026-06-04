/**
 * CORS allow-list — Project Silk subdomain split (M0.4).
 *
 * Subdomain layout (flat siblings under the Amber Training apex)
 * ──────────────────────────────────────────────────────────────
 *
 *   esol.ambertraining.co.uk       → marketing + login + ROI calc
 *   learner.ambertraining.co.uk    → learner shell
 *   teacher.ambertraining.co.uk    → teacher portal
 *   admin.ambertraining.co.uk      → org admin + Amber super-admin
 *   app.ambertraining.co.uk        → legacy combined shell
 *
 * The apex `ambertraining.co.uk` itself hosts Amber's firstaid
 * product line, served by a separate frontend that doesn't talk
 * to this API. It is NOT whitelisted here.
 *
 * Adding a new host requires:
 *   1. DNS A/CNAME record pointing at the frontend
 *   2. An entry below (or the EXTRA_CORS_ORIGINS env var for
 *      ephemeral preview deploys)
 *   3. Frontend `Wrapper.tsx` already knows about the shell
 *
 * Wildcards are NOT used — keeping the list explicit means a
 * compromised host can't broaden access to the API.
 *
 * EXTRA_CORS_ORIGINS
 * ──────────────────
 * Comma-separated list of additional origins. Used for staging /
 * Vercel preview deploys whose hostnames aren't known at build
 * time. Example:
 *
 *   EXTRA_CORS_ORIGINS=https://amber-esol-mvp-git-pr42-amber.vercel.app
 */

const PRODUCTION_ORIGINS = [
  // ESOL product subdomains (M0.3). The apex is firstaid's — not us.
  "https://esol.ambertraining.co.uk",
  "https://learner.ambertraining.co.uk",
  "https://teacher.ambertraining.co.uk",
  "https://admin.ambertraining.co.uk",
  // Legacy combined-app subdomain — retained until DNS migration
  // for teacher / admin staff is complete.
  "https://app.ambertraining.co.uk",
];

const DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  // *.localhost subdomains for shell testing in modern browsers
  // (RFC 6761). Each shell can be opened on its own URL without
  // /etc/hosts entries.
  "http://esol.localhost:3000",
  "http://learner.localhost:3000",
  "http://teacher.localhost:3000",
  "http://admin.localhost:3000",
  "http://app.localhost:3000",
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
