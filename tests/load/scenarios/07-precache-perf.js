/**
 * Scenario 7 — Pre-cache performance  [ADDENDUM].
 *
 * Spec (launch checklist):
 *   With full postcode dataset loaded in Redis:
 *     run 1000 lookups → p95 < 10 ms per lookup.
 *   With full safeguarding keyword bank loaded:
 *     run 1000 scans → p95 < 5 ms per scan.
 *
 * These two probes share a scenario file because they exercise the
 * same architectural property: "is the in-memory / Redis-backed
 * cache layer fast enough to be transparent at the per-turn
 * inference latency budget?"
 *
 * Why test against staging
 * ========================
 *
 * Localhost Redis is essentially free. Staging Redis (Upstash) has
 * a real network round-trip — that's the latency the brief gate
 * targets. Run this against staging, never against `localhost`,
 * unless you're sanity-checking the script itself.
 *
 * Pass / fail
 * ===========
 *
 *   postcode_lookup_ms p95 < 10
 *   safeguarding_scan_ms p95 < 5
 *
 * Run
 * ===
 *
 *   k6 run \
 *     -e BASE_URL=https://api-staging.ambertraining.co.uk \
 *     -e ORG_ADMIN_TOKENS=<admin-token> \
 *     scenarios/07-precache-perf.js
 *
 * Pre-conditions
 * ==============
 *
 *   The staging deployment must expose:
 *     POST /api/admin/load-test/postcode-lookup        body { postcode }
 *     POST /api/admin/load-test/safeguarding-scan      body { text }
 *
 *   Both are admin-only endpoints that wrap the in-process call to
 *   PostcodeRouter.lookup() and SafeguardingDetector.scan() so the
 *   measured latency excludes the auth + parse overhead. They're
 *   safe in staging because the call is read-only; gated on
 *   DEMO_MODE so they never reach production.
 *
 *   If those endpoints aren't deployed yet, run the scenario
 *   directly via a shell script that hits the underlying cache
 *   from inside the process (documented in the README).
 */

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { BASE_URL, authHeaders } from "../lib/env.js";
import { orgAdminTokens } from "../lib/fixtures.js";

const postcodeLookupMs = new Trend("postcode_lookup_ms", true);
const safeguardingScanMs = new Trend("safeguarding_scan_ms", true);

// A realistic-ish sample of UK postcodes hitting a variety of MCAs
// so the lookup isn't all hitting the same hash bucket.
const POSTCODES = [
  "SW1A 1AA",
  "EC1A 1BB",
  "M1 1AA",
  "B1 1HQ",
  "L1 8JQ",
  "LS1 4AP",
  "G1 1QQ",
  "EH1 1YZ",
  "CF10 3RB",
  "BS1 4AE",
  "NE1 7RU",
  "S1 2DE",
  "NG1 5DQ",
  "CB2 1TN",
  "OX1 2JD",
];

// A spread of safeguarding-prone and safeguarding-clean inputs so
// the detector's keyword bank is genuinely exercised (some hits,
// most misses — mirrors real traffic).
const SCAN_INPUTS = [
  "I want to make an appointment with the GP next week.",
  "How do I read my payslip?",
  "I'm worried about my housing rights.",
  "Can you help me understand my benefit letter?",
  "I sometimes feel like nobody listens to me.",
  "My neighbour has been bothering my children.",
  "What time does the library open on Saturday?",
  "I don't know who to call when I feel really down.",
  "How do I say 'good morning' to my new colleague?",
  "I need to learn words to use at the supermarket.",
];

export const options = {
  scenarios: {
    postcode: {
      exec: "postcodeLookup",
      executor: "per-vu-iterations",
      vus: 4,
      iterations: 250, // 4 × 250 = 1000 lookups
      maxDuration: "3m",
    },
    safeguarding: {
      exec: "safeguardingScan",
      executor: "per-vu-iterations",
      vus: 4,
      iterations: 250, // 4 × 250 = 1000 scans
      maxDuration: "3m",
      // Start the second scenario after the first finishes so we
      // measure each cache in isolation rather than competing on the
      // same Node event loop.
      startTime: "3m30s",
    },
  },
  thresholds: {
    postcode_lookup_ms: ["p(95)<10"],
    safeguarding_scan_ms: ["p(95)<5"],
    http_req_failed: ["rate<0.005"],
  },
};

export function postcodeLookup() {
  const token = orgAdminTokens()[0];
  const headers = authHeaders(token);
  const postcode = POSTCODES[__ITER % POSTCODES.length];

  const startedAt = Date.now();
  const res = http.post(
    `${BASE_URL}/api/admin/load-test/postcode-lookup`,
    JSON.stringify({ postcode }),
    { headers, tags: { name: "POST /api/admin/load-test/postcode-lookup" } },
  );
  postcodeLookupMs.add(Date.now() - startedAt);
  check(res, { "lookup 200": (r) => r.status === 200 });
}

export function safeguardingScan() {
  const token = orgAdminTokens()[0];
  const headers = authHeaders(token);
  const text = SCAN_INPUTS[__ITER % SCAN_INPUTS.length];

  const startedAt = Date.now();
  const res = http.post(
    `${BASE_URL}/api/admin/load-test/safeguarding-scan`,
    JSON.stringify({ text }),
    { headers, tags: { name: "POST /api/admin/load-test/safeguarding-scan" } },
  );
  safeguardingScanMs.add(Date.now() - startedAt);
  check(res, { "scan 200": (r) => r.status === 200 });
}
