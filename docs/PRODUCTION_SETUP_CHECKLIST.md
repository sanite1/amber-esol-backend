# Production deployment setup checklist

> Step-by-step procedural runbook for standing up the production
> deployment. Work through this top-to-bottom; do not skip steps or
> reorder. Every checkbox is a verification step — tick it when
> you've **observed** the outcome (a green Vercel build log, an HTTP
> 200 from a probe), not when you've configured the input.
>
> When this checklist is complete and the security audit
> (`docs/SECURITY_AUDIT.md`) is signed off, the pilot launch gate
> opens.

---

## Stage 0 — Pre-flight

- [ ] Security audit (`docs/SECURITY_AUDIT.md`) shows PASS on items
      10 (Vercel security headers), 11 (`npm audit` clean), and 12
      (cross-org pen test).
- [ ] Content authoring tracker (`docs/CONTENT_AUTHORING.md`) shows
      sign-offs on at minimum: Layer 1/2/3 prompts, the 3 scenarios,
      80-question placement bank, 30 safeguarding messages,
      compliance config seeds.
- [ ] Load test results (`tests/load/RESULTS_<date>.md`) show every
      scenario PASS against staging.
- [ ] 1Password vault `Project Silk — Production` exists. All
      secrets in this checklist will be sourced from it.
- [ ] The team member running this checklist has:
  - Vercel "Owner" role on the Amber Training org
  - Railway "Admin" role on the Amber Training project (Stage 5)
  - GitHub `Maintain` on `amber-esol-backend` + `amber-esol-mvp`
  - DNS edit access on `ambertraining.co.uk`

---

## Stage 1 — Backend Vercel project (`amber-esol-backend`)

### 1.1 Project creation

- [ ] In Vercel, **Add New Project** → **Import Git Repository**.
- [ ] Select the `amber-esol-backend` repo.
- [ ] **Production branch:** `main`. **Preview branches:** `develop`
      and all PR branches.
- [ ] **Framework preset:** **Other** (NOT Node.js — Vercel's Node
      preset overrides our `vercel.json` routes block).
- [ ] **Build command:** `npm run build`
- [ ] **Output directory:** leave empty (Vercel reads `vercel.json`
      for serverless function routing).
- [ ] **Install command:** `npm ci` (NOT `npm install` — `ci` is
      reproducible from the lockfile).

### 1.2 Environment variables (production scope)

Set every variable under **Settings → Environment Variables →
Production**. Each variable's value comes from the 1Password vault
entry named in the right column. Copy-paste from 1Password directly
into the Vercel UI — never via a shell that might log the value.

