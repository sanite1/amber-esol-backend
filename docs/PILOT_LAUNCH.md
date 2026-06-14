# Pilot launch protocol — Project Silk

> The playbook for the 4–6 week pilot that gates public launch.
> Joey owns delivery; engineering owns the platform. This document
> is the contract between both sides AND the contract with the
> pilot organisations.
>
> **Read this if:** you're Joey planning a pilot, you're an
> engineer paged about a pilot-org incident, you're a pilot org
> admin onboarding, or you're scoping the public-launch decision.
>
> Last updated: 2026-06-03 (initial draft, pre-pilot).

---

## Pre-pilot readiness gate

The pilot **cannot start** until every item below is green. This
mirrors the launch checklist; the document references are the
authoritative records.

| Gate                                                                                                                                                                                   | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Production deployment live + smoke-tested per `PRODUCTION_DEPLOYMENT.md`                                                                                                               | ☐      |
| Production setup checklist (`PRODUCTION_SETUP_CHECKLIST.md`) signed off — engineering + Joey                                                                                           | ☐      |
| Security audit (`SECURITY_AUDIT.md`) shows PASS on all 12 items; signed off                                                                                                            | ☐      |
| Content authoring tracker (`CONTENT_AUTHORING.md`) sign-offs in place: Layer 1/2/3 prompts, 3 scenarios, 80-question placement bank, 30 safeguarding messages, compliance config seeds | ☐      |
| Load test results (`tests/load/RESULTS_<date>.md`) show every scenario PASS against staging                                                                                            | ☐      |
| Demo environment (`DEMO_ENVIRONMENT.md`) demonstrably working — Joey has used it to run a mock onboarding meeting end-to-end                                                           | ☐      |
| User guide PDF written, reviewed by Joey + one ESOL practitioner, ready to hand to pilot org admins (see §4)                                                                           | ☐      |
| Incident on-call rota set (`docs/ON_CALL_ROTA.md`); engineering response within 1 hour 24/7 for the pilot duration                                                                     | ☐      |
| Slack workspace ready with one channel template per pilot org (see §7)                                                                                                                 | ☐      |
| First pilot org admin's onboarding meeting scheduled                                                                                                                                   | ☐      |

If any of these are not green, the pilot start date slips. Slipping
the date is preferable to going live unprepared — every pilot org
is a customer relationship that's harder to recover than a missed
deadline.

---

## 1 — Pilot orgs

### Selection criteria

Three pilot orgs, drawn from one each of:

- **A mid-sized adult learning council** — typically 100-300
  learners across an ESOL provision. Likely to use ProSolution or
  Maytas as their MIS. Higher process maturity; closer to the
  Ofsted-conversation feedback we most need.
- **An FE college** — typically a larger cohort (300-800 learners
  enrolled in ESOL pathways). Uses EBS or Maytas. Will exercise
  the platform's scale assumptions more aggressively. Likely to
  have an in-house compliance officer who can stress-test the
  evidence-report PDF.
- **An ESOL charity** — typically smaller (50-150 learners), more
  agile, often without an MIS at all. Will stress-test the
  "import via CSV, no integration" pathway. Likely to give the
  most candid product feedback because the platform's value is
  more visible to them.

### Selection process

- Joey identifies candidates from his network and existing
  conversations.
- Pre-qualifying questions (Joey to ask before any commitment):
  - Do they have a designated org admin who can dedicate 2-3
    hours/week for the pilot duration?
  - Will they commit to using the platform for at least one
    cohort of new ESOL learners during the pilot (not a backfill
    of historic data)?
  - Are they willing to provide written feedback at the pilot
    retrospective (see §9)?
  - Do they have a Designated Safeguarding Lead who can respond
    to safeguarding alerts within 24 hours?
  - Are they willing to be named publicly in the pilot
    retrospective and a launch press release? (Soft preference,
    not a blocker — they can opt for anonymity.)
