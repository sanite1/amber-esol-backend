# Placement Assessment Calibration Protocol

**Status:** Required before production launch. One-time exercise.
**Owner:** Joey (Amber Training).
**Counter-signer:** Independent ESOL practitioner.
**Acceptance gate:** Function 6 To-Do 5 (brief).

The Gemini-scored placement assessment must produce results a qualified
ESOL practitioner would broadly agree with. This document defines the
field test we run before go-live to prove that. If the test fails, the
launch is blocked until the question bank is revised and the test is
re-run cleanly.

This is **not** an ongoing-operations doc. After production launch the
calibration runs only when the question bank materially changes
(`PlacementBank.version` bump) or when the org admin dashboard flags a
sustained downshift-rate anomaly.

---

## 1. Recruitment plan

### 1.1 Identify a qualified ESOL practitioner

- Email **NATECLA** at `info@natecla.org.uk` (the National Association for
  Teaching English and other Community Languages to Adults — `natecla.org.uk`).
  Ask for a referral to a practitioner who is:
  - Currently teaching ESOL at an FE college or community provider
  - Holds CELTA / DELTA / DipTESOL / equivalent qualification
  - Has at least three years' experience working across NQF Entry 1
    through Level 2
  - Is independent of Amber Training (no commercial relationship that
    would compromise their judgement)
- Confirm in writing that they understand the sign-off responsibility:
  they will counter-sign the calibration outcome before launch.
- Budget: agree a one-off consultancy fee covering the test session
  plus any question-bank review work the failure path requires.

### 1.2 Recruit 20 learners with already-known levels

Source 20 learners whose ESOL level has **already** been established
by a validated assessment within the last six months. The known level
is the ground truth we'll compare against.

Acceptable sources of a known level (in order of preference):

1. A current ForSkills assessment with a documented recommended level.
2. An equivalent third-party diagnostic (City & Guilds Functional
   Skills Initial Assessment, NCFE Skills for Life Diagnostic).
3. A practitioner's direct assessment from within the last six months,
   recorded in writing.

Distribution across levels — the cohort MUST cover the full range so
calibration isn't skewed:

| Level        | Minimum learners |
| ------------ | ---------------- |
| Entry 1 (e1) | 3                |
| Entry 2 (e2) | 5                |
| Entry 3 (e3) | 5                |
| Level 1 (l1) | 4                |
| Level 2 (l2) | 3                |

If a partner provider can't supply that spread, recruit additional
learners through NATECLA's network. **Do not** under-fill any band — a
calibration that misses e1 or l2 entirely tells us nothing about how
the bank performs at the extremes.

Logistics:

- Each learner gives written consent that their placement attempt and
  known level may be used for calibration. Use the standard DPIA-1
  consent form.
- Compensate each learner for their time — the assessment takes
  ~30 minutes.
- Run sessions in a quiet room with stable internet. The placement
  screen has no resumability across browsers if the JWT expires, so
  every learner must complete in one sitting.

---

## 2. Test procedure

### 2.1 Setup (day before)

1. Confirm the production-equivalent build is deployed to a staging
   environment with the **production** question bank loaded
   (`placement-questions.json` v1, validated by
   `npm run validate:placement-bank`).
2. Create 20 demo learner accounts in a dedicated "Calibration Cohort"
   organisation (use `is_demo: true` so these accounts are excluded
   from every ILR / RARPA aggregator).
3. Enrol each learner through the standard `/join` flow so the
   placement starts from the same state as a real onboarding.
4. Confirm Vertex AI is reachable from staging (`GET /api/health/gemini`
   returns latency < 5s).

### 2.2 Per-learner run (test day)

For each of the 20 learners:

1. The practitioner records the learner's **known level** privately
   (NOT entered into the platform yet — we want a blind comparison).
2. The learner takes the 20-question placement assessment unaided.
   No prompts, no time pressure, no help from the practitioner. The
   practitioner observes but does not intervene.
3. On completion, the platform displays the **assigned level** to the
   learner. The practitioner records it.
4. Optionally, the practitioner asks the learner two reflective
   questions (no impact on the calibration result):
   - "Did the level feel right?"
   - "Were any questions confusing or culturally unfamiliar?"
     Notes feed the qualitative review in §4 if the test fails.
5. The admin logs the comparison via the calibration tool:
   `POST /api/admin/calibration/log`
   with `{ learner_id, known_level, assigned_level, notes? }`.

### 2.3 Outcome computation

After all 20 logs are recorded, the admin dashboard at
`/admin/calibration` shows:

- Per-learner outcome bucket:
  - **correct** — `assigned_level === known_level`
  - **one_below** — assigned exactly one NQF rung below known
  - **one_above** — assigned exactly one NQF rung above known
  - **over** — assigned two or more rungs above known
  - **under** — assigned two or more rungs below known
