# Demo Environment

Project Silk runs a dedicated demo deployment so prospects, auditors,
and new starters can poke at the platform without touching live
organisation data. This document is the canonical operator's guide
for that environment.

---

## Access

**URL:** <https://esol-demo.ambertraining.co.uk>

Three pre-seeded accounts are available. **Credentials are in 1Password
only — never committed to the repo, never pasted into Slack, never
shared by email.**

| Role | 1Password entry | Lands on |
|---|---|---|
| Org admin (Sarah Chen) | `Project Silk Demo - Org Admin` | `/org-admin/dashboard` |
| Amber admin (platform super-admin) | `Project Silk Demo - Amber Admin` | `/admin/overview` |
| Learner | `Project Silk Demo - Learner` | `/esol/home` |

If a credential is missing or rotated, the only authoritative
recovery path is the 1Password vault. There is no "reset password via
email" flow because the demo deployment doesn't send real emails (see
Demo-safe actions below).

---

## What's been seeded

Every reset cycle (see Daily reset below) lays down the **Hillview
Adult Learning** fixture — a fictional council-led ESOL provider:

- **1 organisation** — Hillview Adult Learning (`type: council`,
  `is_demo: true`). Contract dates rolling so they're always current.
  SaaS fee £15/head/mo, ESOL session rate £25/hr.
- **1 org admin** — Sarah Chen (`sarah@hillview-demo.example`).
- **2–3 ESOL teachers** at varied utilisation — one near capacity,
  one mid-load, one lightly assigned. Each `esolTeacherApproved: true`.
- **30 fictional learners** with realistic British and international
  names. Distribution:
  - **Levels:** 8 × E1, 7 × E2, 8 × E3, 5 × L1, 2 × L2.
  - **L1 languages:** 10 Arabic, 6 Somali, 5 Dari, 5 English, 4 Cantonese.
  - **Postcodes:** valid UK addresses spread across several Mayoral
    Combined Authorities so the ASF postcode router has interesting
    cases to demo.
- **300–500 AISession records** across the cohort over the last
  90 days, varied durations and outcomes. Vocab retention rates per
  learner are realistic (not 0% or 100% — the dashboards are
  meaningful).
- **5–10 SafeguardingAlert rows** across several categories, some
  resolved, some not. Demonstrates the safeguarding overview without
  inventing real disclosures.
- **8–10 LevelChange records** showing confirmed RARPA progressions.
- **50–80 TeacherReview records** across all four review types
  (`async_review`, `contact_session`, `pathway_adjustment`,
  `rarpa_signoff`) so the teacher-utilisation dashboard has data.
- **AuditLog entries** with realistic timestamps and plain-English
  reasons covering every above event, so the org-admin Audit Log tab
  isn't empty.

Every record carries `is_demo: true` on the parent organisation —
this is the flag the production guards check. The seed script is
versioned at [`src/scripts/seedDemoEnvironment.ts`](../src/scripts/seedDemoEnvironment.ts).

---

## Daily reset

A Vercel cron job hits `/api/cron/reset-demo-environment` every day
at **03:00 UTC**. The handler:

1. Verifies `DEMO_MODE=true` on the running process. **Refuses with
   403 otherwise.** This guard sits *before* the cron-secret check so
   even a misconfigured production deployment with a valid
   `CRON_SECRET` can't trigger it.
2. Drops every non-system collection on the demo Mongo cluster
   (`DEMO_MONGODB_URI`, isolated from production).
3. Re-runs the Hillview seed script.
4. Emails Joey (via `JOEY_EMAIL`) with the outcome — success or
   failure, including which collections were dropped and which
   counts were seeded.

The cron config lives in [`vercel.json`](../vercel.json):

```json
{
  "path": "/api/cron/reset-demo-environment",
  "schedule": "0 3 * * *"
}
```

### Manual reset

If a demo prep needs a fresh fixture mid-day (e.g. an over-eager
prospect has already explored everything), trigger the reset with:

```bash
curl -X GET https://esol-demo.ambertraining.co.uk/api/cron/reset-demo-environment \
  -H "Authorization: Bearer $CRON_SECRET"
```

