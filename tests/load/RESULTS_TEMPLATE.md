# Load test results — `<YYYY-MM-DD>` staging run

> Fill in this template after running the seven k6 scenarios against
> staging. Save as `RESULTS_<YYYY-MM-DD>.md` in this directory. The
> launch-checklist runner expects one file per staging run; pilot
> launch is blocked until every scenario shows **PASS**.

## Run metadata

| Field             | Value                                          |
|-------------------|------------------------------------------------|
| Run date          | YYYY-MM-DD HH:MM Europe/London                 |
| Operator          | (your name)                                    |
| `BASE_URL`        | https://api-staging.ambertraining.co.uk        |
| Backend git sha   | (output of `git rev-parse --short HEAD`)       |
| Staging Mongo     | Atlas cluster name / instance size             |
| Staging Redis     | Upstash plan / region                          |
| Fixture state     | Seeded Hillview (clean from 03:00 UTC reset?)  |
| k6 version        | (output of `k6 version`)                       |

## Verdict

| #  | Scenario                | Verdict | Notes (if not PASS)                       |
|----|-------------------------|---------|-------------------------------------------|
| 1  | AI sessions             | ☐ PASS / ☐ FAIL | |
| 2  | Bulk CSV import         | ☐ PASS / ☐ FAIL | |
| 3  | Dashboard load          | ☐ PASS / ☐ FAIL | |
| 4  | ILR export              | ☐ PASS / ☐ FAIL | |
| 5  | Queue resilience        | ☐ PASS / ☐ FAIL | |
| 6  | Idempotency under retry | ☐ PASS / ☐ FAIL | |
| 7  | Pre-cache performance   | ☐ PASS / ☐ FAIL | |

**Overall: ☐ PASS — pilot launch unblocked / ☐ FAIL — see fix list below**

---

## Per-scenario detail

### Scenario 1 — Concurrent AI sessions

| Metric                       | Baseline range | This run | Gate    | Verdict |
|------------------------------|----------------|----------|---------|---------|
| `turn_latency_ms` p50        | 1.0 – 2.0 s    |          | —       | —       |
| `turn_latency_ms` p95        | 2.5 – 4.5 s    |          | < 5 s   | ☐       |
| `turn_latency_ms` p99        | 5 – 9 s        |          | < 10 s  | ☐       |
| `session_start_latency_ms` p95 | 300 – 800 ms |          | —       | —       |
| `session_end_latency_ms` p95 | 200 – 600 ms   |          | —       | —       |
| `http_req_failed` rate       | < 0.5 %        |          | < 1 %   | ☐       |

**Iterations completed:** ___ / 50

**Notes:**
- Any specific turn that consistently slowed (e.g. turn 1 always
  cold-cached and 2× the median)?
- Any single VU's session that timed out entirely?
- Tokens used (so the same VU set can be re-run):

---

### Scenario 2 — Bulk CSV import

| Metric                  | Baseline range | This run | Gate    | Verdict |
|-------------------------|----------------|----------|---------|---------|
| `import_duration_ms` p95 | 10 – 20 s     |          | < 30 s  | ☐       |
| `imports_completed` total | 12 – 20      |          | ≥ 10    | ☐       |
| `http_req_failed` rate  | < 0.5 %        |          | < 1 %   | ☐       |

**Notes:**
- Any rows blocked by validation? (Should be zero — synthetic CSV.)
- Memory spike on the API process during the burst?

---

### Scenario 3 — Dashboard load

| Metric                                | Baseline | This run | Gate    | Verdict |
|---------------------------------------|----------|----------|---------|---------|
| `dashboard_load_ms` p95 (unfiltered)  | < 1.2 s  |          | < 2 s   | ☐       |
| `dashboard_load_ms` p95 (filtered)    | < 1.2 s  |          | < 2 s   | ☐       |
| `http_req_failed` rate                | < 0.2 %  |          | < 0.5 % | ☐       |