- Joey signs a brief **Pilot Engagement Letter** with each org
  before onboarding. Template lives at
  `docs/templates/PILOT_ENGAGEMENT_LETTER.md` (to be drafted
  by Joey before the first sign-up). Covers data
  processing, expected hours, mutual exit conditions.

### Identified pilot orgs

> Joey to fill in as each org commits.

| #   | Org name | Type | Pilot lead contact | Engagement letter signed | Pilot start | Pilot end |
| --- | -------- | ---- | ------------------ | ------------------------ | ----------- | --------- |
| 1   |          |      |                    |                          |             |           |
| 2   |          |      |                    |                          |             |           |
| 3   |          |      |                    |                          |             |           |

---

## 2 — Pilot duration

**4-6 weeks**, calibrated per org. The duration band leaves room
for two judgement calls:

- **4 weeks** for an org with experienced ESOL admins and a small
  cohort (20-30 learners). Enough time for every learner to have
  3+ AI sessions, for a Stage 5 review to fire, for the org admin
  to generate an evidence report at least twice.
- **6 weeks** for a larger college or an org where the admin is
  new to digital ESOL delivery. Adds a week of bedding-in plus a
  week to handle the inevitable mid-pilot "we have questions
  we didn't think to ask in week 1".

Joey picks 4-6 weeks per org based on the onboarding meeting and
documents the pick in the table above.

### Pilot calendar (per org)

Counting from the org's onboarding meeting (week 1):

| Week                       | Milestone                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| 0 (pre-pilot)              | Onboarding meeting; org admin uploads first CSV; first learners verified                 |
| 1                          | First AI sessions; first weekly check-in (see §5)                                        |
| 2                          | First evidence report generated by org admin (success metric — see §8)                   |
| 3                          | Mid-pilot retrospective check — engineering reviews Sentry + audit-log + dashboard usage |
| 4                          | First Stage 5 reviews fire (assuming learner progressions)                               |
| 5 (or 4 if a 4-week pilot) | Final week — ILR export trial, evidence-report walk-through                              |
| Final week                 | Pilot retrospective conversation (see §9), written report drafted                        |

Pilots overlap deliberately — onboarding org #2 begins in
week 2 of org #1, org #3 in week 4. Spreads engineering load and
gives later orgs the benefit of fixes from earlier orgs.

---

## 3 — Pilot scope

**20-50 learners per pilot org.**

The lower bound is enough to exercise the dashboard and evidence
report meaningfully. The upper bound is what an engineering team
of our size can support attentively across 3 simultaneous pilots
(60-150 learners total).

### What's in scope during the pilot

- All Function-1 through Function-17 features delivered.
- Learner onboarding via CSV import OR via the org-admin invite
  flow.
- The full RARPA Stage 1-5 lifecycle.
- The evidence-report PDF.
- The ILR export pipeline — **but** the pilot org **does NOT**
  submit the ILR export to ESFA in production. They generate it
  and review it as if they would. Real ESFA submission requires
  ESFA Test Submission protocol completion (see
  `docs/ESFA_TEST_SUBMISSION.md`) which is post-pilot.
- The MIS test-connection flow (Function 15 §7), where applicable.
  Adapters are stubbed today — clear with the org admin that the
  MIS push itself lands post-pilot in Phase 21.

### What's out of scope during the pilot

- **No MIS push to production** even if the adapter ships.
  Validate against the org's sandbox MIS where available.
- **No public ILR submission to ESFA.** The export is generated
  and reviewed; submission is post-pilot.
- **No new feature requests funnelled into the active sprint.**
  Feedback is captured in the pilot Slack and triaged into the
  retrospective; only blocking bugs hot-fix into the live
  deployment during the pilot.
- **No cross-org collaboration features.** Each pilot org is
  isolated. The Function 15 Amber-admin cross-org dashboards are
  used by Joey for monitoring only.

### Per-org learner registration

Org admins register learners via either:

1. **Bulk CSV import** (Function 3 / Phase 6.1) — recommended
   when migrating an existing cohort.