The same DEMO_MODE guard fires — the manual call gets the same
defence as the scheduled one. The outcome email lands in Joey's
inbox a few seconds later.

### Recovering from a stuck reset

If the cron emails "FAILED" for two consecutive days, investigate:

1. Vercel cron logs → look for the 5xx response on
   `/api/cron/reset-demo-environment`.
2. Mongo Atlas → confirm the demo cluster is reachable and not
   over-quota.
3. Re-run the seed locally against the demo cluster:
   `DEMO_MODE=true DEMO_MONGODB_URI=… npm run seed:demo`.

The reset is idempotent: dropping an already-dropped collection is a
no-op (NamespaceNotFound errors are swallowed), and the seed runs
against an empty database without any pre-existing-data checks.

---

## Demo-safe actions — what is blocked

Five layers of defence stop demo activity from spilling into the real
world. Each is independent; the failure of any one still leaves the
others in place.

### 1. Database isolation

`DEMO_MONGODB_URI` points at a separate cluster. The demo deployment
literally cannot read or write production data — the credentials
don't grant access. `src/config/db.ts` throws at module load if
`DEMO_MODE=true` is set without `DEMO_MONGODB_URI`, refusing to fall
back to `MONGODB_URI`.

### 2. Export ILR is blocked

`src/services/ilrExport.service.ts → buildIlrRows` refuses any export
where `Organisation.is_demo === true`:

```
403 — ILR export is disabled for demo organisations.
Demo data must never be submitted to ESFA.
```

The frontend additionally hides the **Export ILR** button entirely
when the `X-Demo-Mode: true` header is present, so the affordance
isn't even surfaced.

### 3. MIS push is blocked

The MIS settings panel (`/admin/orgs/:id` → MIS connection) is
hidden in the admin UI when in demo mode. The backend MIS adapter
stubs (ProSolution / Maytas / EBS) only validate URLs locally; they
don't actually open a network connection in any environment until
Phase 21 wires real adapters. **By design, real adapters will check
`Organisation.is_demo` and refuse before opening the socket** —
mirroring the ILR guard.

### 4. Real emails are blocked

Every outbound email subject is prefixed with `[DEMO]` when
`DEMO_MODE=true`. The wrap is centralised in
`src/services/nodemailer/nodemailer.ts` via a `transporter.sendMail`
monkey-patch — no caller can bypass it. Anyone CC'd on a demo email
sees `[DEMO]` in the subject line immediately and knows the contents
are fictional.

The demo deployment uses the same SMTP credentials as production by
default. If you need a hard email cutoff (e.g. for a prospect demo
where any email-leak is unacceptable), set `AUTH_EMAIL=""` on the
demo Vercel project — nodemailer will then fail-closed on every
send. A future improvement is to route demo emails to a
catch-all mailbox; tracked under operational backlog.

### 5. Banner on every page

The frontend renders a persistent amber banner reading **"You are
viewing demo data. Changes do not persist to a real organisation."**
The banner is driven by the `X-Demo-Mode` response header — the
backend stamps it on every response, the frontend axios interceptor
captures it, and a `useIsDemoMode()` hook subscribes via
`useSyncExternalStore`. There is no way to dismiss it; reload
refreshes the flag from the next response.

---

## Adding custom demo content for a specific prospect

The default Hillview fixture covers the common pitches — RARPA
evidence, ILR mapping warnings, teacher utilisation, safeguarding
overview. For a prospect with specific needs (e.g. an FE college that
wants to see how an ESOL-only cohort renders, or a council with a
particular MCA postcode range) you have three options, in increasing
order of effort:

### Option A — Add a learner via the org-admin UI

Log in as Sarah Chen and use the **Import CSV** flow on the org-admin
dashboard. Upload a small CSV of fictional learners; they'll persist
until the next 03:00 UTC reset. Cheap and reversible; no code change.

### Option B — Extend the seed for a prospect-specific fixture

Edit `src/scripts/seedDemoEnvironment.ts` (see Todo 17.1 for the
shape) and add a second organisation block — e.g. a `Greenfield FE
College` with `type: college`, its own cohort, its own teachers. The
seed script supports multiple organisations as a flat array; the
daily reset will lay them all down.

