# Production deployment — reference

> Live reference for the Project Silk production deployment. URLs,
> credentials index, where every moving part lives, how to roll
> back when things go sideways.
>
> **This document is not the setup runbook** — that's
> `PRODUCTION_SETUP_CHECKLIST.md`. This document is what you read
> when something's running and you need to find or fix it.
>
> Last updated: 2026-06-03 (initial draft, pre-pilot).

---

## At a glance

| Surface              | URL                                            |
|----------------------|------------------------------------------------|
| Frontend (prod)      | <https://esol.ambertraining.co.uk>             |
| Backend API (prod)   | <https://api.esol.ambertraining.co.uk>         |
| Frontend (demo)      | <https://esol-demo.ambertraining.co.uk>        |
| Backend API (demo)   | <https://api-demo.ambertraining.co.uk>         |
| Bull Board (prod)    | <https://api.esol.ambertraining.co.uk/admin/queues> |
| Health check (prod)  | <https://api.esol.ambertraining.co.uk/api/health> |
| Status page          | <https://status.ambertraining.co.uk> (BetterUptime) |
| Sentry (backend prod)| <https://sentry.io/organizations/amber/projects/amber-esol-backend/> |
| Sentry (frontend prod)| <https://sentry.io/organizations/amber/projects/amber-esol-mvp/> |
| Better Stack logs    | <https://logs.betterstack.com/sources/<source-id>> |

---

## Architecture map

```
                              ┌──────────────────────┐
   esol.ambertraining.co.uk ──▶  Vercel: frontend     │ (CRA build)
                              │  amber-esol-mvp       │
                              └──────────┬───────────┘
                                         │ HTTPS (CORS allowlist)
                                         ▼
                       ┌─────────────────────────────────────┐
   api.esol.ambertraining.co.uk ────▶  Vercel: backend serverless │
                       │      amber-esol-backend             │
                       │      (Express on @vercel/node)      │
                       └────┬───────────────────────┬────────┘
                            │                       │
                ┌───────────▼─────────┐   ┌─────────▼─────────┐
                │  MongoDB Atlas       │   │  Upstash Redis     │
                │  (prod cluster,       │   │  (prod instance)   │
                │   europe-west2)       │   │                    │
                └───────────▲──────────┘   └─────────▲─────────┘
                            │                       │
                            │                       │
                       ┌────┴───────────────────────┴────────┐
                       │  Railway: workers                    │
                       │  amber-esol-backend repo,            │
                       │  start: node dist/workers/run.js     │
                       │  (1 replica, BullMQ worker fleet)    │
                       └──────────────────────────────────────┘

                       Vertex AI (Gemini 2.5 Flash, europe-west2)
                       Stripe (live keys; webhook back to Vercel)
                       privateemail.com SMTP (outbound mail)
                       Cloudinary (org logo + asset upload)
                       Logtail / Better Stack (log aggregation)
                       Sentry (error tracking, two projects)
                       BetterUptime (uptime + status page)
```

### Why workers run on Railway, not Vercel

Vercel serverless functions cap at 60 s — BullMQ workers need
long-running Node processes. Railway runs them as a persistent
service. The backend `amber-esol-backend` repo serves both
surfaces: Vercel runs `src/index.ts` via `@vercel/node`, Railway
runs `src/workers/run.ts` via `node dist/workers/run.js`. **The
same repo, the same build, two different process entry points.**

---

## Production URLs

### Custom domains

| Domain                              | Points to                | TLS |
|-------------------------------------|--------------------------|-----|
| `esol.ambertraining.co.uk`          | Vercel frontend (prod)   | Let's Encrypt (Vercel auto) |
| `api.esol.ambertraining.co.uk`      | Vercel backend (prod)    | Let's Encrypt (Vercel auto) |
| `esol-demo.ambertraining.co.uk`     | Vercel frontend (demo)   | Let's Encrypt (Vercel auto) |
| `api-demo.ambertraining.co.uk`      | Vercel backend (demo)    | Let's Encrypt (Vercel auto) |
| `status.ambertraining.co.uk`        | BetterUptime status page | BetterUptime managed |

### DNS provider

DNS lives at **<DNS provider name>** under the
`ambertraining.co.uk` zone. Edit access in 1Password:
**`Project Silk Ops — DNS access`**.

### Vercel project names

- `amber-esol-backend` — production backend
- `amber-esol-backend-demo` — demo backend
- `amber-esol-mvp` — production frontend
- `amber-esol-mvp-demo` — demo frontend

### Other services

