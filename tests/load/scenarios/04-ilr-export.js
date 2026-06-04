/**
 * Scenario 4 — ILR export.
 *
 * Spec (launch checklist):
 *   Single org with 200 learners exports ILR.
 *   Pass:
 *     - 202 response within 500 ms (async queue accepts the request)
 *     - Job completes within 60 s
 *     - Downloaded CSV is valid (parses; row count matches)
 *
 * Why a single iteration
 * ======================
 *
 * This isn't a concurrency test — it's a throughput test. We need
 * ONE big org's export to complete inside the time budget; running
 * five simultaneously isn't the launch-checklist concern.
 *
 * The scenario is split into three phases:
 *   1. POST /export/ilr → assert 202 + capture jobId + measure
 *      acceptance latency (must be < 500 ms).
 *   2. Poll GET /:jobId/status every 2 s until completed/failed,
 *      bounded by a 90 s deadline. Measure end-to-end completion.
 *   3. GET /:exportId/download → assert 200, content-type
 *      text/csv, body parses as CSV with header + N data rows.
 *
 * Pass / fail
 * ===========
 *
 *   acceptance_ms p95 < 500        ← brief gate
 *   completion_ms p95 < 60_000     ← brief gate
 *   download CSV validity check passes
 *
 * Run
 * ===
 *
 *   k6 run \
 *     -e BASE_URL=https://api-staging.ambertraining.co.uk \
 *     -e ORG_ADMIN_TOKENS=<single-token-for-the-200-learner-org> \
 *     -e ORG_ID=<that-org's-id> \
 *     -e ACADEMIC_YEAR=2025/26 \
 *     -e EXPECTED_ROW_COUNT=200 \
 *     scenarios/04-ilr-export.js
 */

import http from "k6/http";
import { check, sleep, fail } from "k6";
import { Trend } from "k6/metrics";
import { BASE_URL, authHeaders, envOr } from "../lib/env.js";
import { orgAdminTokens } from "../lib/fixtures.js";

const acceptanceMs = new Trend("ilr_acceptance_ms", true);
const completionMs = new Trend("ilr_completion_ms", true);
const downloadMs = new Trend("ilr_download_ms", true);

const ACADEMIC_YEAR = envOr("ACADEMIC_YEAR", "2025/26");
const EXPECTED_ROW_COUNT = Number.parseInt(
  envOr("EXPECTED_ROW_COUNT", "200"),
  10,
);
const POLL_INTERVAL_S = Number.parseInt(envOr("POLL_INTERVAL_S", "2"), 10);
const POLL_TIMEOUT_S = Number.parseInt(envOr("POLL_TIMEOUT_S", "90"), 10);

export const options = {
  scenarios: {
    ilr_export: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "5m",
    },
  },
  thresholds: {
    "ilr_acceptance_ms": ["p(95)<500"],
    "ilr_completion_ms": ["p(95)<60000"],
    "http_req_failed":   ["rate<0.05"],
  },
};

export default function () {
  const token = orgAdminTokens()[0];
  const headers = authHeaders(token);

  // ── Phase 1: trigger ────────────────────────────────────────────
  // Calendar-period bounds — staging seed covers the current month
  // through to 90 days back. Real prod monthly runs would use the
  // last full month.
  const periodEnd = new Date().toISOString().slice(0, 10);
  const periodStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  // ?force_refresh=true so the scenario actually exercises the
  // pipeline even if a prior run cached a completed export.
  const trigger = http.post(
    `${BASE_URL}/api/org-admin/export/ilr?force_refresh=true`,
    JSON.stringify({
      academic_year: ACADEMIC_YEAR,
      period_start: periodStart,
      period_end: periodEnd,
    }),
    { headers, tags: { name: "POST /api/org-admin/export/ilr" } },
  );
  acceptanceMs.add(trigger.timings.duration);

  const accepted = check(trigger, {
    "trigger 202": (r) => r.status === 202,
    "trigger fast (<500ms)": (r) => r.timings.duration < 500,
  });
  if (!accepted) {
    fail(`ILR export trigger failed: HTTP ${trigger.status}`);
    return;
  }
  const jobId = trigger.json("data.job_id");
  const exportId = trigger.json("data.export_id");
  if (!jobId || !exportId) {
    fail("ILR export trigger returned no job_id / export_id");
    return;
  }

  // ── Phase 2: poll status until completed ────────────────────────
  const pollStart = Date.now();
  const deadline = pollStart + POLL_TIMEOUT_S * 1000;
  let finalStatus = "waiting";
  while (Date.now() < deadline) {
    sleep(POLL_INTERVAL_S);
    const statusRes = http.get(
      `${BASE_URL}/api/org-admin/export/ilr/${jobId}/status`,
      { headers, tags: { name: "GET /api/org-admin/export/ilr/:jobId/status" } },
    );
    if (statusRes.status !== 200) continue;
    finalStatus = statusRes.json("data.status");
    if (finalStatus === "completed" || finalStatus === "failed") break;
  }
  const completed = Date.now() - pollStart;
  completionMs.add(completed);
  check(finalStatus, {
    "job completed": (s) => s === "completed",
    "completion <60s": () => completed < 60_000,
  });
  if (finalStatus !== "completed") return;

  // ── Phase 3: download + validate ────────────────────────────────
  const downloadStart = Date.now();
  const download = http.get(
    `${BASE_URL}/api/org-admin/export/ilr/${exportId}/download`,
    { headers, tags: { name: "GET /api/org-admin/export/ilr/:exportId/download" } },
  );
  downloadMs.add(Date.now() - downloadStart);

  check(download, {
    "download 200": (r) => r.status === 200,
    "content-type text/csv": (r) =>
      (r.headers["Content-Type"] ?? r.headers["content-type"] ?? "").includes("text/csv"),
    "CSV non-empty": (r) =>
      typeof r.body === "string" && r.body.length > 0,
    "CSV row count matches": (r) => {
      if (typeof r.body !== "string") return false;
      // Header + N data rows (filter out trailing newlines).
      const rows = r.body.split("\n").filter((l) => l.length > 0);
      const dataRows = rows.length - 1;
      return dataRows === EXPECTED_ROW_COUNT;
    },
  });
}