**Notes:**
- Did the filtered path actually hit the index? Confirm via
  the Atlas profiler or the `explain()` plan if p95 was unexpectedly high.

---

### Scenario 4 — ILR export

| Metric                | Baseline   | This run | Gate     | Verdict |
|-----------------------|------------|----------|----------|---------|
| `ilr_acceptance_ms` p95 | 150 – 350 ms |       | < 500 ms | ☐       |
| `ilr_completion_ms` p95 | 15 – 45 s    |       | < 60 s   | ☐       |
| `ilr_download_ms` p95   | 50 – 200 ms  |       | —        | —       |
| CSV row count check     | 200 rows     |       | exact    | ☐       |
| CSV content-type        | text/csv     |       | text/csv | ☐       |

**Notes:**
- Worker concurrency during the run?
- Any warnings in the `warnings_count` on the status response?

---

### Scenario 5 — Queue resilience

| Metric                                      | This run | Gate           | Verdict |
|---------------------------------------------|----------|----------------|---------|
| Jobs enqueued                               |          | 500 expected   | ☐       |
| Worker kill timestamp                       |          |                |         |
| Worker restart timestamp                    |          |                |         |
| `queue_drain_ms` total                      |          | < 10 min       | ☐       |
| `completed` delta vs baseline               |          | ≥ 500          | ☐       |
| `failed_jobs_count`                         |          | (record)       | —       |
| Duplicate AISession query result            |          | zero rows      | ☐       |

**Notes:**
- Method used to kill the worker (SIGTERM? SIGKILL? container stop?)
- Time between kill and restart
- Any failed-jobs rows in the dashboard `/admin/failed-jobs` after
  the run? Capture the row IDs here.

---

### Scenario 6 — Idempotency under retry

| Metric                                       | This run | Gate         | Verdict |
|----------------------------------------------|----------|--------------|---------|
| `trigger_ms` p95                             |          | < 500 ms     | ☐       |
| Unique `export_id`s observed                 |          | exactly 1    | ☐       |
| AuditLog count for the export (manual query) |          | exactly 1    | ☐       |
| `http_req_failed` rate                       |          | < 1 %        | ☐       |

**Period tested:**
- `period_start`:
- `period_end`:
- `academic_year`:

**Mongo follow-up output:** paste the result of the
`db.audit_logs.countDocuments(…)` query from the scenario header.

---

### Scenario 7 — Pre-cache performance

| Metric                       | Baseline   | This run | Gate    | Verdict |
|------------------------------|------------|----------|---------|---------|
| `postcode_lookup_ms` p95     | 2 – 6 ms   |          | < 10 ms | ☐       |
| `safeguarding_scan_ms` p95   | 1 – 3 ms   |          | < 5 ms  | ☐       |
| Postcode iterations          | 1000       |          | 1000    | ☐       |
| Safeguarding iterations      | 1000       |          | 1000    | ☐       |

**Notes:**
- Cache state at start? (Was the postcode dataset already warm,
  or was this the first call since the worker started?)
- Redis network RTT to staging app: ___

---

## Failures and fix list

For every scenario that returned FAIL, fill in one row below. The
list is the input to the launch-blocker triage — every row must
have a JIRA / GitHub issue link and an owner before the launch
gate flips green.

| #  | Scenario | Symptom (what failed) | Suspected cause | Issue link | Owner | Status |
|----|----------|------------------------|-----------------|------------|-------|--------|
|    |          |                        |                 |            |       |        |
|    |          |                        |                 |            |       |        |
|    |          |                        |                 |            |       |        |

---

## Re-run plan

If any scenarios failed, document the re-run plan:

- [ ] Issue(s) above resolved
- [ ] Code change merged to staging (commit SHA: ___)
- [ ] Re-run target date: ___
- [ ] Re-run scenarios: (list — only the failing ones, not the
       full suite, unless a backend change might affect them)

The launch-checklist runner re-evaluates whenever a new
`RESULTS_<date>.md` is committed — pilot launch unblocks when the
most-recent file shows every scenario at PASS.