| Service                         | Resource name / handle                       |
|---------------------------------|----------------------------------------------|
| MongoDB Atlas project           | `amber-prod` (cluster: `silk-prod-cluster`) |
| MongoDB Atlas project (demo)    | `amber-demo` (cluster: `silk-demo-cluster`) |
| Upstash Redis (prod)            | `silk-prod-redis` (eu-west-2)               |
| Upstash Redis (demo)            | `silk-demo-redis` (eu-west-2)               |
| Railway project                 | `amber-esol-workers`                        |
| Sentry organisation             | `amber`                                     |
| Better Stack workspace          | `amber-training`                            |
| BetterUptime account            | `amber-training` (via Better Stack SSO)     |
| Vertex AI / GCP project         | `amber-esol-prod` (region `europe-west2`)   |
| Stripe account                  | Amber Training Ltd (live keys live in 1Password) |

---

## Credentials — where to find them

**Every credential lives in 1Password.** The repo, the env files,
and this document only reference vault entries by name — never
include the value.

| Category                 | 1Password vault entry                          |
|--------------------------|------------------------------------------------|
| Mongo URI (prod)         | `Mongo — Prod URI`                             |
| Mongo URI (demo)         | `Mongo — Demo URI`                             |
| Redis URL (prod)         | `Upstash — Prod URL`                           |
| Redis URL (demo)         | `Upstash — Demo URL`                           |
| `JWT_SECRET`             | `JWT_SECRET — Prod`                            |
| `REFERRAL_JWT_SECRET`    | `REFERRAL_JWT_SECRET — Prod`                   |
| `MIS_CREDENTIALS_KEY`    | `MIS_CREDENTIALS_KEY — Prod`                   |
| `CRON_SECRET`            | `CRON_SECRET — Prod`                           |
| `INVOICE_CRON_SECRET`    | `INVOICE_CRON_SECRET — Prod`                   |
| `BULL_BOARD_TOKEN`       | `BULL_BOARD_TOKEN — Prod`                      |
| Stripe live keys         | `Stripe — Live secret + webhook`               |
| privateemail.com SMTP    | `privateemail.com — Auth user + pass`          |
| GCP service account JSON | `GCP — Service account (amber-esol-prod)`      |
| Cloudinary               | `Cloudinary — API credentials`                 |
| Daily.co                 | `Daily.co — API key`                           |
| Zoom                     | `Zoom — Account + client credentials`          |
| Sentry DSN (backend)     | `Sentry — amber-esol-backend DSN`              |
| Sentry DSN (frontend)    | `Sentry — amber-esol-mvp DSN`                  |
| Better Stack token       | `Better Stack — Logtail source token`          |
| Vercel deploy access     | `Vercel — Amber Training org owners`           |
| Railway deploy access    | `Railway — Project admin`                      |
| Mongo Atlas access       | `Mongo Atlas — Amber project admin`            |
| Upstash access           | `Upstash — Account login`                      |
| Demo logins (Sarah Chen) | `Project Silk Demo — Org Admin`                |
| Demo logins (Amber admin)| `Project Silk Demo — Amber Admin`              |
| Demo logins (Learner)    | `Project Silk Demo — Learner`                  |

### Rotating a credential

The full per-secret rotation runbook lives in `docs/SECRET_ROTATION.md`
(written as part of `SECURITY_AUDIT.md` item 4 remediation). The
short version:

1. Generate a new value (commands documented per-secret in that
   runbook).
2. Update the 1Password vault entry — keep the old value as a
   secondary password until step 6.
3. Update **every** consumer Vercel project + Railway service env
   var.
4. Trigger a redeploy of every consumer.
5. Verify the consumers come up green (health checks pass).
6. After 1 week of stable operation, delete the old value from
   1Password.

Critical: `MIS_CREDENTIALS_KEY` rotation invalidates every stored
MIS credential. Rotation requires every org admin to re-enter
their MIS API credentials via the Function 15 §7 settings panel.
Schedule this and email org admins in advance.

---

## Environment variable matrix

Which projects need which vars. The full list lives in
`.env.example`; this matrix shows scope.

