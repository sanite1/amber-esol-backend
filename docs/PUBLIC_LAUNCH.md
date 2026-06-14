# Public launch — gating checklist

> Eleven items that must be green before Project Silk opens to
> general availability. Built on top of the pilot launch and
> assumes the pilot retrospective has been written.
>
> "Public launch" means: the platform's URL is shared beyond the
> three pilot orgs; Amber accepts paid org-admin signups;
> learners outside the pilot cohort can have their data
> persisted, exported to ESFA, and audited under Ofsted's gaze.
>
> Until every item below is signed off, the platform stays in
> pilot-only mode — orgs sign engagement letters one at a time
> with Joey, not via a self-serve flow.
>
> Last updated: 2026-06-03 (initial draft, pre-pilot).

---

## Verdict tracker

Update this table as each item flips green. Public launch
unblocks when every cell reads ✅ and the sign-off block at the
bottom carries signatures.

| #   | Gate                                                              | Status | Owner                                                              | Notes                |
| --- | ----------------------------------------------------------------- | ------ | ------------------------------------------------------------------ | -------------------- |
| 1   | Pilot retrospective with green light                              | ☐      | Joey                                                               |                      |
| 2   | Compliance gate (Phase 2)                                         | ☐      | Joey + compliance reviewer                                         |                      |
| 3   | Performance baseline met (Phase 20.1)                             | ☐      | Engineering                                                        |                      |
| 4   | Security audit passed (Phase 20.2)                                | ☐      | Engineering + Joey                                                 |                      |
| 5   | Content authoring (Phase 19) signed off                           | ☐      | Joey + ESOL practitioner + safeguarding professional + translators |                      |
| 6   | WCAG 2.1 AA audit clean                                           | ☐      | Engineering + accessibility reviewer                               |                      |
| 7   | ICO registered, UKPRN issued, insurance in place                  | ☐      | Joey                                                               |                      |
| 8   | All 8 BullMQ workers running in prod with monitoring [ADDENDUM]   | ☐      | Engineering                                                        |                      |
| 9   | ComplianceConfig 2025/26 active in prod [ADDENDUM]                | ☐      | Joey (compliance lead)                                             |                      |
| 10  | Launch announcement: LinkedIn, press, NATECLA/AELP/Holex outreach | ☐      | Joey                                                               |                      |
| 11  | G-Cloud 15 listing application (September 2026 window)            | ☐      | Joey                                                               | Soft gate — see item |

---

## Item 1 — Pilot retrospective complete with green light

### Definition

The retrospective report defined in
[`PILOT_LAUNCH.md`](PILOT_LAUNCH.md) §9 is written, reviewed,
and signed off by Joey, the engineering lead, and at least one
external advisor (an ESOL practitioner or compliance contact
who reviewed the safeguarding sign-off).

### Pass criteria

- Retrospective filed at `docs/LAUNCH_DECISION_<date>.md` with
  one of these recommendations: **Go**, **Go after a
  remediation cycle**, or **Don't go**.
- This checklist only proceeds when the recommendation is
  **Go** **or** when the **Go after remediation** conditions
  have been met (the gap closed and re-evidenced).
- All four pilot success metrics from `PILOT_LAUNCH.md` §8
  passed across every pilot org:
  - ≥ 90% of learners completing 3+ AI sessions
  - Zero missed safeguarding incidents
  - Zero ILR export failures (technical or compliance)
  - Every org admin generating evidence report unaided from
    week 2

### Cross-references

- [`PILOT_LAUNCH.md`](PILOT_LAUNCH.md) — the pilot protocol.
- `docs/LAUNCH_DECISION_<date>.md` — the decision note.

---

## Item 2 — Compliance gate (Phase 2)

### Definition

Every item on the Phase 2 compliance gate is complete or has a
filed, explicit waiver from Joey.

### Pass criteria

