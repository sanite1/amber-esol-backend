# Pilot weekly summary email — template

> Joey sends one of these every Friday at 16:00 UK to each pilot
> org admin for the duration of their pilot. The email goes out
> **every week without exception** — even a "nothing material
> shipped this week" email gets sent. Silence is the failure mode
> this email exists to prevent.
>
> The template below is the format. Replace anything in
> `<angle brackets>` before sending. Anything in *italics* is a
> note to Joey and should be removed.

---

## How to fill it in

1. Open the `pilot-feedback` board, filter by
   `pilot-<org-short-name>` label, sort by created date.
2. Identify everything in three buckets for the past 7 days:
   - **Shipped** — issues that moved to closed and landed on
     production this week.
   - **In flight** — issues open and being worked. Note severity
     and ETA.
   - **Filed but not yet triaged** — issues created in the last
     24-48 hours that triage hasn't reached yet.
3. Pull the engineering-side notes from the daily triage Slack
   thread for context on each.
4. Draft the email below.
5. Joey reviews, sends from `joey@ambertraining.co.uk`.
6. Archive the sent email + the underlying GitHub issue
   references in
   `docs/pilot-comms/<org-short-name>/<YYYY-MM-DD>.md`.

The dated archive is what the retrospective report (`PILOT_LAUNCH.md`
§9) reads from. Keep it tidy.

---

## Template

> **Subject:** Project Silk pilot — weekly update, week of `<DD Month>`
>
> **To:** `<org admin email>`
> **Cc:** *(optional: any other named contact at the org from the
> Engagement Letter)*
> **Bcc:** `engineering-pilot@ambertraining.co.uk` *(internal
> archive)*
>
> ---
>
> Hi `<First name>`,
>
> Quick weekly update from the Project Silk pilot. Week ending
> Friday `<DD Month YYYY>`.
>
> ## Headline
>
> *One or two sentences. Lead with the most useful thing — either
> "everything ran cleanly this week" or the most material change
> shipped. If a major fix landed, name it. If a P0 happened, name
> it honestly here — never bury it lower down.*
>
> e.g.
> - "All quiet from our side this week — the evidence-report
>   speed-up landed on Wednesday and the dashboard load times are
>   back below the 2 second target."
> - "We hit a brief outage on Tuesday morning (08:50–09:05 UK)
>   when a Vercel deploy caused login redirects to loop. Full
>   write-up below."
>
> ## Shipped this week
>
> *List every issue that closed AND landed on production this
> week. Group by who reported it. If your org reported nothing
> this week, the list might be empty for your section but other
> pilot orgs' fixes will still appear here when they affect the
> shared platform.*
>
> **From your team:**
> - Issue #`<n>` — `<one-line>`. Shipped `<day>`.
>   *Brief plain-English description of what the fix changes for
>   your day-to-day use.*
> - …
>
> **From other pilot orgs (these affect the shared platform too):**
> - Issue #`<n>` — `<one-line>`. Shipped `<day>`.
> - …
>
> **Internal improvements (no user-visible change):**
> - `<short bullet>` — *(only include items worth mentioning;
>   skip if nothing material)*
>
> ## In flight
>
> *Open issues that engineering is actively working on. Name them,
> name the severity, name the ETA.*
>
> - **P1 — Issue #`<n>`** — `<one-line>`. Reported `<day>`.
>   Target deploy: `<day>`. Engineering owner: `<name>`.
> - **P2 — Issue #`<n>`** — `<one-line>`. Will land in next
>   Wednesday's batch release.
>
> *If nothing's in flight for your org, say so explicitly: "No
> open issues from your team this week — everything reported has
> shipped."*
>
> ## What we'd like from you
>
> *Optional section. Use sparingly — at most once a fortnight.
> Examples:*
>
> - "Could `<name>` try the new Stage 5 confirmation flow before
>   next Tuesday's check-in? We want to confirm the override
>   dropdown reads as we intended."
> - "If you spot the dashboard ever taking more than 3 seconds to
>   load, drop a screenshot in our Slack channel — we're tracking
>   a possible regression."
>
> ## Reminders
>
> - **Next check-in:** `<day, date, time UK>` via `<video link>`.
> - **Slack channel:** `<#pilot-<org-short-name>>` — message Joey
>   anytime; engineering on-call covers @-mentions within 1
>   working day.
> - **Safeguarding incidents** are NEVER discussed in Slack.
>   Email `safeguarding@ambertraining.co.uk` or call Joey
>   directly.
>
> ## Pilot countdown
>
> Week `<N>` of `<4 / 5 / 6>`. `<N>` weeks to retrospective.
>
> *If this is the final-week email, the line reads "Final week —
> retrospective conversation scheduled for `<day>`."*
>
> ---
>
> Thanks for everything this week.
>
> Joey
> Amber Training Ltd
> `joey@ambertraining.co.uk` · `<phone>`