2. **Individual invite via the org-admin dashboard** —
   recommended when adding learners as they enrol.

Engineering pre-stages the org's `Organisation` document with
`max_learners: 50` so accidental over-imports are blocked at the
schema level.

---

## 4 — Onboarding meeting

**Format:** 1-hour video call (Joey + the pilot org admin + one
engineer). Recorded with the org admin's permission so the
recording can be re-shared with their colleagues.

### Agenda (60 min)

| Minutes | Topic                                                                                           | Owner    |
| ------- | ----------------------------------------------------------------------------------------------- | -------- |
| 0-5     | Welcome, introductions, expectations of the pilot                                               | Joey     |
| 5-15    | Platform overview — the dashboard, the RARPA cycle, how the AI tutor sessions work              | Joey     |
| 15-30   | Live walk-through: dashboard tour (cohort table, narrative summary, audit log, Stage 5 pending) | Joey     |
| 30-40   | Live walk-through: CSV import flow + the org admin's first import                               | Engineer |
| 40-50   | Live walk-through: generating the evidence report PDF                                           | Engineer |
| 50-55   | Safeguarding flow — how alerts surface, who's responsible (org admin's DSL)                     | Joey     |
| 55-60   | Q&A, next-week's check-in scheduled, Slack channel introduced                                   | Joey     |

### Written user guide

A 6-10 page PDF guide handed to the org admin at the meeting.
Sections:

1. **Logging in** — URL, credentials, password reset.
2. **The cohort dashboard** — what each tab shows.
3. **Adding learners** — CSV import + individual invite.
4. **The RARPA cycle, plainly** — what the platform does at each
   stage; what's automatic; what needs the org admin's input.
5. **The evidence report** — when to generate it, what's in it,
   how to share it with Ofsted / governors / funding bodies.
6. **Safeguarding** — what triggers an alert, who gets notified,
   how to mark resolved.
7. **Stage 5 review confirmation** — the org admin's role at
   sign-off.
8. **Getting help** — Slack channel, escalation path, SLA.

The guide lives in `docs/PILOT_USER_GUIDE.md` and is exported to
PDF before each onboarding meeting (so org admins get a dated copy
that reflects the platform state on the day they onboard).

### Post-meeting follow-ups (within 24 hours)

- Joey emails the org admin with:
  - Recording link.
  - Written guide PDF.
  - Slack channel invitation.
  - Calendar invites for the four weekly check-ins.
  - 1Password share for the pilot-org-specific account (NOT
    shared via email plain text).

---

## 5 — Weekly check-ins

**Cadence:** 30 minutes, same day/time each week, for the pilot
duration. Joey + the org admin. Engineering attends only by
exception (a specific question or a fresh bug).

### Standing agenda (30 min)

| Minutes | Topic                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0-5     | Quick health check — what worked this week, what didn't                                                                            |
| 5-15    | Review the platform's stats for the org: learners active, sessions completed, evidence-report generations, any safeguarding alerts |
| 15-25   | Specific feedback / questions from the org admin                                                                                   |
| 25-30   | Action items: what Joey will follow up on, what the org admin will try this week                                                   |

### Notes capture

Joey takes notes in the pilot Slack channel under a
`#weekly-notes` thread per week. Engineering reads these threads
but doesn't post unless asked.

### What gets escalated from a check-in

- Anything that looks like a platform bug → opened as an issue in
  the engineering GitHub repo within 24 hours, tagged
  `pilot-feedback`.
- Anything that looks like a content gap (a missing scenario, an
  awkward L1 translation) → tracked in
  `docs/CONTENT_AUTHORING.md`'s change log.
- Anything that looks like a feature request → captured but **not
  acted on during the pilot** (see §3 scope).

### Missed check-ins

If an org admin misses 2 consecutive check-ins, Joey calls or
emails directly. If they miss 3 in a row, the pilot is flagged for
mid-pilot review — the org may not be engaged enough for the
pilot to produce useful data, and may need to be paused or
graduated.