- Cohort summary:
  - Count in each bucket
  - Pass / fail computed from §3 criteria

---

## 3. Pass criterion

The calibration **passes** when both of the following hold across the
20-learner cohort:

1. **At least 18 of 20 learners** land in the `correct` or `one_below`
   bucket.
2. **Zero** learners land in the `one_above` or `over` bucket.

Rationale for the asymmetric criterion: an over-assignment puts a
learner on lessons too hard for them — they disengage, drop out, and
the org loses the learner. An under-assignment by one rung is
recoverable — the lessons feel easy, the org admin sees the cohort_status
move to "active" quickly, and the teacher escalates the level on the
basis of session evidence (Function 12 level-change workflow). Two-rung
under-assignment isn't recoverable in a single funding window, hence
the "one rung" tolerance only.

---

## 4. Failure action

If either criterion fails, **do not launch**. The recovery loop:

1. **Practitioner review of the bank.** Sit with the practitioner and
   walk through every question, especially those in the levels where
   the failures clustered. The qualitative notes from §2.2 step 4 feed
   this review.
2. **Identify systematic issues.** Common patterns:
   - Questions written above their declared level (E2-tagged questions
     using L1 vocabulary)
   - Cultural assumptions that disadvantage learners from specific
     L1 backgrounds (Anglophone idioms, UK-centric context)
   - Reading-level mismatches (e.g. an Entry 1 listening question whose
     written stem requires Entry 3 reading to comprehend)
   - Translation errors in the per-language fields (re-confirm with a
     native-speaker reviewer per language)
3. **Adjust the question bank.** Revise affected questions in
   `placement-questions.json`. Bump `version` (e.g. 1 → 2). Re-run
   `npm run validate:placement-bank`.
4. **Re-recruit if needed.** If specific bands failed badly we may
   need additional learners at those levels to retest. Aim for the
   same 20-learner spread or larger.
5. **Re-run the test** with the revised bank. Same protocol, fresh
   cohort. The previously-tested learners' attempts are voided — they
   already saw the questions, so they're no longer blind.

The dashboard captures every run with its bank version so the audit
trail explains itself: "we ran calibration twice, the first against
bank v1 failed on E2 over-assignment, bank was revised, calibration
v2 against bank v2 passed."

---

## 5. Sign-off

Before flipping the production feature flag that exposes
`/esol/placement` to real learners, both parties counter-sign:

- **Joey (Amber Training)** — confirms the test was administered
  honestly, the cohort met the recruitment criteria, and the recorded
  levels match the platform's outputs.
- **ESOL practitioner** — confirms the calibration result is
  consistent with their professional judgement and that they were
  independent of Amber's commercial interests.

The signed sheet is filed under `compliance/placement-calibration-vN.pdf`
where N is the bank version that was tested.

Until both signatures are filed, the placement assessment route stays
behind the `PLACEMENT_ENABLED` env flag in production. Org admin
dashboards can still see the route exists; learners hitting
`/esol/placement` get a "coming soon" panel.

---

## Appendix A — Admin endpoints

- `POST /api/admin/calibration/log` — record one learner's outcome.
  Body: `{ learner_id, known_level, assigned_level, notes? }`.
- `GET  /api/admin/calibration/summary` — return all logs + computed
  pass/fail. Used by the `/admin/calibration` dashboard.
- `DELETE /api/admin/calibration/log/:id` — only Amber admin; use to
  scrub a row recorded in error before sign-off.

All endpoints require `isAuthenticated + isAdmin`. Org admins cannot
see these — calibration is platform-level, not org-level.

## Appendix B — What gets stored

`CalibrationLog` collection:

| Field            | Type                                   | Notes                                               |
| ---------------- | -------------------------------------- | --------------------------------------------------- |
| `learner_id`     | ObjectId → User                        | The calibration-cohort learner                      |
| `known_level`    | enum e1/e2/e3/l1/l2                    | Ground truth                                        |
| `assigned_level` | enum e1/e2/e3/l1/l2                    | What the platform assigned                          |
| `bank_version`   | number                                 | Pinned at log time so re-runs are distinguishable   |
| `outcome`        | correct/one_below/one_above/over/under | Computed at log time, never recomputed              |
| `practitioner`   | string                                 | The ESOL practitioner's name (for the sign-off PDF) |
| `notes`          | string?                                | Optional qualitative observation                    |
| `logged_by`      | ObjectId → User                        | The admin who recorded the row                      |
| `created_at`     | Date                                   | When the row was logged                             |

Append-only — same enforcement pattern as `AuditLog`. The DELETE
endpoint hard-deletes, doesn't soft-delete, and only an Amber admin
can call it.