| Variable                          | Vercel backend (prod) | Railway workers | Vercel backend (demo) | Vercel frontend (prod) |
|-----------------------------------|:---:|:---:|:---:|:---:|
| `NODE_ENV=production`             | ✅ | ✅ | ✅ | ✅ |
| `MONGODB_URI`                     | ✅ | ✅ |  ❌ — leave unset | — |
| `DEMO_MODE=true`                  | ❌ | ❌ | ✅ | — |
| `DEMO_MONGODB_URI`                | ❌ — leave unset | — | ✅ | — |
| `REDIS_URL`                       | ✅ | ✅ | ✅ | — |
| `JWT_SECRET`                      | ✅ | ✅ | ✅ | — |
| `REFERRAL_JWT_SECRET`             | ✅ | ✅ | ✅ | — |
| `MIS_CREDENTIALS_KEY`             | ✅ | ✅ | ✅ | — |
| `CRON_SECRET`                     | ✅ | ❌ | ✅ | — |
| `INVOICE_CRON_SECRET`             | ✅ | ❌ | ❌ | — |
| `BULL_BOARD_TOKEN`                | ✅ | ❌ | ✅ | — |
| `STRIPE_SECRET_KEY` (`sk_live_…`) | ✅ | ❌ | ❌ — Stripe test keys only | — |
| `STRIPE_WEBHOOK_SECRET`           | ✅ | ❌ | ❌ | — |
| `AUTH_EMAIL`, `AUTH_PASS`         | ✅ | ✅ | ✅ — `[DEMO]` prefix wraps subject | — |
| `GOOGLE_APPLICATION_CREDENTIALS` (JSON literal) | ✅ | ✅ | ✅ | — |
| `GOOGLE_CLOUD_PROJECT_ID`         | ✅ | ✅ | ✅ | — |
| `GEMINI_MODEL=gemini-2.5-flash`   | ✅ | ✅ | ✅ | — |
| `CLOUDINARY_*`                    | ✅ | ❌ | ✅ | — |
| `DAILY_API_KEY`                   | ✅ | ❌ | ✅ | — |
| `ZOOM_*`                          | ✅ | ❌ | ✅ | — |
| `ACADEMIC_YEAR`                   | ✅ | ✅ | ✅ | — |
| `AMBER_UKPRN`                     | ✅ | ✅ | — | — |
| `DOMAIN_NAME`                     | ✅ | ❌ | ✅ | — |
| `LARGE_DATASET_TIMEOUT`           | ✅ | ✅ | ✅ | — |
| `LOG_LEVEL=info`                  | ✅ | ✅ | ✅ | — |
| `LOGTAIL_SOURCE_TOKEN`            | ✅ | ✅ | ✅ — separate source | — |
| `SENTRY_DSN`                      | ✅ | ✅ | ❌ — separate DSN | — |
| `JOEY_EMAIL`                      | — | — | ✅ (demo reset outcome) | — |
| `REACT_APP_BACKEND_URL`           | — | — | — | ✅ |
| `REACT_APP_SENTRY_DSN`            | — | — | — | ✅ |
| `REACT_APP_ENVIRONMENT=production`| — | — | — | ✅ |

---

## Deployments

### How a deploy happens

- **Backend (Vercel):** push to `main` → Vercel auto-builds + auto-
  deploys. Build runs `npm ci && npm run build`. Serverless
  functions are baked from `src/index.ts` per `vercel.json`.
- **Backend workers (Railway):** push to `main` → Railway watches
  the repo, rebuilds (`npm ci && npm run build`), restarts the
  service with `node dist/workers/run.js`.
- **Frontend (Vercel):** push to `main` → Vercel auto-builds (CRA)
  + auto-deploys.
- **Preview deploys:** every PR opens a preview URL on its own
  subdomain. PR previews **point at the same backend/workers as
  the staging environment** (not production). To avoid pollution,
  the PR preview's `REACT_APP_BACKEND_URL` is set via Vercel's
  Preview-scope env vars to `https://api-staging.ambertraining.co.uk`.

### Build verification

Every deploy must succeed at all three of:

- `tsc --noEmit` (in-build via `npm run build`)
- `npm test` (CI step, not Vercel's build — run in GitHub Actions
  before the deploy is allowed)
- Health probe (BetterUptime within 60 s of deploy completing)

A failure on any of these triggers an alert to Joey and the on-call
engineer; no automatic rollback.

---

## Rollback procedure

Two scenarios. Use the right one.

### Scenario A — Bad deploy (the new version is broken)

**Symptoms:** health check failing, errors spiking in Sentry,
users reporting an immediate regression.

#### Backend (Vercel) — instant rollback

1. Vercel dashboard → backend project → **Deployments** tab.
2. Find the last known-good deployment (green, dated before the
   bad push).
3. Click `…` → **Promote to Production**.
4. Vercel re-points the domain instantly (no rebuild).
5. **Verify within 60 s:** health check green, Sentry error rate
   drops.