---

## 6 — Incident response

### Severity definitions

| Severity | Definition                                                                                                                    | Escalation                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **S1**   | Platform-wide outage; safeguarding alert pipeline broken; data loss; cross-org leak                                           | Joey + engineering on-call within **15 minutes** |
| **S2**   | One pilot org affected (cannot log in, cannot generate evidence report); safeguarding alert raised but not handled within SLA | Joey + on-call within **1 hour**                 |
| **S3**   | Bug affecting one feature; learner cannot complete a session; UI glitch                                                       | Slack channel, triage within **24 hours**        |
| **S4**   | Cosmetic, copy edits, polish                                                                                                  | Triage in the post-pilot retrospective           |

### Hard rules (brief verbatim)

> Any safeguarding alert, data loss, or platform downtime
> escalated to Joey within 1 hour.

This is the SLA the pilot orgs are told about. **Engineering
treats S1 + S2 + any safeguarding alert as 1-hour escalations
during the pilot.**

### Escalation tree

1. **Source** — Sentry alert, BetterUptime alert, pilot org Slack
   message, learner-reported issue, safeguarding alert in the
   admin console.
2. **First responder** — engineering on-call (rota in
   `docs/ON_CALL_ROTA.md`).
3. **S1 / S2 / safeguarding** — first responder pages Joey within
   the SLA window.
4. **Decision** — first responder + Joey decide:
   - Hot-fix into production (engineering fast-tracks PR + smoke).
   - Roll back per `PRODUCTION_DEPLOYMENT.md` rollback procedure.
   - Workaround communicated to the affected org.
5. **Communication** — Joey messages the affected pilot org's
   Slack channel within 1 hour of detection. Honest about what
   happened, what we're doing, when we'll have an update.
6. **Post-mortem** — written up in `docs/INCIDENTS/<date>.md`
   within 24 hours. Joey reviews. Lessons feed the pilot
   retrospective (see §9).

### Safeguarding incident response

A safeguarding alert is **always S1-equivalent for response
time** — Joey within 1 hour.

Critically:

- The platform's job is to _raise_ the alert. The org admin's
  Designated Safeguarding Lead is the responsible party for
  acting on it.
- Engineering's job during a safeguarding incident is to confirm
  the platform behaved correctly — the alert reached the right
  inbox, the audit trail is intact, no learner identifier leaked.
- Engineering does NOT make safeguarding judgement calls. If
  there's ambiguity ("did the alert fire correctly?"), Joey + the
  org's DSL decide; engineering provides the technical evidence.

A missed safeguarding alert (alert fired but didn't reach DSL,
OR the platform failed to detect a clear safeguarding trigger
that was reported by the org admin) is a **launch-blocker**: the
pilot pauses while the failure is investigated and fixed.

---

## 7 — Feedback channels

### Per-org Slack channel

For each pilot org, create a dedicated Slack channel:

- **Name:** `#pilot-<org-short-name>` (e.g. `#pilot-hillview`).
- **Members:**
  - Joey
  - The org admin (always)
  - Up to 2 additional people from the org (e.g. DSL, head of
    ESOL)
  - Engineering on-call (rotates)
- **Pinned messages:**
  - The platform URL + login instructions.
  - The user guide PDF.
  - The escalation tree from §6.
  - The next weekly check-in calendar link.

### Conventions

- **Bug reports:** any message starting with "Bug:" gets
  triaged within 24 hours by engineering. Slack-emoji reactions
  to indicate state: 👀 = seen, 🔍 = investigating, ✅ = fixed,
  📅 = scheduled for retrospective.
- **Questions:** any message ending with "?" — Joey responds
  within 4 working hours unless it's clearly engineering-only.
- **Safeguarding incidents:** **never** discussed in Slack. The
  org's DSL contacts Joey by phone or encrypted email; Joey
  contacts engineering via 1Password-shared note. Slack is not
  end-to-end-encrypted; learner identity must not appear there.

