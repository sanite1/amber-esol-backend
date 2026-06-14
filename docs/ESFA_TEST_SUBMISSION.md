# ESFA Test Submission Protocol

**Status:** Required before v1.0 launch. Required again on any change to the ILR mapper, breaking-change handlers, or validation rules.
**Owner:** Joey (compliance lead).
**Counter-signer:** Amber Training MD (sign-off on the final report).
**Acceptance gate:** Function 13 To-Do 4 (brief).

The platform's ILR export pipeline ([`buildIlrRows`](../src/services/ilrExport.service.ts) → [`validateRows`](../src/services/ilrExport.service.ts) → CSV writer → [BullMQ `ilr-export` worker](../src/services/queueProcessors/index.ts)) produces a CSV that funding submissions are made from. Before any real learner data is ever submitted to ESFA in production, the same code path MUST be exercised end-to-end against the ESFA test environment with **fictional** data, and the resulting validation report MUST come back **clean** (zero errors, zero warnings).

This document is the Joey-led runbook for that exercise. It is **not** automated — the upload step requires interactive sign-in to gov.uk and the validation report is delivered by email 24–48 hours later. Automation would buy nothing here because the audit trail of "Joey opened the test portal, uploaded the file, received this report" is itself the evidence that satisfies the compliance gate.

A regenerated CSV from a code change that touches any of the following invalidates the previous sign-off and requires a fresh run:

- Anything under `src/services/ilrExport.service.ts` or `src/services/ilrCsvWriter.service.ts`
- The active `ComplianceConfig` document for the `ilr` domain
- The User schema fields that feed ILR (uln, dateOfBirth, sex, lldd_health_prob, sof_code, esol_aim_type, esolLevel, english_prog_type, postcode_prior)
- The AISession schema fields that feed ILR (duration_mins, session_source, completedAt, passed)

---

## Workflow at a glance

```
1. Confirm prerequisites
2. Seed fictional production data
3. Generate export via the live route
4. Download the CSV
5. Upload to ESFA Submit Learner Data (TEST environment)
6. Wait 24–48 hours for the validation report
7. Review every flagged warning and error
8. If clean → sign off + proceed to v1.0 launch
9. If not clean → fix in code, regenerate, resubmit, repeat
```

Each step has its own section below. **Do not skip step 1.** A submission without a valid UKPRN will be rejected by the portal at upload time and the time spent on steps 2–6 is wasted.

---

## Step 1 — Prerequisites

### 1.1 UKPRN

Amber Training's UKPRN must be issued and active before the test environment will accept a submission. This is the **compliance gate Task 2** from the platform-wide compliance checklist — without it, the rest of the protocol is blocked.