- [`docs/COMPLIANCE_GATE.md`](COMPLIANCE_GATE.md) shows every
  item ticked **Complete** or **Waived** (a waiver carries a
  filed rationale + Joey's sign-off + a tracked re-review date).
- ESFA Test Submission protocol completed end-to-end against
  the ESFA test environment: see
  [`docs/ESFA_TEST_SUBMISSION.md`](ESFA_TEST_SUBMISSION.md).
  An accepted test submission is the prerequisite for any
  real funding-claim submission post-launch.
- Safeguarding pipeline reviewed end-to-end against
  [`docs/SAFEGUARDING_REVIEW.md`](SAFEGUARDING_REVIEW.md):
  detector → alert → DSL email → resolution flow.

### Cross-references

- [`docs/COMPLIANCE_GATE.md`](COMPLIANCE_GATE.md) — full gate.
- [`docs/ESFA_TEST_SUBMISSION.md`](ESFA_TEST_SUBMISSION.md)
- [`docs/SAFEGUARDING_REVIEW.md`](SAFEGUARDING_REVIEW.md)

---

## Item 3 — Performance baseline established and met (Phase 20.1)

### Definition

The k6 load test suite in `tests/load/` has been run against
production (not staging) at the expected pilot+ scale, and
every scenario passes.

### Pass criteria

- Most recent `tests/load/RESULTS_<date>.md` was run against
  the production deployment URL with realistic pilot-sized
  fixtures.
- Every one of the seven scenarios passes its threshold:
  1. AI sessions p95 turn latency < 5 s
  2. Bulk CSV import p95 < 30 s
  3. Dashboard load p95 < 2 s
  4. ILR export accept < 500 ms, complete < 60 s, valid CSV
  5. Queue resilience: 500 jobs survive worker kill + restart
  6. Idempotency: 10 concurrent triggers → 1 export
  7. Pre-cache: postcode < 10 ms p95, safeguarding scan
     < 5 ms p95
- Production Mongo + Redis sizing matches what the staging run
  was sized against. If staging was Upstash Free / Atlas M0
  but production is M20, the load test run is re-run against
  production sizing before this gate is signed off.

### Cross-references

- `tests/load/README.md`
- `tests/load/RESULTS_TEMPLATE.md`

---

## Item 4 — Security audit passed (Phase 20.2)

### Definition

[`docs/SECURITY_AUDIT.md`](SECURITY_AUDIT.md) shows PASS on
every one of the 12 items, with the developer + Joey
signatures in place.

### Pass criteria

- Items 10 (Vercel security headers), 11 (npm audit clean),
  12 (cross-org isolation pen test) all PASS — these are the
  audit's currently flagged blockers and must resolve.
- A re-audit has happened since the pilot retrospective —
  pilot-period changes might have introduced regressions.
  Specifically re-audit:
  - Any new routes added during the pilot.
  - Any cron / worker payload shape changes.
  - Any change to `requireOrgContext` or the org-scoping
    middleware family.
  - The `npm audit` re-runs clean (no high / critical introduced
    by pilot dependency bumps).
- Cross-org isolation pen test re-run against production with
  fresh org pair, results filed at
  `tests/security/cross-org-isolation-<date>.md`.

### Cross-references

- [`docs/SECURITY_AUDIT.md`](SECURITY_AUDIT.md)
- `tests/security/cross-org-isolation-<date>.md`

---

## Item 5 — Content authoring complete and signed off (Phase 19)

### Definition

Every item in [`docs/CONTENT_AUTHORING.md`](CONTENT_AUTHORING.md)
shows status `complete` with the required signatures.

### Pass criteria

- All 10 content items complete with sign-offs:
  - Joey on every item
  - ESOL practitioner on items A.1, A.3, A.4, A.5, B.8
  - Safeguarding professional on items A.2, A.6, B.9
  - Qualified translators on the L1-specific portions of A.4,
    A.5, A.6, B.8, B.9
- Pilot-period content tweaks (any L1 translation correction
  surfaced during pilot, any safeguarding-message phrasing
  flagged) have been incorporated, signed off, and live in
  production.
- Engineering re-runs the content validation scripts (`npm run
validate:scenarios`, `npm run validate:placement-bank`,
  `npm run validate:safeguarding-messages`) and they pass.

### Cross-references

- [`docs/CONTENT_AUTHORING.md`](CONTENT_AUTHORING.md)
- [`docs/SCENARIO_AUTHORING.md`](SCENARIO_AUTHORING.md)
- [`docs/PLACEMENT_CALIBRATION_PROTOCOL.md`](PLACEMENT_CALIBRATION_PROTOCOL.md)

---

## Item 6 — WCAG 2.1 AA audit clean

### Definition

Every learner-facing screen passes an axe-core scan with **zero
critical** and **zero serious** violations. Org-admin and
Amber-admin screens pass too, but learner screens are the
non-negotiable gate.

### Pass criteria

- Run `axe-core` (e.g. via `@axe-core/playwright` in CI or the
  axe DevTools browser extension manually) against:
  - **Learner — required clean (zero critical, zero serious):**
    - Login page
    - Learner home (`/esol/home`)
    - Placement assessment (`/esol/placement`)
    - AI tutor session (`/esol/session/:scenarioId`)
    - Session detail (`/esol/sessions/:sessionId`)
    - Vocab (`/esol/vocab`)
    - Stage 5 self-assessment (`/esol/stage5/:reviewId`)
  - **Org admin — required clean:**
    - Cohort dashboard (`/org-admin/dashboard`)
    - Learner detail (`/org-admin/learners/:id`)
    - Bulk import (`/org-admin/import`)
    - Teacher assignment (`/org-admin/teachers`)
    - Stage 5 review (`/org-admin/stage5/:reviewId`)
  - **Amber admin — required clean:**
    - All-orgs overview (`/admin/overview`)
    - Org detail (`/admin/orgs/:id`)
    - Compliance config (`/admin/compliance-config`)
    - Queues (`/admin/queues`)
    - Teacher utilisation (`/admin/teacher-utilisation`)
    - Failed jobs (`/admin/failed-jobs`)
- Manual keyboard-only navigation pass on every learner screen.
  Every interactive element must be reachable + activatable via
  Tab + Enter / Space. Focus rings visible.
- Manual screen-reader pass on the Stage 5 self-assessment
  page using VoiceOver (macOS) or NVDA (Windows). L1 labels on
  emoji buttons must read correctly.
- Lighthouse Accessibility score ≥ 95 on every audited URL.
- Results filed at `tests/accessibility/RESULTS_<date>.md`,
  one row per page, screenshot of zero violations attached.

### Cross-references

- [`docs/WCAG_REQUIREMENTS.md`](WCAG_REQUIREMENTS.md) — the
  accessibility brief.
- axe DevTools: <https://www.deque.com/axe/devtools/>

---

## Item 7 — ICO registered, UKPRN issued, insurance in place

### Definition

The three non-technical regulatory / commercial gates that let
Amber act as a data controller, a regulated training provider,
and a contracted supplier.

### Pass criteria

- **ICO registration** — Amber Training Ltd is registered with
  the Information Commissioner's Office as a data controller.
  Registration number recorded in
  `docs/regulatory/ICO_REGISTRATION.md` (to be created by
  Joey). Annual fee scheduled.
- **UKPRN** — UK Provider Reference Number issued by UKRLP.
  Number recorded in production env var `AMBER_UKPRN` (see
  `PRODUCTION_DEPLOYMENT.md` env matrix). Required for ILR
  submission; the export pipeline writes it into every row.
- **Insurance** — at minimum:
  - Professional indemnity (£5m for the contract types Amber
    targets; Joey confirms exact level with broker)
  - Cyber liability (covers data breach response,
    forensics, customer notification)
  - Public liability
  - Employer's liability (statutory)
- Certificates of insurance filed at
  `docs/regulatory/INSURANCE_<year>.md`. Renewal date in
  Joey's calendar.

### Cross-references

- `docs/regulatory/ICO_REGISTRATION.md` (Joey to author)
- `docs/regulatory/INSURANCE_<year>.md` (Joey to author)
- [`docs/PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md)
  — UKPRN env var location.

---

## Item 8 — All eight BullMQ workers running in production with monitoring [ADDENDUM]

### Definition

The full worker fleet is running on Railway (per
[`PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md) Stage 4),
each queue is processing jobs, and monitoring alerts fire on
backlog or failure.