| Variable                         | 1Password entry                              | Notes                                                                          |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `NODE_ENV`                       | _literal_ `production`                       |                                                                                |
| `MONGODB_URI`                    | Mongo — Prod URI                             | Atlas cluster, prod project                                                    |
| `DEMO_MONGODB_URI`               | (omit — prod project ≠ demo project)         | LEAVE UNSET. See Stage 6                                                       |
| `REDIS_URL`                      | Upstash — Prod URL                           |                                                                                |
| `JWT_SECRET`                     | JWT_SECRET — Prod                            | 64-byte hex                                                                    |
| `REFERRAL_JWT_SECRET`            | REFERRAL_JWT_SECRET — Prod                   | 64-byte hex                                                                    |
| `REFERRAL_JWT_EXPIRES_IN`        | _literal_ `365d`                             |                                                                                |
| `MIS_CREDENTIALS_KEY`            | MIS_CREDENTIALS_KEY — Prod                   | 32-byte hex                                                                    |
| `CRON_SECRET`                    | CRON_SECRET — Prod                           | Validates `Authorization: Bearer …` on cron routes                             |
| `INVOICE_CRON_SECRET`            | INVOICE_CRON_SECRET — Prod                   | Separate from CRON_SECRET — billing isolation                                  |
| `BULL_BOARD_TOKEN`               | BULL_BOARD_TOKEN — Prod                      | 32-byte hex                                                                    |
| `STRIPE_SECRET_KEY`              | Stripe — Live secret key                     | `sk_live_…` not `sk_test_…`                                                    |
| `STRIPE_WEBHOOK_SECRET`          | Stripe — Live webhook secret                 |                                                                                |
| `AUTH_EMAIL`                     | privateemail.com — auth user                 |                                                                                |
| `AUTH_PASS`                      | privateemail.com — auth pass                 |                                                                                |
| `ADMIN_EMAIL`                    | _literal_ `joey@ambertraining.co.uk`         | Audit/ops recipient                                                            |
| `SAFEGUARDING_EMAIL`             | _literal_ `safeguarding@ambertraining.co.uk` | Designated safeguarding lead                                                   |
| `SAFEGUARDING_ALERT_EMAIL`       | _literal_ same as above                      | Alert recipient                                                                |
| `SUPPORT_EMAIL`                  | _literal_ `support@ambertraining.co.uk`      |                                                                                |
| `GOOGLE_APPLICATION_CREDENTIALS` | GCP — Service account JSON (literal)         | Paste the JSON content (Vercel re-mounts at runtime). Do NOT paste a file path |
| `GOOGLE_CLOUD_PROJECT_ID`        | GCP — Project ID                             |                                                                                |
| `GOOGLE_CLOUD_REGION`            | _literal_ `europe-west2`                     |                                                                                |
| `GEMINI_MODEL`                   | _literal_ `gemini-2.5-flash`                 |                                                                                |
| `CLOUD_NAME`                     | Cloudinary — cloud name                      |                                                                                |
| `CLOUDINARY_API_KEY`             | Cloudinary — API key                         |                                                                                |
| `CLOUDINARY_API_SECRET`          | Cloudinary — API secret                      |                                                                                |
| `DAILY_API_KEY`                  | Daily.co — API key                           | Video call hosting                                                             |
| `ZOOM_ACCOUNT_ID`                | Zoom — account id                            | If Zoom integration used                                                       |
| `ZOOM_CLIENT_ID`                 | Zoom — client id                             |                                                                                |
| `ZOOM_CLIENT_SECRET`             | Zoom — client secret                         |                                                                                |
| `ACADEMIC_YEAR`                  | _literal_ `2025/26`                          | Updated 1 August each year                                                     |
| `AMBER_UKPRN`                    | _literal_ (Joey supplies)                    |                                                                                |
| `DOMAIN_NAME`                    | _literal_ `esol.ambertraining.co.uk`         |                                                                                |
| `LARGE_DATASET_TIMEOUT`          | _literal_ `600000`                           | 10 min for postcode load                                                       |
| `LOG_LEVEL`                      | _literal_ `info`                             |                                                                                |
| `MOCK_OCR`                       | _literal_ `false`                            |                                                                                |
| `SENTRY_DSN`                     | Sentry — Backend DSN                         | See Stage 8                                                                    |

- [ ] Confirm `DEMO_MONGODB_URI` is **not set** on the prod project.
      Its presence would let an accidentally-flipped `DEMO_MODE` env
      var connect to the demo cluster — better to fail closed.
- [ ] After saving, re-open each variable and confirm the value
      didn't get truncated (Vercel UI truncates display at 4096
      chars — `GOOGLE_APPLICATION_CREDENTIALS` is the biggest, ~2.5KB).

### 1.3 First deploy + smoke test

- [ ] Push a commit to `main` (or trigger a manual redeploy from
      the Vercel dashboard).
- [ ] Watch the build log. **Pass:** "Build completed in <Xm>" with
      no `tsc` errors.
- [ ] Once deployed, hit `GET https://<vercel-generated-url>/api/health`.
      **Pass:** HTTP 200 with `{"ok": true, …}`.

---

## Stage 2 — Backend custom domain

### 2.1 DNS + Vercel attach

- [ ] In Vercel project → **Settings → Domains** → add
      `api.esol.ambertraining.co.uk`.
