# Pilot deployment cadence

> How pilot feedback turns into shipped code. Defines the three SLA
> tiers, the triage process that assigns them, the branch + deploy
> mechanics per tier, and the communication patterns back to the
> pilot org.
>
> Read alongside `PILOT_LAUNCH.md` (the pilot protocol itself) and
> `PRODUCTION_DEPLOYMENT.md` (the rollback procedures referenced
> here).

---

## TL;DR

| Severity | Definition | SLA | Branch | Comms |
|---|---|---|---|---|
| **P0** | Data loss, security gap, compliance failure, total feature blocker | **24 hours** to deploy fix | `hotfix/*` → `main` | Slack channel within 1 hour; weekly email noting the fix |
| **P1** | Functional bug blocking a workflow; significant UX confusion | **7 days** to deploy fix | `fix/*` → `develop` → `main` | Slack acknowledgement within 1 working day; weekly email |
| **P2** | Polish, copy, nice-to-have | Batched weekly | `chore/*` → `develop` → batched `main` release | Weekly email only |

Engineering on-call (`docs/ON_CALL_ROTA.md`) owns P0 from page to
deploy. Joey owns triage + the weekly email. The pilot org
deserves to hear back even on the smallest item — silence is the
failure mode this cadence exists to eliminate.

---

## Triage

### Cadence

- **Daily triage pass:** weekdays 09:30 UK. Joey + engineering
  on-call review the previous 24h of new `pilot-feedback`
  issues. Target: every new issue gets a severity label, a
  category label confirmed, and an owner within one triage pass.
- **Weekly batch triage:** Friday 14:00 UK. Joey + engineering
  lead review the full open `pilot-feedback` board. Reassess
  severities, close anything resolved, plan the upcoming weekly
  release.

### Who calls severity

- The reporter's severity is the starting point.
- Joey calls final severity for **content / UX / feature**
  categories.
- Engineering on-call calls final severity for **bug** and any
  potential **compliance** category, with Joey consulted within
  4 working hours for compliance.
- **Disagreements** escalate to the engineering lead within one
  working day. Disagreement on the safeguarding angle of any
  issue escalates immediately — not next-day.

### Labels we apply

Every triaged issue carries exactly:

- One severity: `P0`, `P1`, or `P2`.
- One category: `bug`, `ux`, `feature`, `content`, `compliance`.
- One owner: `assignee` set on the issue (an individual, not a
  team).
- The `pilot-feedback` label (auto-applied by the issue template).
- Optionally: `pilot-<org-short-name>` (e.g. `pilot-hillview`) so
  the weekly summary email per org can filter.

A `safeguarding-follow-up` label is applied when the reporter
flagged the safeguarding box on the issue template. The issue
itself does not contain safeguarding detail — the label exists
so triage can confirm the follow-up email reached Joey.

---

## P0 — 24-hour deploy

### What counts as P0

- **Data loss** — confirmed or strongly suspected.
- **Security gap** — anything exploitable, anything that lets
  cross-org data flow, anything that leaks credentials.
- **Compliance failure** — an ILR export producing demonstrably
  wrong rows; a safeguarding alert failing to reach the DSL; a
  RARPA evidence report missing required content.
- **Total feature blocker** — the entire dashboard cannot load
  for a pilot org; learners cannot log in; the AI tutor returns
  errors on every turn.
- **Safeguarding alert pipeline malfunction** — alerts not
  firing, mis-categorised, or reaching the wrong inbox.

### Process

1. **Detection** — Sentry, BetterUptime, or a `pilot-feedback`
   issue marked P0.
2. **Page** — engineering on-call paged within minutes (Sentry +
   BetterUptime auto-page; a GitHub issue triggers a webhook to
   the on-call Slack).
3. **Acknowledge** — on-call posts to the pilot Slack channel
   within **1 hour** of detection. Honest about what happened,
   what we're doing, when we'll have an update. Do NOT promise
   a fix ETA in the first message.
4. **Fix branch** — `hotfix/<issue-number>-<short-slug>` cut
   from `main`. Engineering treats this as the only work for
   the day.
5. **Code review** — at least one second engineer reviews. For
   any P0 touching auth, encryption, or external-facing routes,
   engineering lead reviews regardless of who else has.