### Frequency expectations set with the org admin

- Joey acknowledges every Slack message within 4 working hours.
- Engineering responds to direct @-mentions within 1 working day.
- Out-of-hours (evenings, weekends, UK bank holidays), Slack is
  for non-urgent only. Urgent issues go through the escalation
  tree.

---

## 8 — Success metrics

The pilot succeeds — and unblocks the public-launch
conversation — when **all four** of the metrics below are met
**across all pilot orgs**.

### Metric 1: Learner engagement

**Target:** ≥ 90% of registered learners complete at least 3 AI
sessions during the pilot.

- **Measured by:** `db.aisessions.aggregate([{ $match: {orgId, completedAt: { $ne: null }}}, { $group: {_id: "$learnerId", n: { $sum: 1 }}}, { $match: { n: { $gte: 3 }}}])` against each pilot org.
- **Why this number:** under 3 sessions, the platform's value
  proposition hasn't been tested by the learner — the dashboard,
  vocab ledger, and any progression signal are all under-powered.
- **Owner of the metric:** Joey reports the per-org number at the
  retrospective. Engineering provides the query.

### Metric 2: Safeguarding integrity

**Target:** zero missed safeguarding incidents.

- **Measured by:** every safeguarding alert raised by the
  platform during the pilot is **reviewed by Joey + the org's
  DSL**; the DSL confirms the alert reached them within the SLA;
  ALSO, no safeguarding-relevant incident reported by an org
  admin out-of-band that the platform failed to detect.
- **Why this number:** safeguarding is non-negotiable. A single
  missed incident is a launch-blocker.
- **Owner of the metric:** Joey + each org's DSL co-sign the
  retrospective's safeguarding section.

### Metric 3: ILR export integrity

**Target:** zero ILR export failures (technical or compliance).

- **Measured by:**
  - **Technical:** zero failed jobs on the `ilr-export` BullMQ
    queue across the pilot. Verifiable via the failed-jobs
    dashboard.
  - **Compliance:** the ILR export the org admin generates for
    the last full month of the pilot passes manual review against
    the 2025/26 ESFA spec. Joey (or his compliance contact)
    signs off the rows.
- **Why this number:** the ILR export IS the funding pathway.
  An export that fails or produces invalid rows is the most
  expensive bug we can ship.
- **Owner of the metric:** Joey + compliance reviewer.

### Metric 4: Evidence report self-service

**Target:** every pilot org admin can generate an evidence-report
PDF unaided from the start of week 2 onwards.

- **Measured by:** at the week-2 check-in (and every check-in
  thereafter), the org admin generates the report live during
  the call without asking for help. Joey records the result on a
  binary "yes / no" basis.
- **Why this number:** evidence-report self-service is the headline
  org-admin value of the platform. If admins can't generate it
  unaided after a week of use, the UX has failed and the platform
  isn't ready for unsupported customers.
- **Owner of the metric:** Joey, per check-in.

### Composite scoring

| Metric                          | Per-org target      | Pilot-wide target           |
| ------------------------------- | ------------------- | --------------------------- |
| 1: ≥ 3 sessions per learner     | ≥ 90% of registered | Met by every pilot org      |
| 2: safeguarding integrity       | zero missed         | zero across the whole pilot |
| 3: ILR export integrity         | zero failures       | zero across the whole pilot |
| 4: evidence report self-service | yes from week 2     | yes for every org admin     |

Any "no" or "missed" on the right column = the public-launch
conversation does not open without a remediation plan in place.

---

## 9 — Pilot retrospective

### What gets written

A retrospective report, ~10-15 pages, with the following sections:

1. **Executive summary** — one page; what we did, how it went,
   the public-launch recommendation.
2. **Per-org summary** — one page per pilot org; named (or
   anonymised per their preference); the four success metrics
   with actual numbers; their qualitative feedback.
3. **What worked** — the platform behaviours that landed cleanly.
4. **What didn't work** — bugs found, UX confusions, content
   gaps, places the platform surprised the org admin in a bad
   way.