- [ ] Vercel shows DNS instructions. Add the requested `CNAME` /
      `A` record at your DNS provider for the apex. - Recommend `CNAME → cname.vercel-dns.com`.
- [ ] Wait for propagation (5–60 min).
- [ ] Vercel auto-provisions a Let's Encrypt cert. Confirm **green
      tick** next to the domain in Vercel.
- [ ] Probe `curl -I https://api.esol.ambertraining.co.uk/api/health`:
  - [ ] HTTP/2 200
  - [ ] `Strict-Transport-Security` header present
  - [ ] `X-Frame-Options: DENY`
  - [ ] `Content-Security-Policy` present
  - [ ] (Other security headers per `docs/SECURITY_AUDIT.md` item 10)

### 2.2 CORS allowlist

- [ ] Confirm `src/config/cors.ts` lists
      `https://esol.ambertraining.co.uk` (frontend prod origin).
      Already present from Phase 0.1.
- [ ] Confirm `app.ambertraining.co.uk` is on the allowlist (legacy
      marketplace app — same backend).

---

## Stage 3 — Frontend Vercel project (`amber-esol-mvp`)

### 3.1 Project creation

- [ ] Vercel **Add New Project** → import `amber-esol-mvp`.
- [ ] **Framework preset:** **Create React App**.
- [ ] **Production branch:** `main`. **Preview branches:** `develop` + PR branches.
- [ ] **Build command:** `npm run build` (CRA default).
- [ ] **Output directory:** `build` (CRA default).
- [ ] **Install command:** `npm ci`.

### 3.2 Environment variables (production scope)

| Variable                | Value                                  |
| ----------------------- | -------------------------------------- |
| `REACT_APP_BACKEND_URL` | `https://api.esol.ambertraining.co.uk` |
| `REACT_APP_SENTRY_DSN`  | (1Password: Sentry — Frontend DSN)     |
| `REACT_APP_ENVIRONMENT` | `production`                           |

- [ ] Save. Trigger a redeploy.

### 3.3 Custom domain

- [ ] Vercel project → **Settings → Domains** → add
      `esol.ambertraining.co.uk`.
- [ ] Add the DNS record at your provider.
- [ ] Confirm green tick + auto-cert.
- [ ] Open `https://esol.ambertraining.co.uk` in a browser, hit the
      login page, confirm no console errors and the demo-mode
      banner is NOT showing (production data should never have
      `X-Demo-Mode: true`).

---

## Stage 4 — Worker fleet on Railway [ADDENDUM]

Vercel functions cap at 60 s. BullMQ workers need long-running
processes. The brief recommends Railway for the worker fleet.

### 4.1 Railway project setup

- [ ] In Railway, **New Project** → **Deploy from GitHub repo** →
      select `amber-esol-backend`.
- [ ] **Service name:** `workers`.
- [ ] **Build command:** `npm ci && npm run build`.
- [ ] **Start command:** `node dist/workers/run.js`. (NOT
      `ts-node` — production runs the compiled JS for startup
      speed and lower memory.)
- [ ] **Watch path:** `/src/workers/**` + `/src/services/**` +
      `/src/queues/**` — but only auto-deploy from `main`.

### 4.2 Environment variables on Railway

- [ ] Copy **the same** variables from Stage 1.2 into Railway's
      service env. The workers need DB + Redis + Gemini + email
      credentials.