6. Open an incident in `docs/INCIDENTS/<date>.md` capturing what
   broke + commit SHA of the bad deploy.

ETA: 30 s.

#### Backend workers (Railway) — instant rollback

1. Railway dashboard → workers service → **Deployments**.
2. Find the last known-good deployment.
3. Click **Restore**. Railway re-deploys that commit's build
   artefact (cached).

ETA: 1–2 min (worker container restart).

#### Frontend (Vercel) — instant rollback

Same procedure as backend Vercel. CRA bundles are static; rollback
just re-points the domain at the previous build.

ETA: 30 s.

#### Database

**Mongo and Redis are not rolled back as part of this procedure.**
If the bad deploy wrote bad data, you fix the data forward (a
follow-up script). The append-only audit log makes "what changed"
discoverable.

### Scenario B — Bad data (deploy is fine; an org admin or admin
took a destructive action)

There is no "undo" UI today. Recovery:

1. Identify the destructive action via `AuditLog` query (the row
   captures `before_state`).
2. Write a one-off Mongo script that restores `before_state` for
   the affected document.
3. Test against the demo cluster first.
4. Run against prod under engineering supervision.
5. Append a new AuditLog row capturing the restoration with
   `action: "manual_data_restoration"` (this action doesn't exist
   yet in the enum — add it as part of the restoration PR).

### Total outage — Vercel down

Both surfaces share one Vercel — if Vercel is down for the
ambertraining.co.uk region, both go down. Mitigation:

- Have a static maintenance page hosted on Cloudflare Pages or
  similar, pointable via a DNS swap.
- Status page (BetterUptime) is hosted off-Vercel — it'll keep
  working and show the outage.

ETA to swap to maintenance page: 5–15 min (DNS propagation).

This is a low-probability scenario; out-of-region redundancy is
post-MVP.

---

## Routine operations

### Daily

- 03:00 UTC: demo-env reset cron fires. Joey gets an email; if
  it's failed for two consecutive days, see
  `docs/DEMO_ENVIRONMENT.md`.
- 06:00 UTC: progression check + priority-queue scoring crons fire.
  Errors land in Sentry.
- 00:00 UTC: lesson completion cron fires.

### Monthly

- 1st @ 08:00 UTC: FALA whitelist refresh.
- 1st @ 09:00 UTC: invoice generation.
- Org admins generate ILR exports for the prior month — typically
  the first week.

### Annually

- 1 August: postcode-refresh-alert cron emails Joey to download
  the new DfE ASF dataset. **Manual step** —
  `POST /api/admin/cache/postcode/reload` once the file is
  verified.
- 1 August: new academic year. Activate next year's compliance
  config via the Final Addendum §3 admin editor.
- Annual secret rotation per `docs/SECRET_ROTATION.md`.

---

## Incident response

When something breaks in production:

1. **First 5 min:**
   - Confirm via BetterUptime that the problem is real (not just
     your laptop).
   - Check Sentry for the error rate spike.
   - Decide: rollback or fix-forward.
2. **First 30 min:**
   - If rollback chosen, execute per the procedure above.
   - If fix-forward, push the fix to `develop` first, verify on
     preview, then promote to `main`.
   - Open an incident note in `docs/INCIDENTS/<date>.md`.
3. **Within 24h:**
   - Write up a brief post-mortem in the incident note: what
     happened, what we did, what we'd do differently.
   - Joey reviews.
4. **Within 1 week:**
   - Convert any "what we'd do differently" items into engineering
     tickets.

### On-call contacts

- **Engineering on-call:** rotates weekly; current rota in
  `docs/ON_CALL_ROTA.md`.
- **Joey:** mobile in 1Password under
  `Project Silk Ops — Joey contact`. Page only for sustained
  outage (>30 min) or data integrity issues.
- **Mongo Atlas support:** plan includes 4-hour response on
  critical tickets.
- **Vercel support:** plan tier — check 1Password
  `Vercel — Amber Training plan info`.

---

## Sign-off

**Production deployment is considered live when:**

1. `PRODUCTION_SETUP_CHECKLIST.md` is complete and signed off.
2. `SECURITY_AUDIT.md` shows PASS on all items.
3. `CONTENT_AUTHORING.md` sign-offs in place for the launch-
   gating content items.
4. The first pilot org has been onboarded successfully.

Signatures:

| Role                | Date | Name | Signature |
|---------------------|------|------|-----------|
| Engineering lead    |      |      |           |
| Joey (Amber Training)|     |      |           |

**Update this document on every material change** — new service,
moved domain, rotated provider. The doc is only as useful as it
is current.
