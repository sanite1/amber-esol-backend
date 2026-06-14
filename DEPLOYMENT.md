# Project Silk — Deployment Checklist

End-to-end checklist for taking the ESOL feature set live.

---

## 0. Before you begin

- [ ] Confirm production MongoDB cluster is provisioned (or that `MONGODB_URI` in `.env` points at prod)
- [ ] Confirm Vercel project (or your host) is linked to the backend repo and frontend repo separately
- [ ] Decide on the production domain layout:
  - `app.<your-domain>.co.uk` → frontend dashboard module
  - `<your-domain>.co.uk` (or `esol.<...>`) → frontend platform module
  - `api.<your-domain>.co.uk` → backend
- [ ] Update `src/utils/index.ts` (frontend) hostname rules if your domains differ from the defaults

---

## 1. Environment variables (backend)

Set in Vercel project → Settings → Environment Variables (or your host's equivalent):

**Required (existing — already in your local `.env`)**

- [ ] `MONGODB_URI` — production cluster
- [ ] `JWT_SECRET` — strong random secret
- [ ] `CLOUDINARY_URL`, `CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- [ ] `AUTH_EMAIL`, `AUTH_PASS` — SMTP creds for transactional email
- [ ] `DOMAIN_NAME` — must point at the **frontend dashboard** URL (used to build verification + invite links)
- [ ] `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — production Stripe
- [ ] `DAILY_API_KEY`, `ZOOM_*` — video provider creds

**Required (Project Silk additions)**

- [ ] `CRON_SECRET` — random 32+ bytes; **also configure in Vercel cron settings** (see §4)
- [ ] `ANTHROPIC_API_KEY` — production key with usage budget set
- [ ] `DEEPSEEK_API_KEY`
- [ ] `DEEPSEEK_BASE_URL` — `https://api.deepseek.com`
- [ ] `REFERRAL_JWT_SECRET` — random 64+ bytes (separate from main JWT_SECRET)
- [ ] `REFERRAL_JWT_EXPIRES_IN` — e.g. `365d`
- [ ] `SAFEGUARDING_ALERT_EMAIL` — destination inbox monitored daily
- [ ] `INVOICE_CRON_SECRET` — random 32+ bytes (currently unused but reserved)
- [ ] `DEMO_MONGODB_URI` — optional, separate cluster for demos

---

## 2. Environment variables (frontend)

- [ ] `REACT_APP_BACKEND_URL` — points at the production backend (e.g. `https://api.<your-domain>.co.uk/api`)
- [ ] `REACT_APP_FRONTEND_URL` — public marketing site URL
- [ ] `REACT_APP_DASHBOARD_URL` — dashboard URL (used by platform navbar to direct users to login)

---

## 3. Database

- [ ] First deploy will auto-create new ESOL collections on first write. No migrations needed.
- [ ] Indices declared in models will auto-build on first query — monitor index build progress in Atlas
- [ ] **One-time data step**: confirm the existing User collection is OK with the new optional fields. The fields are all optional so existing documents are unaffected
- [ ] Set up MongoDB Atlas **Backup** schedule — at minimum daily snapshots with 7-day retention

---

## 4. Vercel cron jobs

`vercel.json` declares three crons. Ensure the production project has cron enabled (Vercel Pro plan or above):

```json
{
  "crons": [
    { "path": "/api/cron/complete-lessons", "schedule": "0 0 * * *" },
    { "path": "/api/cron/generate-invoices", "schedule": "0 9 1 * *" },
    { "path": "/api/cron/check-progression", "schedule": "0 6 * * *" }
  ]
}
```

- [ ] Confirm Vercel cron is enabled on the project
- [ ] Test each cron manually in production by hitting the endpoint with `Authorization: Bearer $CRON_SECRET`:
  - `curl -H "Authorization: Bearer $CRON_SECRET" https://api.<your-domain>/api/cron/complete-lessons`
  - `curl -H "Authorization: Bearer $CRON_SECRET" https://api.<your-domain>/api/cron/generate-invoices`
  - `curl -H "Authorization: Bearer $CRON_SECRET" https://api.<your-domain>/api/cron/check-progression`
- [ ] Verify each returns `200` with sensible JSON

---

## 5. PDF generation (puppeteer-core + @sparticuz/chromium)

- [ ] Vercel Pro plan or above — required for the larger function memory needed by Chromium (≥ 1024 MB recommended)
- [ ] In `vercel.json`, set the invoice PDF function memory:
  ```json
  "functions": {
    "src/index.ts": { "memory": 1024, "maxDuration": 30 }
  }
  ```
  (Add this object if it doesn't exist; adjust `maxDuration` per plan limits.)
- [ ] Test invoice PDF download in production after first invoice exists. If it fails: check function logs for chromium executable path errors.

---

## 6. CORS

- [ ] Backend currently has `origin: "*"` (in `src/index.ts`). **Tighten before production** — uncomment the `corsOption` block above it and ensure `ALLOWED_ORIGINS` in `src/config/cors.ts` lists your production frontend URLs.

---

## 7. Email

- [ ] Verify the SMTP host/port (`mail.privateemail.com:465` currently) accepts production volume. If you expect > 1000 transactional emails/day, switch to Postmark / SendGrid / SES.
- [ ] Test in staging:
  - [ ] Learner verification email
  - [ ] Learner invitation email (`learnerInvite`)
  - [ ] Safeguarding alert email (`safeguardingAlert`) — fires when `safeguardingScore >= 0.7`
- [ ] Add SPF / DKIM / DMARC records for `@ambertraining.co.uk` (or your sending domain)

---

## 8. AI / model access

- [ ] **Anthropic** — set monthly spend cap on the production key (Anthropic console → Settings → Limits)
- [ ] **DeepSeek** — set spend cap and confirm `deepseek-chat` model is available in your region
- [ ] Pin the Claude model in `src/services/claudeAI.service.ts` (`MODEL` constant) to a specific dated version once you've validated behaviour
- [ ] Smoke-test the 5-stage pipeline by sending a turn through a real session in staging:
  - [ ] Normal input → AI replies, vocab extracted
  - [ ] Input with email + UK postcode → both redacted before reaching DeepSeek (check logs)
  - [ ] Input expressing distress → safeguarding alert raised, email dispatched, dashboard updates
  - [ ] Anthropic API key removed → turn rejected with 503 (fail-closed verified)

---

## 9. Domain DNS / TLS

- [ ] DNS records for the three subdomains (`app.`, `api.`, root) point at Vercel
- [ ] TLS certificates issued for all three (Vercel auto-provisions via Let's Encrypt)
- [ ] CNAME for `mail.<your-domain>` if using a separate sending domain

---

## 10. Manual smoke test (in staging) — full demo loop

Run through the entire user journey in this order:

1. [ ] Platform admin signs in → "ESOL → Organisations" → provisions a new org with admin user
2. [ ] Org admin verification email arrives → click link → verifies → can sign in to `/org/home`
3. [ ] Platform admin → "ESOL → ESOL Teachers" → approves an existing tutor (CELTA, DBS clear)
4. [ ] Org admin → "Invitations" → sends invitation to a learner email
5. [ ] Learner email arrives → clicks → sees `/esol/join?token=…` with org name + level
6. [ ] Learner registers → email verification arrives → verifies → signs in → lands on `/esol/home`
7. [ ] Org admin → opens learner detail → "Start AI session" → picks the approved teacher → session created
8. [ ] Learner → opens session from `/esol/home` → submits a turn → AI tutor replies, vocab badges appear
9. [ ] Learner submits a concerning message → 403 returned, safeguarding alert email arrives at `SAFEGUARDING_ALERT_EMAIL`
10. [ ] Platform admin → "Safeguarding" → sees alert → reviews with outcome
11. [ ] Teacher (now ESOL-approved) → "ESOL Sessions" → opens session → views auto-generated prep note → marks complete
12. [ ] Learner returns to session → auto-prompted to rate (1–5 + comment) → submits feedback
13. [ ] Teacher returns to session → adds progress notes → saves
14. [ ] Org admin → "Learners" → opens learner → "Change level" → records change with reason
15. [ ] Org admin → checks `/org/learners/<id>` → level history shows the change
16. [ ] Hit cron `/api/cron/generate-invoices` manually → invoice created
17. [ ] Org admin → "Invoices" → sees the new invoice → downloads PDF → opens correctly
18. [ ] Platform admin → "Invoices" → marks the invoice as paid
19. [ ] Platform admin → "Reports" → selects org + period → downloads ILR CSV → opens in Excel/Sheets cleanly
20. [ ] Learner → "Vocabulary" → sees vocab list → marks several "I know this" → mastered count updates

---

## 11. Post-launch monitoring

- [ ] **Logs**: pino logs from the backend stream to Vercel/your host. Set up an alert for `level: "error"` events.
- [ ] **Safeguarding alerts inbox**: configure a person + backup person to monitor `SAFEGUARDING_ALERT_EMAIL` daily
- [ ] **Failed PDF generation**: alert on `"PDF generation failed"` log lines
- [ ] **Cron failures**: Vercel cron dashboard shows status per run — set up Slack/email alert for failed runs
- [ ] **Anthropic spend**: weekly dashboard check during first month
- [ ] **DeepSeek spend**: weekly dashboard check during first month

---

## 12. Known issues to address before scale

These are documented but deferred — fine for MVP/pilot, plan for production scale-up:

- Progression cron is N+1 (one DB query per active learner) — refactor to a single aggregate when you cross ~1000 learners
- Per-turn PII scrub re-runs over all prior turns (O(n²) per session) — store scrubbed text on the turn document if sessions exceed ~50 turns
- Bcrypt salt rounds = 13 (~1s/hash) — adequate for security but registration latency is high under load
- Invoice PDFs are generated on-demand each download — for high volume, persist to Cloudinary on first generation
- Marketing pages (`/esol`, `/esol/for-organisations`) have no SEO meta tags / OG images / structured data yet
- No automated tests; pre-launch QA must be manual
- Deferred Sprint 7 items: nudge-emails from progression cron, vocab spaced-repetition scheduling, learner-side teacher feedback visibility

---

## Sign-off

- [ ] Backend deployed
- [ ] Frontend dashboard deployed
- [ ] Frontend platform deployed
- [ ] Smoke test (§10) completed end-to-end without errors
- [ ] Monitoring (§11) is in place
- [ ] Stakeholder demo scheduled