### Pass criteria

- All nine workers running (the brief says eight; the codebase
  has nine after the `cache-refresh` worker was added — see
  `src/workers/index.ts`):
  - `esol-session`
  - `rarpa-evidence`
  - `ilr-export`
  - `compliance-validation`
  - `mis-push`
  - `priority-queue`
  - `delta-sync`
  - `notifications`
  - `cache-refresh`
- Railway dashboard shows the workers service `Running`, no
  recent crashes.
- `GET /api/admin/queues/summary` returns all nine queues with
  current counts.
- Bull Board (`/admin/queues`) accessible to Amber admin.
- **Monitoring alerts configured:**
  - BetterUptime monitors `/api/admin/queues/summary` and
    pages on:
    - Any queue's `failed` > 10
    - Any queue's `waiting + delayed` > 100 sustained for
      10 minutes
    - Empty `queues[]` array (workers dead)
  - Sentry capturing worker process exceptions.
  - Better Stack collecting worker logs.
- Failed-jobs dashboard (`/admin/failed-jobs`) reviewed weekly
  by engineering on-call. Triage cadence documented in
  `docs/ON_CALL_RUNBOOK.md` (to be created post-pilot).

### Cross-references

- [`docs/PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md)
  Stage 4 (worker fleet on Railway).
- `src/workers/index.ts` — fleet registration.
- `src/services/adminQueues.service.ts` — summary endpoint.

---

## Item 9 — ComplianceConfig 2025/26 active in production [ADDENDUM]

### Definition

The three compliance-config domains for academic year 2025/26 are
seeded and active in the production Mongo cluster, signed off by
Joey as compliance lead.

### Pass criteria

- `compliance_configs` collection in production carries
  `active: true` rows for all three:
  - `domain: "ilr"`, `academic_year: "2025/26"`
  - `domain: "rarpa"`, `academic_year: "2025/26"`
  - `domain: "asf-routing"`, `academic_year: "2025/26"`
- Each row's `rules` payload signed off by Joey via the Final
  Addendum §3 admin editor at `/admin/compliance-config`.
- The activation AuditLog row (`compliance_config_activated`)
  carries Joey's actor_id.
- Engineering's `npm run verify:compliance-cache` script run
  against production reports zero missing rules.
- Four ESFA 2025/26 breaking-change handlers verified live:
  1. SOF code 19 routing
  2. EnglishProgType field change
  3. SOC2000 → SOC mapping
  4. LLDDT code 15 expired remapping
     (Spot-check via the ILR export test cohort.)
- **Annual renewal calendar entry** for **1 August 2027** in
  Joey's calendar — next academic year needs the same exercise.

### Cross-references

- [`docs/CONTENT_AUTHORING.md`](CONTENT_AUTHORING.md) item B.10.
- `src/scripts/seedComplianceConfig.ts`
- `src/scripts/verifyComplianceCache.ts`

---

## Item 10 — Launch announcement

### Definition

Public-facing communication that signals the platform is
generally available, lined up with three sector channels.

### Pass criteria

- **LinkedIn post** by Joey:
  - One post on Joey's personal profile
  - One post on Amber Training Ltd's company page
  - Both drafted, reviewed by an external comms advisor for
    tone, scheduled to go live on launch day at 09:00 UK
  - Both link to `esol.ambertraining.co.uk` with the new
    contact form.
- **Press release** drafted (300-400 words). Sent to:
  - **NATECLA** — National Association for Teaching English
    and Community Languages to Adults. Press contact at
    <https://www.natecla.org.uk/>.
  - **AELP** — Association of Employment and Learning
    Providers. Press contact at <https://www.aelp.org.uk/>.
  - **Holex** — adult and community education network.
    Press contact at <https://holex.org.uk/>.
- Each press contact's response (acknowledged / published /
  passed) tracked in
  `docs/launch-comms/<YYYY-MM-DD>-press.md`.
- **Pilot org named permissions** captured. Each pilot org
  named in the press release with their written permission;
  any org that prefers anonymity is anonymised but the
  retrospective metrics still cited.
- **Sector publications** — one optional follow-up after
  launch (e.g. FE Week, TES). Joey times these to align with
  a real customer milestone (first pilot org's evidence-pack
  cited in an Ofsted conversation, etc).

### Tone

- Honest about the pilot scale. We launched after a 4-6 week
  pilot with 3 orgs — that's a real but modest base.
- Honest about what's in scope today and what's coming.
  Phase 21 MIS adapters and Phase 23 teacher-prep scoring are
  named as the next-up.
- Lead with the learner outcome, not the technology stack.
- Specific compliance positioning — "ESFA-aligned RARPA
  evidence pipeline" beats "AI-powered learning".

### Cross-references

- `docs/launch-comms/` — comms archive (Joey to author).

---

## Item 11 — G-Cloud 15 listing application (September 2026 window)

### Definition

Amber Training Ltd has submitted a complete G-Cloud 15
application for the Crown Commercial Service Digital
Marketplace, opening the platform to public sector procurement
under the framework.

### Pass criteria

- Application submitted within the **September 2026 window**
  (specific dates published by CCS — Joey to confirm exact
  window when CCS announces).
- Submission package includes:
  - Service definition document (~3 pages)
  - Terms and conditions
  - Pricing schedule
  - Service-level agreement
  - Skills Framework for the Information Age (SFIA) rate card
    if applicable
- Required Cyber Essentials Plus certification in place
  **before** submission. Tracked in
  `docs/regulatory/CYBER_ESSENTIALS.md`.
- Submission tracking number filed at
  `docs/regulatory/G_CLOUD_15_APPLICATION.md`.

### Soft gate note

G-Cloud 15 is the **only soft gate** on this checklist. The
platform CAN launch publicly without G-Cloud listing — the
listing opens additional sales channels but isn't a
prerequisite for accepting paid org-admin signups. If the
September 2026 window slips for reasons outside our control
(application paused, CCS scheduling change), public launch
still proceeds; G-Cloud 15 lands as a follow-up.

If the application is withdrawn, paused, or rejected, that's
material — file as a `pilot-feedback` issue tagged
`compliance` against this document and escalate to the
launch decision meeting.

### Cross-references

- CCS Digital Marketplace:
  <https://www.digitalmarketplace.service.gov.uk/>
- `docs/regulatory/G_CLOUD_15_APPLICATION.md` (Joey to
  author once application starts)

---

## Go / no-go decision meeting

### When

Within 2 weeks of the pilot retrospective being filed (per
[`PILOT_LAUNCH.md`](PILOT_LAUNCH.md) §9). If items above are
still red at the meeting, the meeting documents the gaps and
sets a re-meet date — it doesn't force a no-go.

### Who

- Joey
- Engineering lead
- The external advisor present at the retrospective decision
  meeting
- One additional Amber Training board member or trusted
  advisor (so the room isn't only the team that built it)

### Pre-read

- This checklist with every item's status updated.
- The pilot retrospective.
- The latest security audit.
- The latest load test results.
- The latest WCAG audit.

### Output

A one-page **Public Launch Decision Note** filed at
`docs/LAUNCH_DECISION_PUBLIC_<date>.md`. Options:

- **Go** — every item green; launch date confirmed.
- **Conditional go** — named conditions to close, with named
  owners and target dates. Re-meet to confirm closure.
- **Delay** — material gaps; the launch slips; specific
  re-meet date set; pilot orgs notified.

### Communication

- **Pilot orgs** notified within 24 hours of the meeting via
  their Slack channels.
- **Sector contacts** (NATECLA, AELP, Holex) notified once a
  confirmed launch date exists.
- **Public** — no announcement until the decision is **Go**
  and every checklist item is green.

---

## Launch day choreography

Once go / no-go is **Go** and a date is set, this is the
runbook for launch day itself.

### 7 days out

- [ ] Final smoke against production (full end-to-end as a
      fresh org admin).
- [ ] Final `npm audit` clean.
- [ ] BetterUptime alert routing verified — Joey paged on S1.
- [ ] On-call rota covers launch day + first week 24/7.
- [ ] Pilot orgs sent a heads-up: "We're going live on `<date>`;
      nothing about your account changes; if anything looks off
      let us know immediately".

### Launch day morning (07:00 UK)

- [ ] Engineering on-call standing by.
- [ ] Joey on standby.
- [ ] Final production smoke.
- [ ] Confirm BetterUptime all green.
- [ ] Confirm Sentry quiet.

### Launch day 09:00 UK

- [ ] Joey publishes LinkedIn posts.
- [ ] Press release sent to NATECLA, AELP, Holex.
- [ ] Frontend marketing copy updated (`esol.ambertraining.co.uk`
      landing page reflects general availability).
- [ ] Pilot org slack channels — "We're live. Thank you."

### Launch day + 1 hour

- [ ] First incoming signup arrives? If so, Joey personally
      shadows their first session.
- [ ] BetterUptime + Sentry monitoring active. Any alert in
      the first 24h is treated as S1.

### Launch day evening

- [ ] Internal stand-up: how did it go, anything to fix
      tomorrow, on-call handoff.

---

## First 30 days post-launch

### Daily

- [ ] Joey reviews new signups; reaches out to each org admin
      personally with onboarding offer.
- [ ] Engineering on-call reviews Sentry + BetterUptime.
- [ ] Failed-jobs dashboard reviewed.

### Weekly

- [ ] Engineering reviews the load profile — how are real
      production numbers tracking against the load test
      baselines?
- [ ] Joey emails the early-adopter orgs (same template as
      `PILOT_WEEKLY_EMAIL_TEMPLATE.md` adapted for production).

### At day 30

- [ ] Post-launch retrospective written: what worked, what
      didn't, what changes for day 60. Filed at
      `docs/POST_LAUNCH_DAY30_<date>.md`.
- [ ] Public-launch tracker (this document) archived as
      `docs/launch-records/PUBLIC_LAUNCH_<date>.md` with the
      final state of every item.

---

## Out of scope for this checklist (tracked separately)

- **Phase 21 — MIS adapters** (ProSolution, Maytas, EBS).
  Real adapters land post-launch. Until then the MIS settings
  panel surfaces stubs; the brief's Function 15 §7 work is
  the surface, Phase 21 fills the body.
- **Phase 23 — teacher-prep scoring**. Stubbed today in the
  `priority-queue` worker. Lands post-launch.
- **Phase 24 — teacher messaging UI**. Stub.
- **Multi-region redundancy.** MVP runs single-region; out of
  scope for v1.0 launch. Tracked in the operations backlog.

---

## Sign-off

Public launch requires **all three signatures** below. None of
them may sign in advance of the others — the signatures must
be sequential, with the date of the previous signature visible.

| Order | Role                                            | Date | Name | Signature |
| ----- | ----------------------------------------------- | ---- | ---- | --------- |
| 1     | Engineering lead — confirms items 3, 4, 6, 8    |      |      |           |
| 2     | Joey — confirms items 1, 2, 5, 7, 9, 10, 11     |      |      |           |
| 3     | External advisor — confirms the overall posture |      |      |           |

**Public launch unblocks** when all three signatures are in
place AND the Public Launch Decision Note records **Go**.

**Until both conditions are met,** the production frontend
serves only pilot-org logins; the public-facing landing page
shows a "by appointment" form rather than a self-serve
signup. The technical gating for this lives in a
feature-flag check in `src/modules/dashboard/components/routes/PublicRoute.tsx`
— flip the flag only after this checklist is fully signed off.

---

## Cross-references

- [`docs/PILOT_LAUNCH.md`](PILOT_LAUNCH.md)
- [`docs/PILOT_DEPLOYMENT_CADENCE.md`](PILOT_DEPLOYMENT_CADENCE.md)
- [`docs/PRODUCTION_DEPLOYMENT.md`](PRODUCTION_DEPLOYMENT.md)
- [`docs/PRODUCTION_SETUP_CHECKLIST.md`](PRODUCTION_SETUP_CHECKLIST.md)
- [`docs/SECURITY_AUDIT.md`](SECURITY_AUDIT.md)
- [`docs/CONTENT_AUTHORING.md`](CONTENT_AUTHORING.md)
- [`docs/COMPLIANCE_GATE.md`](COMPLIANCE_GATE.md)
- [`docs/ESFA_TEST_SUBMISSION.md`](ESFA_TEST_SUBMISSION.md)
- [`docs/SAFEGUARDING_REVIEW.md`](SAFEGUARDING_REVIEW.md)
- [`docs/WCAG_REQUIREMENTS.md`](WCAG_REQUIREMENTS.md)
- [`docs/DEMO_ENVIRONMENT.md`](DEMO_ENVIRONMENT.md)
- `tests/load/README.md`
- `tests/accessibility/RESULTS_<date>.md`
- `tests/security/cross-org-isolation-<date>.md`