5. **Fixes shipped during the pilot** — list of every hot-fix
   PR with date, severity, what it fixed.
6. **Fixes deferred** — list of every bug or improvement
   surfaced but not shipped during the pilot. Each one has an
   engineering ticket reference and a decision rationale.
7. **Content gaps surfaced** — anything the pilot exposed about
   the scenarios, placement bank, safeguarding messages, or L1
   translations. Feeds back into `CONTENT_AUTHORING.md`.
8. **Safeguarding sign-off** — Joey + each org's DSL confirm
   zero missed incidents, and the alert pipeline behaved
   correctly for every alert raised.
9. **Compliance sign-off** — the ILR export for the final
   pilot month was reviewed and passed.
10. **Public-launch recommendation** — three options:

- **Go** — public launch within 4-8 weeks; here's the deferred-fix
  list that must be done first.
- **Go after a remediation cycle** — pilot demonstrated viability
  but a specific gap (e.g. one of the four metrics missed)
  needs a 2-4 week fix sprint before launch; named gap, named
  fix, named owner.
- **Don't go** — pilot demonstrated the platform isn't ready;
  specific blockers; estimated time to re-pilot.

### Who writes it

- Joey writes the executive summary, the per-org summaries, what
  worked, what didn't, content gaps, and the public-launch
  recommendation.
- Engineering writes the fixes-shipped + fixes-deferred sections.
- Joey + each DSL co-sign the safeguarding section.
- Joey + the compliance reviewer co-sign the compliance section.

### Who reads it

- The Amber Training senior team.
- Each pilot org receives a copy of their per-org page + the
  executive summary (NOT the other orgs' pages, unless they've
  agreed to mutual disclosure).
- The retrospective is the input to the public-launch decision
  meeting.

### Decision meeting

- Held within 2 weeks of the pilot end.
- Attendees: Joey, engineering lead, one external advisor (an
  ESOL practitioner or compliance contact, ideally one who
  reviewed the safeguarding sign-off).
- Output: a one-page **Launch Decision Note** — go / remediate /
  don't go, with named conditions for each option.
- Filed at `docs/LAUNCH_DECISION_<date>.md`.

---

## Cross-references

- `docs/PRODUCTION_DEPLOYMENT.md` — where the platform lives and
  how to roll back.
- `docs/PRODUCTION_SETUP_CHECKLIST.md` — the procedural runbook
  to stand up production.
- `docs/SECURITY_AUDIT.md` — the security posture as of pilot
  start.
- `docs/CONTENT_AUTHORING.md` — what content was signed off
  before pilot, what gaps surfaced during.
- `docs/DEMO_ENVIRONMENT.md` — the demo deployment Joey uses for
  pre-pilot onboarding meetings.
- `docs/ESFA_TEST_SUBMISSION.md` — the protocol that gates real
  ILR submission post-pilot.
- `docs/INCIDENTS/` — per-incident write-ups created during the
  pilot.
- `docs/ON_CALL_ROTA.md` — engineering on-call schedule for the
  pilot duration.
- `docs/PILOT_USER_GUIDE.md` — the org-admin-facing guide handed
  out at onboarding meetings.

---

## Sign-off — pilot start

The pilot starts when all the pre-pilot gates at the top of this
document are green, AND these signatures are in place.

| Role                                                                 | Date | Name | Signature |
| -------------------------------------------------------------------- | ---- | ---- | --------- |
| Engineering lead — confirms production is ready                      |      |      |           |
| Joey — confirms pilot orgs identified and onboarded                  |      |      |           |
| At least one ESOL practitioner — confirms content sign-offs reviewed |      |      |           |

---

## Sign-off — pilot end + public-launch decision

Captured in the separate `LAUNCH_DECISION_<date>.md` filed at the
end of the retrospective. Signatures required there:

- Joey
- Engineering lead
- The external advisor present at the decision meeting

**Public launch does not happen without that note signed and
filed.**