- Confirm the UKPRN by querying the [UKRLP search](https://www.ukrlp.co.uk/) for "Amber Training".
- Confirm it's recorded on the production `Organisation` record:

  ```bash
  # in the production mongo shell
  db.organisations.findOne({ name: /Amber Training/ }, { ukprn: 1, is_demo: 1 })
  ```

  The record should show `{ ukprn: "<8-digit-number>", is_demo: false }`. If `ukprn` is null, do not proceed — escalate to the MD for a UKRLP follow-up.

### 1.2 Fictional learners in production

The brief requires **at least 5 fictional learner records** to be present in the **production** database. The seed script for these is the demo-seed pipeline from Phase 17 (`scripts/seed-demo-learners.ts`), executed against the production database with the `--target-org=<fictional-org-id>` flag.

- Create a dedicated fictional org in production for this exercise. Mark `is_demo: false` (it has to look like a real org from the platform's perspective) but pick a name that's obviously not a real customer (e.g. `"ESFA Test Submission Org"`).
- Seed 5–10 learners against that org. The seed script populates every ILR-relevant field: ULN (fictional but ULN-shaped, 10 digits), DOB, sex, postcode, etc.
- Run at least one AI tutor session per learner so the export has sessions to map. The seed script can do this end-to-end.

### 1.3 ESFA Submit Learner Data account

- Joey holds the gov.uk One Login credentials for Amber Training's ESFA submissions.
- The TEST environment is a separate URL from production — bookmark it: `https://submit-learner-data.service.gov.uk/test/`.
- If access has lapsed, request reinstatement via the Apprenticeship Service support line; new account provisioning can take a week, so don't leave it to the day of the run.

### 1.4 Active compliance config

The platform refuses to produce ILR rows if the `ComplianceConfig` document for the current academic year is missing. Confirm before generation:

```bash
# in the production mongo shell
db.complianceconfigs.findOne(
  { domain: "ilr", academic_year: "2025/26", active: true },
  { version: 1, updated_at: 1 }
)
```

If the result is null, follow [COMPLIANCE_GATE.md](./COMPLIANCE_GATE.md) to land the year's config before continuing.

---

## Step 2 — Generate the export

Use the production route — the one the org admin would use:

```http
POST /api/org-admin/export/ilr
Authorization: Bearer <Joey's org-admin JWT for the fictional org>
Content-Type: application/json

{
  "academic_year": "2025/26",
  "period_start": "2025-08-01",
  "period_end": "2026-07-31"
}
```

Expect a `202 Accepted` response with:

```json
{
  "export_id": "<sha256>",
  "job_id": "ilr:<sha256>",
  "status_url": "/api/org-admin/export/ilr/<job_id>/status",
  "download_url": "/api/org-admin/export/ilr/<export_id>/download",
  "json_url": "/api/org-admin/export/ilr/<export_id>/download?format=json"
}
```

Poll `status_url` until `status: "completed"`. Typical end-to-end runtime for a 10-learner cohort is **< 30 seconds**. If you see `status: "failed"`, check the `failed_reason` field on the response and the worker logs.

### Important — `is_demo` flag

Step 1.2 explicitly says the fictional org must NOT be marked `is_demo: true`. The platform has a defense-in-depth guard ([`buildIlrRows`](../src/services/ilrExport.service.ts) refuses demo orgs with 403, brief Function 13) that would block this submission. The org is "fictional but treated as live" for the purpose of this exercise — its data is purely Joey's seed, but the export pipeline behaves as it would for a real org.

If you accidentally mark the org `is_demo: true`, you'll get this error:

> 403 ILR export is disabled for demo organisations. Demo data must never be submitted to ESFA.

Toggle the flag back to `false` on the fictional org and re-run from step 2.

---

## Step 3 — Download the CSV

```http
GET /api/org-admin/export/ilr/<export_id>/download
Authorization: Bearer <Joey's JWT>
```

The response is a `text/csv` stream with the filename in the `Content-Disposition` header:

```
ILR_<orgName>_2025-26_2025-08-01_to_2026-07-31.csv
```

Save the CSV locally **with the original filename**. The ESFA portal uses the filename to match uploads to the org; renaming may cause the upload to be rejected with a confusing "unknown organisation" error.

### Also download the companion JSON

```http
GET /api/org-admin/export/ilr/<export_id>/download?format=json
```

This is the metadata file:

```jsonc
{
  "export_id": "...",
  "generated_at": "ISO timestamp",
  "compliance_config_version": 3,
  "totals": {
    "ai_glh": 100,
    "pre_platform_glh": 50,
    "teacher_contact_glh": 25,
    "total_glh": 175
  },
  "learner_count": 7,
  "rows_exported": 7,
  "rows_blocked": 0,
  "warnings": [...]
}
```

**Before upload, sanity-check the JSON:**

- `learner_count` matches the number of fictional learners you seeded in step 1.2
- `rows_blocked` is 0 (any blocked rows mean validation failed locally — see [Function 13 To-Do 3](../src/services/ilrExport.service.ts))
- `compliance_config_version` is the latest active version
- `totals.total_glh` looks reasonable (10 hours × 7 learners ≈ 70 hours is plausible; 7 hours total is not)

If any of these are off, **do not upload**. Fix the data or the code, regenerate, and start step 3 again.

---

## Step 4 — Upload to ESFA Submit Learner Data (TEST)

1. Open `https://submit-learner-data.service.gov.uk/test/` in an incognito window (clean session state).
2. Sign in with the gov.uk One Login credentials.
3. Select **Submit ILR data** → **Test environment**.
4. Choose the academic year `2025 to 2026`.
5. Upload the CSV from step 3.
6. The portal will run an initial format check (file is valid CSV, headers recognised) within ~30 seconds. **Note the submission ID** that appears — it looks like `<8-char>-<4-char>-<4-char>-<4-char>-<12-char>` (a UUID).
7. The portal will then queue the file for full validation. Don't close the tab — you'll get a banner saying "Validation queued — you will receive an email when the report is ready."

Record the submission ID in the **Sign-off log** section at the bottom of this document immediately.

---

## Step 5 — Wait for the validation report

- ESFA's SLA is **24–48 hours**.
- The report arrives by email to the gov.uk One Login email address. Joey may need to whitelist `noreply@esfa.education.gov.uk` if the email lands in spam.
- The email contains a link to download the report PDF — that link expires after 30 days. **Download the PDF immediately and save it to** `compliance/esfa-test-submissions/<submission_id>.pdf`.

**Do not** treat the absence of the email as success. The portal occasionally fails silently when the queue is busy (especially the week of a funding deadline). If 48 hours pass with no email:

1. Sign back into the portal and check the submission's status directly.
2. If the portal shows "Validation failed to run", re-upload the exact same CSV.
3. If the portal shows "In progress" still, wait another 24 hours — at the 72-hour mark, contact ESFA support.

---

## Step 6 — Review the report

The report has three sections:

1. **Errors** — rows the validator rejected. Funding cannot be claimed for these.
2. **Warnings** — rows the validator accepted with concerns. Funding can be claimed but a future submission with the same issue may be rejected.
3. **Summary** — total rows accepted, total errors, total warnings.

For each entry, the report includes:

- The row's ULN
- The field name (e.g. `LearnAimRef`, `SOF`, `LLDDHealthProb`)
- The error/warning code (e.g. `R56`, `W83`)
- A plain-English description

Cross-reference each entry with the platform's own validation output (the companion JSON's `warnings` array). The two should disagree on at most the warnings (ESFA's warning set may be broader than ours); the errors should be empty in both.

### Common categories and where to fix

| ESFA flag                                      | Platform location to fix                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `LearnAimRef not valid for this funding model` | `ComplianceConfig.rules.esol_level_to_aim_ref` — update the FALA code       |
| `SOF not in valid set for academic year`       | `ComplianceConfig.rules.valid_sof_codes` — the 19-route mapping has shifted |
| `LLDDHealthProb code retired`                  | `ComplianceConfig.rules.expired_llddt_codes` + `llddt_remapping`            |
| `EnglishProgType missing`                      | `User.english_prog_type` not set; fix the bulk importer + the wizard        |
| `Field name not recognised`                    | `ComplianceConfig.rules.field_name_overrides` (e.g. `SOC2000` rename)       |
| `Date in wrong format`                         | `formatIlrDate` in `ilrExport.service.ts`                                   |
| `Row contains a future date`                   | Bug in `formatIlrDate` or the source date field                             |
| `Duplicate AimSeqNumber for learner`           | Bug in `buildRowForSession` — the per-learner counter is broken             |

For categories not in the table, ask Joey before changing anything — some ESFA flags are advisory and the fix is documentation, not code.

---

## Step 7 — Decision: clean or iterate

### Clean (zero errors, zero warnings)

Proceed to step 8. The compliance gate for v1.0 launch is **passed** for the ILR pipeline. **The Stage5Review of this submission counts as the platform's funding-readiness evidence** for Ofsted-equivalent inspection.

### Not clean (any errors, OR any warnings the team isn't comfortable with)

Proceed to step 9. The exercise has succeeded in finding a real issue; the platform is doing exactly what it's supposed to.

> A first run with zero issues is suspicious. Most first runs surface 1–5 minor warnings that the test exists to catch. If your first report is genuinely clean, double-check the upload actually completed (return to step 5 and verify the portal's submission record).

---

## Step 8 — Sign off

1. The validation report PDF is saved at `compliance/esfa-test-submissions/<submission_id>.pdf`.
2. Add an entry to the **Sign-off log** below with the submission ID, date, and a Y/N on each criterion.
3. Joey signs the entry (initials in plain text — this file is the audit record).
4. The MD counter-signs by adding their initials on the next line.
5. Commit the file change to `main` with the message `compliance: ESFA test submission <submission_id> signed off`.
6. The compliance gate for ILR is now **passed**. v1.0 launch can proceed.

---

## Step 9 — Iterate

1. Read the report's "Errors" and "Warnings" sections side-by-side with the platform's companion JSON.
2. For each ESFA-side issue:
   - If it's a code bug, raise a fix in a branch named `compliance/esfa-fix-<short-description>`.
   - If it's a config issue (most common — DfE updates the SOF whitelist, retires a code, renames a field), update the active `ComplianceConfig` via `ComplianceConfigService.update()`.
   - Run `npx jest src/__tests__/ilr*.test.ts --runInBand` before committing — the test suites already cover most of what ESFA validates.
3. Land the fix, redeploy production.
4. Return to step 2 with the **same fictional org** (data is unchanged; only the export pipeline behaviour shifted).
5. Note in the sign-off log that this is a second / third attempt — keep the prior submission IDs for traceability.

The expected number of iterations on a first ever submission is **1–3**. More than 3 is a sign that the underlying compliance config is significantly out of date or the FALA whitelist is stale — escalate to the MD before continuing to burn portal submissions (ESFA rate-limits test uploads at 10/day per organisation).

---

## Sign-off log

> **Format per row:** `YYYY-MM-DD | <submission_id> | <result> | Joey: <initials> | MD: <initials>`
>
> Result is one of:
>
> - `PASS` — zero errors, zero warnings
> - `FAIL-fix` — issues found, fix planned, resubmission required
> - `FAIL-blocked` — issues found, fix requires external dependency (e.g. waiting on DfE config publication)

| Date                   | Submission ID | Result | Joey | MD  | Report PDF | Notes |
| ---------------------- | ------------- | ------ | ---- | --- | ---------- | ----- |
| _(awaiting first run)_ |               |        |      |     |            |       |

---

## Appendix A — What the platform refuses to submit

These are the local gates the platform applies before the CSV is even produced. Understanding them helps interpret the ESFA report (an ESFA-side error on something the platform already rejects suggests a config drift between the local rules and the test environment).

- **Demo org guard** ([`buildIlrRows`](../src/services/ilrExport.service.ts)): `Organisation.is_demo: true` → 403, no rows produced. Brief Function 13.
- **Invalid ULN** (E1, [validation §3](../src/services/ilrExport.service.ts)): non-10-digit numeric strings block the row.
- **SOF not on whitelist** (E2): row blocked, SOF field nulled.
- **LLDD not in {1, 2, 9}** (E3): row blocked.
- **LLDDT-15 with no remap target** (`_skip_row` from breaking-change layer): row hard-stopped, no override available.

These five gates between them filter most of the "obviously broken" rows before ESFA sees them. The test submission's job is to find the **subtle** issues — the ones that pass our gates but ESFA still flags.

---

## Appendix B — Subsequent academic years

When DfE publish the 2026/27 ILR specification (typically June/July):

1. Update `ComplianceConfig` for `academic_year: "2026/27"` with the new `field_name_overrides`, `valid_sof_codes`, `expired_llddt_codes`, etc.
2. Update the seed script's fictional learners to use 2026/27-appropriate aim references.
3. Re-run this entire protocol against the test environment with `academic_year: "2026/27"`.
4. Add a new section to the Sign-off log.

A clean sign-off in one academic year does NOT carry over — the spec changes annually, and the platform's behaviour against the new spec is unverified until this protocol runs against it.