---

## Variations

### Final-week email (week 4, 5, or 6)

Replace the **Pilot countdown** section with:

> ## Pilot retrospective
>
> We've reached the end of the formal pilot period. Next steps:
>
> 1. **Retrospective conversation** — `<day, date, time UK>`.
>    60 minutes. Same video link as our weekly check-ins.
> 2. Before the call, I'll send you a draft of your per-org
>    summary for the retrospective report. We'd love your
>    review — corrections, additions, redactions.
> 3. After the call, the full retrospective lands within 2 weeks.
>    You'll get the executive summary + your per-org page; other
>    orgs' pages stay confidential unless you've agreed to mutual
>    disclosure.
> 4. The public-launch decision meeting is roughly 2 weeks after
>    the retrospective. Your feedback is the most direct input
>    into that decision.

### "P0 happened this week" email

If a P0 fired during the week, the email leads with it. Add a
section between **Headline** and **Shipped this week**:

> ## Incident this week
>
> **What happened:** `<plain-English description>`.
>
> **When:** `<day, time UK, duration>`.
>
> **Who was affected:** `<scope — one org, all pilot orgs,
> learners only, etc>`.
>
> **What we did:** `<fix + deploy>`. Live on production since
> `<day, time UK>`.
>
> **What we learned:** `<one or two sentences from the
> post-mortem>`. Full write-up at `<link to docs/INCIDENTS/…>`.
>
> **What we're changing:** `<concrete change to prevent
> recurrence>`. If still TBD, name when we'll have it.
>
> I'm sorry this affected you. If you have any concerns, please
> reply or call me directly.

The incident section is **always** above the "Shipped this week"
list. P0s are not buried.

### Slow week / nothing material shipped

The email STILL goes out. Format:

> ## Headline
>
> Quiet week on our side. No new fixes shipped to production for
> your org. Triage has been working through the P2 backlog;
> nothing from your team landed in this week's batch.
>
> ## In flight
>
> *(list open items as normal)*
>
> ## What we'd like from you
>
> If you're using the platform daily and have any "this is fine
> but it could be better" thoughts, this is a great week to share
> them — we have engineering capacity for the P2 batch next
> Wednesday.
>
> *(continue with reminders + countdown as normal)*

A "nothing shipped" email is itself useful — it confirms the
platform is stable and signals engineering capacity is available.

---

## Tone

- **Plain English.** No "P0" / "BullMQ" / "Sentry" in the email
  body. Refer to issues by number + plain-English summary.
- **Honest about timing.** If we said a P1 would ship Tuesday and
  it slipped to Thursday, name the slippage in the email and
  explain briefly.
- **Specific over vague.** "We sped up the dashboard from 1.8s
  to 1.1s" beats "we improved performance".
- **First-person plural from Amber's side.** "We shipped" /
  "we're working on" — never "the engineering team has decided".
  Joey speaks for Amber.
- **Acknowledgement before action.** When the org admin has
  reported something, name them: "Thanks to Sarah for catching
  the missing column on the funding report."

---

## Cadence

- **Sent every Friday by 16:00 UK** for the duration of each
  pilot.
- **Archived** to `docs/pilot-comms/<org-short-name>/<YYYY-MM-DD>.md`
  on the day of sending.
- **100% send rate** is a tracked metric (see
  `PILOT_DEPLOYMENT_CADENCE.md` § Metrics). Missing a week is
  the failure mode this email exists to prevent — if it ever
  happens, the next week's email opens with an apology and
  doubled-up content.

---

## Cross-references

- `docs/PILOT_LAUNCH.md` — the pilot protocol the email lives
  inside.
- `docs/PILOT_DEPLOYMENT_CADENCE.md` — the SLA tiers and triage
  process the email reports against.
- `.github/ISSUE_TEMPLATE/pilot-feedback.yml` — the input format
  the issues take.
- `docs/INCIDENTS/` — post-mortem write-ups linked from
  incident-week emails.
- `docs/pilot-comms/<org-short-name>/` — the archive of sent
  emails per org. The retrospective reads from here.
