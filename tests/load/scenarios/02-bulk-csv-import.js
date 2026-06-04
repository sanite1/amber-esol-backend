/**
 * Scenario 2 — Bulk CSV import.
 *
 * Spec (launch checklist):
 *   5 concurrent org admins each uploading a 100-row CSV.
 *   Measure import duration. Pass: under 30 s per import.
 *
 * Why constant-VUs not ramping-vus
 * ================================
 *
 * Each VU uploads ONE 100-row CSV per iteration. Five VUs running
 * one iteration each for 60 s gives 5 concurrent uploads — exactly
 * what the spec asks for. Ramping wouldn't help here; we're not
 * stress-testing the burst path, we're measuring the steady-state
 * upload time.
 *
 * Pass / fail
 * ===========
 *
 *   p95 import_duration_ms < 30,000   ← brief gate
 *   error rate < 1%
 *
 * Note: each VU uses a vu-prefixed CSV (see fixtures.generateLearnerCsv)
 * so the bulk-import idempotency key — sha256(org+email+dob) — doesn't
 * collide between concurrent VUs. If we used the same CSV across all
 * 5 VUs, four of them would short-circuit on the cached result and
 * the test would lie about real upload time.
 *
 * Run
 * ===
 *
 *   k6 run \
 *     -e BASE_URL=https://api-staging.ambertraining.co.uk \
 *     -e ORG_ADMIN_TOKENS=$(cat staging-org-admin-tokens) \
 *     scenarios/02-bulk-csv-import.js
 */

import http from "k6/http";
import { check } from "k6";
import { Trend, Counter } from "k6/metrics";
import { BASE_URL } from "../lib/env.js";
import { orgAdminTokens, generateLearnerCsv } from "../lib/fixtures.js";

const importDuration = new Trend("import_duration_ms", true);
const importsCompleted = new Counter("imports_completed");

export const options = {
  scenarios: {
    bulk_import: {
      executor: "constant-vus",
      vus: 5,
      duration: "2m", // long enough that every VU completes at least 2 iterations
    },
  },
  thresholds: {
    "import_duration_ms": ["p(95)<30000"],
    "http_req_failed":    ["rate<0.01"],
  },
};

const tokens = orgAdminTokens();

export default function () {
  const token = tokens[(__VU - 1) % tokens.length];
  const csv = generateLearnerCsv(__VU);

  const formData = {
    file: http.file(csv, `loadtest-vu-${__VU}.csv`, "text/csv"),
  };

  const startedAt = Date.now();
  const res = http.post(`${BASE_URL}/api/org-admin/import/learners`, formData, {
    headers: {
      // Multipart form upload — no JSON Content-Type.
      Authorization: `Bearer ${token}`,
    },
    timeout: "90s",
    tags: { name: "POST /api/org-admin/import/learners" },
  });
  const duration = Date.now() - startedAt;

  const ok = check(res, {
    "import 200/202": (r) => r.status === 200 || r.status === 202,
    "no failed rows":
      (r) => {
        try {
          const body = r.json();
          // The import service surfaces blocked rows under
          // data.blocked_rows; non-zero is acceptable for a real
          // import but flags a content issue for the load test —
          // the synthetic CSV should be 100% clean.
          return (body?.data?.blocked_rows?.length ?? 0) === 0;
        } catch {
          return false;
        }
      },
  });
  if (ok) {
    importDuration.add(duration);
    importsCompleted.add(1);
  }
}
