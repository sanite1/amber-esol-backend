/**
 * Scenario 6 — Idempotency under retry  [ADDENDUM].
 *
 * Spec (launch checklist):
 *   Trigger 10 concurrent ILR exports for the same org+period.
 *   Pass:
 *     - only one actual generation runs
 *     - other 9 return the cached result
 *     - no duplicate AuditLog entries (ilr_export_completed)
 *
 * Why this is non-obvious
 * =======================
 *
 * The trigger endpoint computes the idempotency key BEFORE
 * enqueueing. The first request inserts the IdempotencyKey row;
 * the worker runs. The 9 concurrent siblings either:
 *   (a) see an existing IdempotencyKey row in status "processing"
 *       and POLL until it flips to "completed", then return the
 *       cached result, OR
 *   (b) see status "completed" already (rare under genuine
 *       concurrency, but the route handles it) and return inline.
 *
 * Either way, the queue receives ONE job (BullMQ jobId is the
 * deterministic export_id; duplicates are de-duplicated), and the
 * worker's `runIlrExport` wraps the actual build in
 * `IdempotencyService.check` so only one Mongo + filesystem run
 * happens.
 *
 * Pass / fail
 * ===========
 *
 *   exactly one unique export_id observed across the 10 responses
 *   trigger latency p95 < 500ms (caching path is fast)
 *   downstream check (manual in the README) confirms
 *     ilr_export_completed AuditLog count incremented by exactly 1
 *
 * Run
 * ===
 *
 *   k6 run \
 *     -e BASE_URL=https://api-staging.ambertraining.co.uk \
 *     -e ORG_ADMIN_TOKENS=<staging-token-for-target-org> \
 *     -e ACADEMIC_YEAR=2025/26 \
 *     scenarios/06-idempotency-retry.js
 */

import http from "k6/http";
import { check } from "k6";
import { Counter, Trend } from "k6/metrics";
import { SharedArray } from "k6/data";
import { BASE_URL, authHeaders, envOr } from "../lib/env.js";
import { orgAdminTokens } from "../lib/fixtures.js";

const triggerMs = new Trend("trigger_ms", true);
const uniqueExportIds = new Counter("unique_export_ids");

const ACADEMIC_YEAR = envOr("ACADEMIC_YEAR", "2025/26");

// Compute a single (period_start, period_end) tuple ONCE at __init
// so all 10 VUs trigger against the IDENTICAL idempotency key.
const SHARED = new SharedArray("period", () => {
  const periodEnd = new Date().toISOString().slice(0, 10);
  const periodStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return [{ periodStart, periodEnd }];
});

export const options = {
  scenarios: {
    concurrent_triggers: {
      executor: "shared-iterations",
      vus: 10,
      iterations: 10, // one trigger per VU
      maxDuration: "1m",
    },
  },
  thresholds: {
    "trigger_ms":      ["p(95)<500"],
    "http_req_failed": ["rate<0.01"],
  },
};

// Collect every response's export_id at the per-VU layer. After
// the scenario ends we summarise via handleSummary below.
const observedExportIds = new Set();

export default function () {
  const token = orgAdminTokens()[0];
  const headers = authHeaders(token);
  const { periodStart, periodEnd } = SHARED[0];

  // NB: no ?force_refresh — we want every call to hit the
  // idempotency path. force_refresh would defeat the test.
  const res = http.post(
    `${BASE_URL}/api/org-admin/export/ilr`,
    JSON.stringify({
      academic_year: ACADEMIC_YEAR,
      period_start: periodStart,
      period_end: periodEnd,
    }),
    { headers, tags: { name: "POST /api/org-admin/export/ilr" } },
  );

  triggerMs.add(res.timings.duration);

  const ok = check(res, {
    "200 or 202": (r) => r.status === 200 || r.status === 202,
    "carries export_id":
      (r) => typeof r.json("data.export_id") === "string",
  });
  if (!ok) return;

  const exportId = res.json("data.export_id");
  observedExportIds.add(exportId);
}

/**
 * k6 calls this once after every iteration finishes. We surface
 * the uniqueness check in the structured summary so a CI runner
 * can grep it.
 */
export function handleSummary(data) {
  const idCount = observedExportIds.size;
  uniqueExportIds.add(idCount);
  const verdict =
    idCount === 1
      ? "PASS — exactly one export_id observed"
      : `FAIL — ${idCount} distinct export_ids observed (expected 1)`;

  const stdout = `
Idempotency-under-retry verdict
================================
${verdict}

Observed export_ids: ${Array.from(observedExportIds).join(", ") || "(none)"}

Follow-up check (manual): in Mongo, run

  db.audit_logs.countDocuments({
    action: "ilr_export_completed",
    org_id: <orgObjectId>,
    after_state: { $exists: true },
    "after_state.period_start": "${SHARED[0].periodStart}",
    "after_state.period_end":   "${SHARED[0].periodEnd}",
  })

It must return exactly 1.
`;

  return {
    stdout,
    "summary.json": JSON.stringify(
      {
        ...data,
        unique_export_id_count: idCount,
        observed_export_ids: Array.from(observedExportIds),
      },
      null,
      2,
    ),
  };
}
