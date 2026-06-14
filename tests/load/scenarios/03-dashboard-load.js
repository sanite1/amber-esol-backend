/**
 * Scenario 3 — Dashboard load.
 *
 * Spec (launch checklist):
 *   20 concurrent org admins loading the cohort table.
 *   Pass: p95 < 2 s.
 *
 * The cohort table is the org-admin landing page — it should be
 * fast even when 20 admins land at 9am Monday morning. The endpoint
 * runs a paginated aggregate against the User collection with
 * filters; the Function 12 implementation indexes on (orgId, status,
 * esolLevel) to keep the dominant query cheap.
 *
 * Why GET twice per iteration
 * ===========================
 *
 * Real admins don't just open the page — they apply a filter, sort,
 * or paginate. We model that with two sequential calls per iteration:
 * an unfiltered first page, then a filtered second page. The second
 * call exercises the index path; the first call is the cold-load
 * scenario.
 *
 * Pass / fail
 * ===========
 *
 *   p95 dashboard_load_ms < 2000   ← brief gate
 *   error rate < 0.5%
 *
 * Run
 * ===
 *
 *   k6 run \
 *     -e BASE_URL=https://api-staging.ambertraining.co.uk \
 *     -e ORG_ADMIN_TOKENS=$(cat staging-org-admin-tokens) \
 *     scenarios/03-dashboard-load.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";
import { BASE_URL, authHeaders } from "../lib/env.js";
import { orgAdminTokens } from "../lib/fixtures.js";

const dashboardLoad = new Trend("dashboard_load_ms", true);

export const options = {
  scenarios: {
    dashboard: {
      executor: "constant-vus",
      vus: 20,
      duration: "3m",
    },
  },
  thresholds: {
    dashboard_load_ms: ["p(95)<2000"],
    "dashboard_load_ms{call:filtered}": ["p(95)<2000"],
    http_req_failed: ["rate<0.005"],
  },
};

const tokens = orgAdminTokens();

export default function () {
  const token = tokens[(__VU - 1) % tokens.length];
  const headers = authHeaders(token);

  // Call 1 — unfiltered, page 1.
  const r1 = http.get(`${BASE_URL}/api/org-admin/learners?page=1&limit=50`, {
    headers,
    tags: { name: "GET /api/org-admin/learners", call: "unfiltered" },
  });
  check(r1, { 200: (r) => r.status === 200 });
  dashboardLoad.add(r1.timings.duration, { call: "unfiltered" });

  // Pause — real admins don't fire two requests in the same tick.
  sleep(1 + Math.random());

  // Call 2 — filtered by status + level.
  const r2 = http.get(
    `${BASE_URL}/api/org-admin/learners?status=active&level=e2&page=1&limit=50`,
    {
      headers,
      tags: { name: "GET /api/org-admin/learners", call: "filtered" },
    },
  );
  check(r2, { 200: (r) => r.status === 200 });
  dashboardLoad.add(r2.timings.duration, { call: "filtered" });

  // Short think time before this VU's next iteration.
  sleep(2 + Math.random() * 2);
}