6. **Verify on demo** — full smoke including the affected
   workflow, on `esol-demo.ambertraining.co.uk`.
7. **Deploy to prod** — `hotfix/*` merged to `main`. Vercel +
   Railway auto-deploy.
8. **Verify on prod** — same smoke against the production URL.
   Confirm Sentry error rate dropped if the trigger was an error
   spike.
9. **Update pilot Slack** — within 30 minutes of the prod deploy
   landing. Confirm the fix, name the issue number, invite a
   follow-up if the org admin sees a recurrence.
10. **Post-mortem** — written to `docs/INCIDENTS/<date>.md`
    within 24 hours of the deploy. Joey reviews. Pattern feeds
    the retrospective.

### Rollback

If the fix itself causes a regression, follow the rollback
procedure in `PRODUCTION_DEPLOYMENT.md` (Scenario A) — revert to
the last known-good Vercel deployment, restore the Railway
service, re-investigate. Do not chain hotfixes.

### Maximum allowed P0s

Two P0s open simultaneously triggers an escalation meeting with
Joey, engineering lead, and the external advisor named in
`PILOT_LAUNCH.md` §9. Three concurrent P0s **pauses the pilot** —
the platform is not stable enough to support pilot orgs and we
owe them the honesty of a pause.

---

## P1 — 7-day deploy

### What counts as P1

- **Functional bug** — a workflow that does the wrong thing but
  the org admin can work around it. Example: the cohort table
  filter for `level=e2` returns E2 + E3 learners.
- **Significant UX confusion** — multiple pilot org users have
  asked about the same flow. Example: the Stage 5 review
  confirmation button isn't discoverable until the AI summary
  banner is dismissed.
- **Performance regression** — the dashboard p95 has tripled
  since baseline (load test scenario 3) but the page still loads
  within the gate.
- **Wrong content** — a translated string that ESOL practitioner
  review flags as incorrect but not safeguarding-relevant.

### Process

1. **Acknowledge in Slack** — within **1 working day** of issue
   creation. Confirms triage, names a target deploy date.
2. **Fix branch** — `fix/<issue-number>-<short-slug>` cut from
   `develop`.
3. **PR + review** — standard review process. Engineering lead
   review when touching shared infra; one second reviewer
   otherwise.
4. **Land on `develop`** — merged via squash commit referencing
   the issue number.
5. **Deploy to staging** — `develop` auto-deploys to staging.
   Joey gets a Slack ping when staging is updated; verifies the
   fix.
6. **Land on `main`** — `develop` merged to `main` when the next
   weekly release ships, OR sooner if the P1 is age-7 and the
   weekly release is more than a day out.
7. **Verify on prod** — smoke against production URL.
8. **Mark fixed in Slack** — confirm in the pilot Slack channel
   the day the fix lands on prod.

### P1 escalation to P0

If a P1's age reaches **5 days** without a fix landing on
`develop`, engineering on-call escalates to engineering lead.
If it reaches **7 days** without a deploy, the issue is treated
as P0 for the remainder — 24-hour fix-and-deploy clock starts.

This rule exists so P1s don't quietly slip into "we'll get to it
next week" for three weeks in a row.

---

## P2 — weekly batched release

### What counts as P2

- Polish — animation timing, padding, button placement.
- Copy edits — typo on a button label, clearer caption text.
- Nice-to-have additions that don't block any workflow.
- Refactors triggered by pilot feedback but invisible to users.
- Frontend translation tweaks (ESOL-practitioner feedback that's
  not flagged as wrong, just better).

### Process

1. **Acknowledge in Slack** — same-week acknowledgement is
   enough. The weekly email summarises the batch.
2. **Fix branch** — `chore/<issue-number>-<short-slug>` cut from
   `develop`.
3. **PR + review** — standard.
4. **Batched merge to `develop`** — multiple P2 fixes land
   together. Engineering reviews the cumulative diff before
   promoting the batch.
5. **Weekly release window** — every **Wednesday 11:00 UK**,
   `develop` merges to `main`. Vercel + Railway auto-deploy.
6. **Verify on prod** — smoke including each fixed item.
7. **Summarise in the weekly email** — see the email template
   at `docs/templates/PILOT_WEEKLY_EMAIL_TEMPLATE.md`.

### Why Wednesday

