# Load testing — k6 suite

Project Silk's launch-readiness performance gates. Seven scenarios
covering the brief's stated SLAs plus the Final Addendum additions
(queue resilience, idempotency, cache performance).

---

## Install k6

k6 is **not** a Node package — it's a Go binary. Install per the
upstream guide: <https://k6.io/docs/get-started/installation/>

Quick install on macOS:

```bash
brew install k6
```

Confirm:

```bash
k6 version
# k6 v1.x.x …
```

CI: the Vercel-side load-test runner installs k6 via the official
Docker image (`grafana/k6:latest`) — see the launch-checklist
section of `docs/PRE_LAUNCH.md` (out of scope for this README).

---

## Quick start

Every scenario reads its target URL from `BASE_URL`. Staging:

```bash
export BASE_URL=https://api-staging.ambertraining.co.uk
```

Every scenario also needs at least one auth token. Tokens for the
seeded Hillview cohort are generated via the staging login endpoint
once at the start of the test session and cached in env vars:

```bash
# Generates four tokens against the staging Hillview cohort.
# The CI runner invokes this; an operator can run it locally with the
# staging admin credentials from 1Password.
./tests/load/lib/generate-tokens.sh > .tokens.env
source .tokens.env
```

Run a single scenario:

```bash
k6 run tests/load/scenarios/01-ai-sessions.js
```

Run the full suite (serial — they have different load shapes and
shouldn't compete for the same resources):

```bash
for s in tests/load/scenarios/*.js; do
  echo "▶ $s"
  k6 run "$s" || break
done
```

---

## The seven scenarios

| #   | File                      | Brief gate                                          |
| --- | ------------------------- | --------------------------------------------------- |
| 1   | `01-ai-sessions.js`       | p95 turn latency < 5 s under 50 concurrent VUs      |
| 2   | `02-bulk-csv-import.js`   | p95 import < 30 s with 5 concurrent uploads         |
| 3   | `03-dashboard-load.js`    | p95 cohort table < 2 s with 20 concurrent admins    |
| 4   | `04-ilr-export.js`        | 202 accept < 500 ms, job complete < 60 s, CSV valid |
| 5   | `05-queue-resilience.js`  | 500 jobs survive a worker kill+restart              |
| 6   | `06-idempotency-retry.js` | 10 concurrent triggers → 1 real export              |
| 7   | `07-precache-perf.js`     | postcode p95 < 10 ms, safeguarding scan p95 < 5 ms  |

Each scenario carries its own runnable invocation in the header
comment of the `.js` file — those are the source of truth for
required env vars per scenario.

---

## Expected baselines

These are the numbers a _clean_ staging run should produce. A
result outside the baseline band (above or below) is worth
investigating even if the threshold passes.

| Scenario | Metric                      | Baseline      | Gate                             |
| -------- | --------------------------- | ------------- | -------------------------------- |
| 1        | `turn_latency_ms` p50       | 1.0 – 2.0 s   | —                                |
| 1        | `turn_latency_ms` p95       | 2.5 – 4.5 s   | < 5 s                            |
| 1        | `turn_latency_ms` p99       | 5 – 9 s       | < 10 s                           |
| 2        | `import_duration_ms` p95    | 10 – 20 s     | < 30 s                           |
| 3        | `dashboard_load_ms` p95     | 600 – 1200 ms | < 2 s                            |
| 4        | `ilr_acceptance_ms` p95     | 150 – 350 ms  | < 500 ms                         |
| 4        | `ilr_completion_ms` p95     | 15 – 45 s     | < 60 s                           |
| 5        | drain time post worker-kill | 1.5 – 4 min   | drained inside `DRAIN_TIMEOUT_S` |
| 6        | unique `export_id` count    | 1             | exactly 1                        |
| 7        | `postcode_lookup_ms` p95    | 2 – 6 ms      | < 10 ms                          |
| 7        | `safeguarding_scan_ms` p95  | 1 – 3 ms      | < 5 ms                           |

Baselines are guidelines. A consistent move outside the band over
two consecutive runs is the signal to investigate.

---

## Pre-conditions per scenario

A few scenarios assume staging-only helper endpoints that are
gated on `DEMO_MODE=true` so they can never reach production:

- **Scenario 5** uses `POST /api/admin/load-test/enqueue` to
  enqueue 500 benign `update_vocab` jobs in one shot. If that
  endpoint isn't deployed yet, the operator can manually trigger
  500 turns via the AI session API instead.
- **Scenario 7** uses `POST /api/admin/load-test/postcode-lookup`
  and `POST /api/admin/load-test/safeguarding-scan` so the latency
  measurement excludes auth + parse overhead. Without those
  endpoints, run the underlying cache probe directly inside the
  process via `npm run validate:safeguarding-messages` style
  scripts (slower but workable as a fallback).

Engineering tracks these load-test endpoints in the post-MVP
backlog. The scenarios surface a clear failure when the endpoints
aren't there, so you don't get a misleading green run.

---

## Reading the output

k6 writes a final summary to stdout and (when `handleSummary` is
defined, scenario 6) a `summary.json` file alongside the script.

For the brief's gate criteria:

- **PASS** when every threshold in `options.thresholds` is green.
- **FAIL** when k6 exits non-zero. The first failing threshold is
  reported at the top of the output.

The launch-checklist runner aggregates the seven exit codes — any
non-zero exit blocks the pilot launch.

---

## Post-run manual checks

Two scenarios require Mongo follow-up that k6 can't do directly:

### Scenario 5 — duplicate-write check

After the drain completes, run this Mongo query to confirm
idempotency held across the worker restart:

```js
db.aisessions.aggregate([
  { $match: { learnerId: ObjectId("<load-test-learner-id>") } },
  { $group: { _id: "$_id", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);
// Expected: zero documents. Any result row = a duplicate AISession
// was written, meaning idempotency failed under the worker restart.
```

### Scenario 6 — AuditLog uniqueness

```js
db.audit_logs.countDocuments({
  action: "ilr_export_completed",
  org_id: ObjectId("<org-id>"),
  "after_state.period_start": "<period-start>",
  "after_state.period_end": "<period-end>",
});
// Expected: 1. Anything else means the cache short-circuit failed
// and a duplicate AuditLog row was written.
```

Both queries are documented in the relevant scenario file's
header comment.

---

## Result archive

When a staging run completes, capture the output in a dated
RESULTS\_<date>.md alongside `RESULTS_TEMPLATE.md`. The CI runner
auto-archives; manual runs should follow the same pattern so the
launch gate has a reviewable trail.

The template's structure mirrors the seven scenarios, with a row
per metric and a verdict cell — keep it skim-able.