- [ ] **Exceptions** (variables Railway doesn't need):
  - `STRIPE_*` (workers don't process webhooks)
  - `BULL_BOARD_TOKEN` (workers don't serve Bull Board)
  - `CRON_SECRET`, `INVOICE_CRON_SECRET` (workers don't host cron
    endpoints)

### 4.3 Health check

- [ ] Railway **Health check path:** leave blank (workers don't
      serve HTTP). Use the platform's "process up" check.
- [ ] **Restart policy:** `on_failure`, max 5 restarts in 10 min.
- [ ] **Replicas:** 1 to start. Scale up via `workers/index.ts`
      concurrency rather than replicas — sharing one Redis
      connection per replica is cheaper.

### 4.4 Smoke test

- [ ] Watch the Railway logs. **Pass:** within 30 s of start, log
      line `"All BullMQ workers started"` with `count: 9`.
- [ ] From the backend prod URL, trigger a small RARPA evidence
      report. Watch the Railway logs — the
      `processRarpaEvidence` handler should fire and log
      `"generateEvidenceReport: complete"`.

---

## Stage 5 — Vercel cron jobs

Vercel reads cron config from `vercel.json` (already committed).

- [ ] In the backend Vercel project → **Settings → Crons**,
      confirm all 7 entries are listed:
  - `/api/cron/complete-lessons` @ `0 0 * * *`
  - `/api/cron/generate-invoices` @ `0 9 1 * *`
  - `/api/cron/check-progression` @ `0 6 * * *`
  - `/api/cron/priority-queue` @ `0 6 * * *`
  - `/api/cron/fala-refresh` @ `0 8 1 * *`
  - `/api/cron/postcode-refresh-alert` @ `0 8 1 8 *`
  - `/api/cron/reset-demo-environment` @ `0 3 * * *`
- [ ] Click each row → **Run now** → observe a 200 (or 403 for
      `reset-demo-environment` on the prod project — DEMO_MODE is
      false; the route returns 403 by design, which IS the success
      signal for the prod cron).
- [ ] Confirm each cron run triggers an audit-log row in the prod
      Mongo for non-demo crons. The 403 from `reset-demo` won't
      write a row; that's expected.

---

## Stage 6 — Demo project (separate Vercel project)

The brief's Function 16 demo-mode toggle is enabled by a **separate
Vercel project** pointed at the demo Mongo cluster. This project
runs the same repo with `DEMO_MODE=true` and a different env var
set.

- [ ] Vercel **Add New Project** → import `amber-esol-backend`
      again as a separate project, name it
      `amber-esol-backend-demo`.
- [ ] Production branch: `main` (mirrors prod, single source of
      truth).
- [ ] **Environment variables** — identical to Stage 1.2 with these
      differences:
  - `DEMO_MODE=true`
  - `DEMO_MONGODB_URI=<demo cluster URI>`
  - `MONGODB_URI` — **unset** (Function 16's `db.ts` throws if
    DEMO_MODE is true and `DEMO_MONGODB_URI` is missing; this
    forces fail-closed if the env is misconfigured)
- [ ] Custom domain `api-demo.ambertraining.co.uk` →
      `cname.vercel-dns.com`.
- [ ] Confirm `curl https://api-demo.ambertraining.co.uk/api/health`
      returns the `X-Demo-Mode: true` response header.
- [ ] Repeat for the frontend (`amber-esol-mvp-demo` Vercel
      project) at `esol-demo.ambertraining.co.uk` with
      `REACT_APP_BACKEND_URL=https://api-demo.ambertraining.co.uk`.

---

## Stage 7 — Centralised logging

The brief recommends Logtail (Better Stack) for MVP.

- [ ] Sign up Better Stack → create a **Source** of type "Node.js".
- [ ] Copy the source token. Add to BOTH the backend Vercel project
      and the Railway worker service:
  - `LOGTAIL_SOURCE_TOKEN=<token from Better Stack>`
- [ ] Update `src/config/logger.ts` to add a Logtail transport when
      `process.env.LOGTAIL_SOURCE_TOKEN` is set. Pino's
      `@logtail/pino` transport documentation covers this:
      <https://betterstack.com/docs/logs/javascript/pino/>
- [ ] Redeploy backend + workers.
- [ ] In Better Stack UI, confirm log lines flowing from both
      sources within 60s of the redeploy.
- [ ] Set up an alert: any `level >= 50` (error/fatal) → email to
      `joey@ambertraining.co.uk + support@ambertraining.co.uk`.

---

## Stage 8 — Error tracking (Sentry)

- [ ] Sign up Sentry → create two projects:
  - `amber-esol-backend` (platform: Node)
  - `amber-esol-mvp` (platform: React)
- [ ] **Backend integration:**
  - [ ] `npm i @sentry/node` in `amber-esol-backend`.
  - [ ] Initialise at the top of `src/index.ts` (BEFORE any other
        import that can throw at module load):
        `ts
import * as Sentry from "@sentry/node";
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    tracesSampleRate: 0.05,
  });
}
`
  - [ ] Wrap the Express error middleware with `Sentry.Handlers.errorHandler()`.
  - [ ] Set `SENTRY_DSN` on backend Vercel + Railway. Demo project
        gets a DIFFERENT DSN so demo errors don't pollute the prod
        Sentry feed.
- [ ] **Frontend integration:**
  - [ ] `npm i @sentry/react` in `amber-esol-mvp`.
  - [ ] Initialise in `src/index.tsx` with the frontend DSN.
  - [ ] Set `REACT_APP_SENTRY_DSN` on the frontend Vercel project.
- [ ] **Test:** trigger a deliberate error (e.g. add a temporary
      route that throws) and confirm it lands in Sentry within
      30 s. Remove the test route.

---

## Stage 9 — Uptime monitoring (BetterUptime / UptimeRobot)

- [ ] Sign up BetterUptime (or UptimeRobot — either is fine).
- [ ] Create a monitor on
      `https://api.esol.ambertraining.co.uk/api/health`:
  - **Check interval:** 1 min
  - **Expect status:** 200
  - **Expect body contains:** `"ok":true`
  - **From:** at least 3 regions (London, Frankfurt, Virginia)
- [ ] Create a second monitor for the frontend:
      `https://esol.ambertraining.co.uk/` returning 200.
- [ ] Create a third monitor for the worker fleet (indirect):
      `https://api.esol.ambertraining.co.uk/api/admin/queues/summary`
      with the admin token in headers → expects the summary JSON.
      An empty `queues` array signals workers are dead.
- [ ] Set alert routing: page-on-call → Joey's mobile via SMS for
      the API health check; email for the others.

---

## Stage 10 — Final pre-launch verification

- [ ] **Cross-service connectivity smoke:**
  - [ ] Backend → Mongo: `GET /api/health` returns 200.
  - [ ] Backend → Redis: `GET /api/health/redis` returns 200
        (admin token required).
  - [ ] Backend → Gemini: `GET /api/health/gemini` returns 200
        (admin token required).
- [ ] **End-to-end smoke flow:**
  - [ ] Log in as a seeded prod org admin.
  - [ ] Create a single test learner.
  - [ ] Trigger a placement assessment.
  - [ ] Start an AI tutor session, submit one turn, complete the
        session.
  - [ ] Open the org-admin dashboard, confirm the learner appears
        with one session.
  - [ ] Open Bull Board (`/admin/queues`), confirm
        `update_vocab` and `process_turn` jobs flowed through.
  - [ ] Trigger a small RARPA evidence-report PDF, confirm it
        downloads.
- [ ] **Demo gate confirmation:**
  - [ ] Hit `https://api.esol.ambertraining.co.uk/api/health`.
        Confirm `X-Demo-Mode` header is **absent** (production is
        not demo).
  - [ ] Hit `https://api-demo.ambertraining.co.uk/api/health`.
        Confirm `X-Demo-Mode: true` header IS present.
  - [ ] Attempt `POST /api/admin/orgs/<demo org>/ilr` against
        production. Confirm 403 (demo orgs cannot submit ILR).

---

## Stage 11 — Sign-off

When every checkbox above is ticked, both signatures below
unlock production traffic.

### Engineering lead

| Date | Name | Deployment SHAs (backend / frontend / workers) | Signature |
| ---- | ---- | ---------------------------------------------- | --------- |
|      |      |                                                |           |

### Joey (Amber Training Ltd — engagement lead)

| Date | Signature |
| ---- | --------- |
|      |           |

**Until both signatures are in place, the production custom
domains MUST remain pointed at a maintenance page or 503
landing.**
