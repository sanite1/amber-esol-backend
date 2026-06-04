/**
 * Deterministic fixture generators for k6 scenarios.
 *
 * The load tests run against a CLEAN staging deployment that's been
 * pre-seeded with the Hillview demo fixture (Function 16). Scenarios
 * read learner / org / scenario IDs from env vars or generate them
 * here against well-known patterns.
 *
 * Tests MUST NOT mutate production data. The CI runner sets
 * `BASE_URL` to a staging or demo-mode host; running these scripts
 * against production is a configuration error we guard against in
 * the README, not at runtime.
 */

import { requireEnv } from "./env.js";

/**
 * Pull a list of learner IDs from `LEARNER_IDS` (comma-separated) or
 * fall back to the seeded Hillview cohort range. The seed script
 * writes 30 learners; we accept any subset.
 */
export function learnerIds() {
  const raw = __ENV.LEARNER_IDS;
  if (!raw) {
    throw new Error(
      "LEARNER_IDS env var required. Provide a comma-separated list " +
        "of ObjectIds from the staging Hillview cohort.",
    );
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Single org ID — for ILR / dashboard / cache-clear scenarios. */
export function orgId() {
  return requireEnv("ORG_ID");
}

/** Scenario ids that the AI tutor sessions can be launched against. */
export function scenarioIds() {
  return (__ENV.SCENARIO_IDS ?? "s1_gp_appointment,s2_payslip,s3_housing_rights")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Tokens for the three impersonation classes. Each maps to a real
 * pre-seeded user on staging. The CI runner generates these once at
 * the start of the suite and passes them through to every scenario
 * (-e LEARNER_TOKENS=…,…,… etc).
 */
export function learnerTokens() {
  const raw = __ENV.LEARNER_TOKENS;
  if (!raw) {
    throw new Error(
      "LEARNER_TOKENS env var required. Comma-separated JWTs for the seeded learners.",
    );
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function orgAdminTokens() {
  const raw = __ENV.ORG_ADMIN_TOKENS;
  if (!raw) {
    throw new Error(
      "ORG_ADMIN_TOKENS env var required. Comma-separated JWTs for seeded org admins.",
    );
  }
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Generate a fictional 100-row learner CSV string for the bulk-import
 * scenario. Deterministic per `vu` so two simultaneous VUs don't
 * upload the same payload (which would let bulk-import idempotency
 * elide the second one and make the test misleading).
 */
export function generateLearnerCsv(vu) {
  const header = [
    "firstname",
    "lastname",
    "email",
    "dateOfBirth",
    "uln",
    "postcode",
    "l1Language",
  ].join(",");

  const rows = [header];
  for (let i = 0; i < 100; i++) {
    // Stable per-vu prefix → unique across VUs, deterministic across runs.
    const prefix = `LT${vu}I${i}`;
    rows.push(
      [
        `LoadFirst${prefix}`,
        `LoadLast${prefix}`,
        `loadtest-${prefix.toLowerCase()}@demo.example`,
        "1990-01-15",
        // ULN — 10 digits, deterministic. Real ESFA ULNs are
        // checksummed; the import flow accepts the demo format.
        `1${String(vu).padStart(3, "0")}${String(i).padStart(6, "0")}`,
        "SW1A 1AA",
        i % 5 === 0 ? "arabic" : i % 5 === 1 ? "somali" : i % 5 === 2 ? "dari" : i % 5 === 3 ? "cantonese" : "english",
      ].join(","),
    );
  }
  return rows.join("\n");
}