- Not Monday — we've just come off the weekend, on-call coverage
  is thinner, and Friday-evening rollback availability is lowest
  by then.
- Not Friday — nobody wants to spend their weekend rolling back
  a Friday release.
- Wednesday 11:00 — mid-week, full UK working day ahead, two
  full working days of monitoring before the weekend.

---

## Branch hygiene

```
                       main  (production)
                        ▲
                        │  merge windows:
                        │   - P0: any time (hotfix)
                        │   - P1: when fix is ready
                        │   - P2: Wed 11:00 UK only
                        │
                     develop  (staging)
                        ▲
                        │
   ┌────────────────────┼────────────────────┐
   │                    │                     │
hotfix/*              fix/*                 chore/*
(P0 — cut             (P1)                  (P2)
 from main)
```

- **`main`** is always deployable. Vercel + Railway auto-deploy
  on every push.
- **`develop`** is the integration branch. Auto-deploys to
  staging.
- **`hotfix/*`** branches cut **from `main`**, not develop. The
  hotfix is then merged forward to `develop` immediately after
  landing on `main` to keep the branches in sync.
- **`fix/*`** and **`chore/*`** branches cut from `develop`.
- Branch names always carry the GitHub issue number:
  `hotfix/142-evidence-report-modal-stuck`. Makes the deploy log
  searchable by issue.

---

## Communication patterns

### Slack channel posts

Every shipped fix gets a Slack message in the pilot org's
channel. Template:

```
✅  Issue #<n> — <one-line>
This fix is now live on production (deployed at <time UK>).
The dashboard / report / flow you reported is back to expected.
If you see anything similar recur, reply to this message.
```

### Weekly email

Every Friday at 16:00 UK, Joey sends each pilot org a summary
email. The template is at
`docs/templates/PILOT_WEEKLY_EMAIL_TEMPLATE.md`. The email lists
what was filed, what was shipped, and what's in flight — even if
nothing changed for that org, the email goes out (silence is
the failure mode).

### Mid-pilot retrospective communication

At the week-3 mid-pilot retrospective check (see `PILOT_LAUNCH.md`
§2), engineering reads the cumulative pilot-feedback board and
prepares a one-page summary of:

- Total issues filed
- Breakdown by severity + category
- Median time-to-deploy per severity tier
- Outstanding open issues by severity
- Concerns about the trajectory

Joey reviews; concerns surface in the week-4 weekly email if
material.

---

## Metrics we track

These are the numbers the pilot retrospective (`PILOT_LAUNCH.md`
§9) leans on. Engineering runs the report; Joey reviews.

| Metric | Target |
|---|---|
| % of P0 issues deployed within 24h | 100% |
| % of P1 issues deployed within 7 days | ≥ 90% |
| Median triage time (issue created → labels applied) | < 4 working hours |
| % of weekly emails sent by 16:00 Friday | 100% |
| Number of P1 → P0 escalations triggered by age | tracked, no target — surfaces a triage-discipline problem |
| Number of pilot Slack acknowledgements within their tier's SLA | tracked, no target — surfaces a process-discipline problem |

---

## Failure modes this cadence is designed to prevent

1. **Silent slippage on P1s.** The P1 → P0 escalation rule at
   day 5 / day 7 is the forcing function.
2. **Pilot orgs feeling ignored.** Every issue gets a Slack
   acknowledgement; every week gets an email even when nothing
   shipped for that org.
3. **Weekend deploys.** Wednesday-only P2 release window keeps
   rollback availability high.
4. **Compounding P0 chaos.** Two concurrent P0s triggers an
   escalation meeting; three pauses the pilot.
5. **Safeguarding-relevant detail in public GitHub.** The
   issue template's confirmation checkbox + the `config.yml`
   contact link push safeguarding-relevant communication to the
   safeguarding inbox.
6. **"We'll bundle that into the next release."** P2 is the
   ONLY tier that gets batched. P0 + P1 are individually
   tracked and shipped.

---

## Sign-off

This cadence is the working agreement between engineering and
Joey for the pilot duration. Changes during the pilot are filed
as a `pilot-feedback` issue against this document and signed off
by both before taking effect.

| Role | Date | Name | Signature |
|---|---|---|---|
| Engineering lead | | | |
| Joey (Amber Training) | | | |