When the prospect's pitch window has passed, revert the change — the
demo defaults back to Hillview alone.

### Option C — One-shot fixture deploy

For a fixture you don't want surviving the daily reset (e.g. a
sensitive prospect scenario you'd rather not have in git history),
deploy a one-off script that connects to `DEMO_MONGODB_URI` and
inserts your records directly. The 03:00 UTC reset will wipe it
overnight, so this is "good for one day's pitch and gone".

**Never** deploy a fixture script that connects to anything other
than `DEMO_MONGODB_URI`. The seed script checks `IS_DEMO_MODE` and
throws if the env isn't set — keep that guard in any custom script
you write.

---

## Environment variables

| Variable | Value on demo Vercel | Notes |
|---|---|---|
| `DEMO_MODE` | `true` | Flips the entire demo wiring on. Restart-required to change. |
| `DEMO_MONGODB_URI` | (1Password: *Project Silk Demo - Mongo URI*) | Separate cluster — never share credentials with production. |
| `MONGODB_URI` | (intentionally unset) | If set, completely ignored when `DEMO_MODE=true`. Leave it unset to make the configuration truthful. |
| `CRON_SECRET` | (1Password) | Same value as production by convention, but the demo-mode guard means a leak doesn't grant prod access. |
| `JOEY_EMAIL` | `joey@ambertraining.co.uk` | Recipient of the daily-reset outcome email. |
| `BULL_BOARD_TOKEN` | (1Password) | Bull Board access on the demo deployment is gated identically to prod. |
| `MIS_CREDENTIALS_KEY` | (1Password) | Any MIS credentials saved on a demo org would be encrypted with this key. The MIS UI is hidden in demo mode, so in practice no credentials are ever stored. |

The full set of env vars (including prod-only ones not listed here)
lives in the 1Password vault `Project Silk - Vercel Env` with one
entry per Vercel project.

---

## Troubleshooting

### "I logged in but I don't see the demo banner"

The banner is driven by the `X-Demo-Mode` response header. Check:

1. The deployment really has `DEMO_MODE=true` set (Vercel project →
   Settings → Environment Variables).
2. The browser DevTools Network tab shows `X-Demo-Mode: true` on a
   recent response (e.g. `/me`).
3. The CORS config exposes the header — `exposedHeaders:
   ["X-Demo-Mode"]` in `src/index.ts`. A missing entry means the
   browser strips the header before fetch/axios can read it.

### "The seed ran but the dashboard is empty"

Vercel serverless functions and the workers run as separate
processes. Mongo writes from the seed are visible to the API
immediately, but BullMQ-driven computed fields (vocab retention,
teacher GLH totals) only populate when workers process the seeded
session records. Hit `/admin/queues/summary` and confirm the
relevant queues drained — if there's a backlog, the workers may have
restarted mid-seed.

### "The reset emailed FAILED but nothing's actually broken"

The seed script returns `ok: false` until Todo 17.1 lands the real
Hillview fixture. Until then, the cron correctly reports that drops
happened but no seed was loaded. The "failure" is expected; the
fixture lands with Todo 17.1.

### "The Export ILR button is still showing in demo"

The conditional render lives in
[`src/modules/esol/pages/orgAdmin/Dashboard.tsx`](../../amber-esol-mvp/src/modules/esol/pages/orgAdmin/Dashboard.tsx)
and reads `useIsDemoMode()`. If the hook returns false (i.e. the
header didn't arrive), the button renders. Re-check the Network tab
for `X-Demo-Mode: true` — same diagnosis as the missing-banner case
above.

---

## Reference

- Code: backend `src/config/demoMode.ts`, `src/middlewares/demoMode.ts`,
  `src/services/demoReset.service.ts`, `src/scripts/seedDemoEnvironment.ts`
- Code: frontend `src/lib/demoMode.ts`, `src/components/DemoBanner.tsx`
- Cron: `vercel.json` → `/api/cron/reset-demo-environment` @ `0 3 * * *`
- Brief: Function 16 (demo-mode toggle, seed, daily reset)
- Related: Function 13 ILR demo guard, Function 15 §7 MIS settings
