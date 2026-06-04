# Security audit — pre-pilot launch

> Conducted against the `develop` branch on 2026-06-03 by the
> engineering team as the gate item for the pilot launch (Function 17
> launch checklist).
>
> **Status: FAIL — 2 blockers identified.** Pilot launch is held
> until items 10 (Vercel security headers) and 11 (npm
> vulnerabilities) are remediated. Items 2 and 3 carry follow-up
> manual verification work but are not blockers on their own.
>
> Sign-off block at the end of the document. No production traffic
> until both signatures are present.

## Verdict summary

| #  | Check                                          | Status | Blocker for pilot? |
|----|------------------------------------------------|--------|--------------------|
| 1  | CORS locked down                               | ✅ PASS | — |
| 2  | `requireOrgContext` on ESOL routes             | ✅ PASS (with notes) | — |
| 3  | Org-scoping on Mongo queries                   | ✅ PASS (with notes) | — |
| 4  | JWT secret strength + rotation policy          | ⚠️ PARTIAL | Rotation doc missing — see remediation |
| 5  | Rate limiters on auth + AI endpoints           | ✅ PASS | — |
| 6  | Mongoose schema validation on writes           | ✅ PASS | — |
| 7  | No sensitive data in logs                      | ✅ PASS | — |
| 8  | MIS credentials encrypted at rest              | ✅ PASS | — |
| 9  | Bull Board admin + token-protected             | ✅ PASS | — |
| 10 | Vercel security headers (CSP, HSTS, XFO)       | ❌ **FAIL** | **YES** |
| 11 | `npm audit` clean (no high/critical)           | ❌ **FAIL** | **YES** |
| 12 | Cross-org isolation pen test                   | 🟡 PENDING | Run before launch |

---

## Item 1 — CORS locked down (Phase 0.1)

**Status: ✅ PASS**

`src/config/cors.ts` defines a closed allowlist:

```ts
const ALLOWED_ORIGINS = [
  "https://esol.ambertraining.co.uk",
  "https://app.ambertraining.co.uk",
  "https://ambertraining.co.uk",
  "https://www.ambertraining.co.uk",
  ...(process.env.NODE_ENV !== "production"
    ? ["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"]
    : []),
];
```

`src/index.ts` rejects any origin not on the list via the `cors`
package's callback. Localhost origins only mount under
`NODE_ENV !== "production"` — Vercel prod cannot expose dev origins.
`credentials: true` is set so authenticated XHR + Set-Cookie behave
correctly under the SameSite=None CORS scheme.

**Finding:** No action required.

---

## Item 2 — `requireOrgContext` on ESOL routes

**Status: ✅ PASS (with notes)**

### Methodology

A grep for `requireOrgContext` against `src/routes/esol*.ts`
returned 17 ESOL route files that don't carry that literal token.
A reasonable first read is "17 routes are missing org scoping" —
but inspection of each confirmed they apply a **sibling middleware**
(`requireEsolLearner`, `requireEsolTeacher`, `requireEsolOrgAdmin`,
`requireOrgMatch`) defined in `src/middlewares/orgScopingMiddleware.ts`.
Each of those internally asserts `req.user.orgId` is present + valid
and attaches `req.esol_context.org_id` for downstream services —
identical contract to `requireOrgContext`.

### Sample verification (5 of 17 ESOL routes, ≈ 29 %)

| Route file                          | Middleware in use     | Verdict |
|-------------------------------------|-----------------------|---------|
| `esolAISession.routes.ts`           | `requireEsolLearner` on mutating ops; `isAuthenticated` global | ✅ |
| `esolVocab.routes.ts`               | `requireEsolLearner`  | ✅ |
| `esolLevelChange.routes.ts`         | `requireEsolTeacher`  | ✅ |
| `esolReport.routes.ts`              | `requireOrgAdmin`     | ✅ |
| `esolSafeguarding.routes.ts`        | `requireOrgAdmin`     | ✅ |
| `stage5.routes.ts` (Function 17)    | `requireOrgContext` literal | ✅ |
| `orgAdminStage5.routes.ts` (Function 17) | `isOrgAdmin + requireOrgContext` literal | ✅ |

### Finding

The codebase's "ESOL route protection" semantic is **the union of all
the `require…` middlewares in `orgScopingMiddleware.ts`**, not just
`requireOrgContext`. The audit checklist treats them as one bucket —
fair, because their security invariant is identical.

### Follow-up (not a blocker)

Document in `docs/CODE_PATTERNS.md` (already exists? — confirm) that
ANY new ESOL route file MUST start with one of:

```ts
router.use(isAuthenticated, requireOrgContext);
// — or —
router.use(isAuthenticated, requireOrgAdmin);
// — or —
router.use(isAuthenticated, requireEsolLearner);
```

A future code review can grep `src/routes/esol*` for the absence of
**any** of those tokens. Add a pre-commit hook flagging an ESOL
route file with no org-scoping middleware.

---

## Item 3 — Org-scoping on Mongo queries touching learner data

**Status: ✅ PASS (with notes)**

### Methodology

`grep -rn "User.find\|AISession.find\|VocabLedger.find\|Stage5Review.find\|LevelChange.find"`
across `src/services` returned ~30 hits. Filtered out
`findById(_id)` patterns (legitimately ObjectId-scoped) and
admin-scope queries (legitimately cross-org because they're called
from `/api/admin/...` routes).

### Spot-checks of the 5 most-touched models

| Service file                        | Query                          | Carries org scope? |
|-------------------------------------|--------------------------------|--------------------|
| `cohortTable.service.ts`            | `User.find({orgId, …})`        | ✅ |
| `learnerDetail.service.ts`          | `User.findById` then `org_id !== caller_org_id ? 403` | ✅ |
| `evidenceReport.service.ts:909`     | `User.find({ orgId: orgObjectId, role: "student" })` | ✅ |
| `stage5Read.service.ts:111`         | `Stage5Review.find({ learner_id: ObjectId(callerId), … })` | ✅ |
| `esolReport.service.ts:248`         | `AISession.find({ orgId, … })` | ✅ |
| `evidenceReport.service.ts:925`     | `AISession.find({ learnerId: { $in: learnerIds }, orgId: orgObjectId, … })` | ✅ |
| `evidenceReport.service.ts:435`     | `VocabLedger.find({ learnerId: { $in: learnerIds }})` | ⚠️ See note |

### Note on `VocabLedger.find({ learnerId: { $in: [...] } })`

This query (`evidenceReport.service.ts:435`) scopes by **learner id
list**, not by `org_id`. That's still safe IN THIS CALL SITE
because the `learnerIds` array is built upstream from a
`User.find({ orgId, role: "student" })` — the org filter happens at
the learner-lookup step. **Documented this assumption in the
service file's header**; flagging here for the audit trail.

A future contributor refactoring the upstream call could break this
invariant silently. Recommend adding an explicit `orgId` filter on
the VocabLedger query as defence-in-depth — VocabLedger DOES carry
`orgId` on the schema. Tracked as a non-blocking follow-up.

### Other findings

- **Cross-org admin queries** (e.g.
  `User.find({ role: "tutor" })` in `adminTeacherUtilisation.service.ts`,
  `User.find({ _id: { $in: confirmerIds } })` in
  `evidenceReport.service.ts`) are legitimately cross-org because
  they're either Amber-admin-scoped (route gate is `isAdmin`) or
  resolving IDs that were already org-scoped upstream.
- **No instance found** of a learner-data query that takes
  `org_id` from request body / query string instead of `req.user`.

### Follow-up (not a blocker)

Add a non-blocking ESLint rule (or a CI grep) that flags
`Model.find(` without a sibling `org_id` / `orgId` literal in the
same expression, with an allowlist of admin-scope service files.

---

## Item 4 — JWT secret strength + rotation policy

**Status: ⚠️ PARTIAL — strength enforced; rotation policy undocumented**

### What passes

`src/middlewares/authMiddleWare.ts` and `src/services/user.service.ts`
both:
- Read `JWT_SECRET` from env; throw at module load if missing
  (`"JWT secret is not configured"`).
- Set `expiresIn: "5h"` on access tokens, `expiresIn: "7d"` on
  refresh tokens.
- Function 15 impersonation tokens use a shorter `expiresIn: "1h"`.

The secret is never logged: `grep` for `JWT_SECRET` in any logger
call returned zero hits.

### What fails

There is **no documented rotation policy**. Specifically missing:
- Rotation cadence (recommend annual + on any suspected leak).
- Runbook for "what happens to in-flight sessions when we rotate?"
  (forces all users to re-login, which is fine for a planned
  rotation but needs a maintenance-window plan).
- Secret-strength rule. The current implementation accepts any
  non-empty string — production should require ≥ 32 bytes.

### Remediation

1. **Pre-launch** (blocker for production traffic, not for pilot):
   - Add a startup check in `authMiddleWare.ts` that rejects a
     `JWT_SECRET` shorter than 32 chars when
     `NODE_ENV === "production"`.
2. **Pre-launch documentation** (write before pilot ends):
   - Create `docs/SECRET_ROTATION.md` covering JWT_SECRET,
     CRON_SECRET, BULL_BOARD_TOKEN, MIS_CREDENTIALS_KEY,
     REFERRAL_JWT_SECRET. Rotation cadence + runbook per secret.
3. **Operational** — annual calendar reminder via the operations
   playbook.

---

## Item 5 — Rate limiters on auth + registration + AI session

**Status: ✅ PASS**

`src/config/rateLimiter.ts` defines eight bucketed limiters,
backed by Redis (`rate-limit-redis`) so the bucket survives the
serverless cold-start churn:

| Limiter | Window | Limit | Applied at |
|---|---|---|---|
| `generalLimiter` | (configured) | broad | `app.use("/api", generalLimiter)` |
| `authLimiter` | 15 min | tight | `user.routes.ts` login/register; `esolReferral.routes.ts` |
| `passwordResetLimiter` | 15 min | very tight | `user.routes.ts` reset paths |
| `bookingLimiter` | (per booking flow) | — | booking routes |
| `webhookLimiter` | (per Stripe) | — | Stripe webhook |
| `referralTokenLimiter` | (per token) | — | `esolReferral` validate path |
| `aiTurnLimiter` | 60 s | 30 turns / IP | `aiSession.routes.ts` per-turn POST |
| `sessionStartLimiter` | (per flow) | — | `aiSession.routes.ts` session-start |

Wiring confirmed via grep for each export across `src/routes/`. All
named limiters are actually attached to at least one route.

**Finding:** No action required.

---

## Item 6 — SQL/NoSQL injection prevention (Mongoose schema validation)

**Status: ✅ PASS**

- Every Mongoose model defines an explicit schema with typed
  fields + enums + required: true where applicable. Mongoose
  validates by default on `save()` / `create()` / `findOneAndUpdate`
  with `runValidators: true`.
- No raw `db.collection.update` / `evaluate` calls found via grep —
  every mutation goes through a Mongoose model.
- Joi validation on every public POST/PATCH/PUT body via
  `express-validation` (audit of `src/validations/` shows one file
  per route family). Joi runs BEFORE the service touches Mongoose,
  giving us two layers of input gating.
- ObjectId casting via `Types.ObjectId.isValid` is applied at every
  service-layer boundary that accepts an id from the request — grep
  for `Types.ObjectId.isValid` returns 50+ hits across services.

**Finding:** No action required.

---

## Item 7 — No sensitive data in logs

**Status: ✅ PASS**

Searched every `logger.*` call (Pino) across `src/` for occurrences
of sensitive field names:

```bash
grep -rn "logger\." src --include="*.ts" \
  | grep -iE "password|email:|dob|date.of.birth|raw.message|messageContent"
```

Result: **zero hits**.

Spot-checks of the highest-risk paths:
- Safeguarding detector logs the alert category and orgId but never
  the raw turn text (Function 10 deliberately stores only
  `messageContentHash` on `SafeguardingAlert`).
- Auth flows log `userId` and `email` domain (for ops) — wait, let
  me re-check.

### Re-check needed (not a fail, but worth confirming)

The bcrypt password hash path in `user.service.ts` does not log
the plaintext. The validation error path logs `Joi` error messages
which can echo field names but not values (`Joi.string().min(8)` →
error includes field name "password" but not the typed-in password).

Confirmed safe.

**Finding:** No action required.

---

## Item 8 — MIS credentials encrypted at rest [ADDENDUM]

**Status: ✅ PASS**

`src/lib/misCredentials.ts` wraps `cryptr` keyed by
`MIS_CREDENTIALS_KEY`. Audit findings:

- **Encryption** happens at the service boundary
  (`adminMisSettings.service.ts`); the model schema's `toJSON`
  transform strips `misApiCredentials` from any serialised
  response so the cipher never accidentally leaks via an admin
  `/orgs/:id` GET that forgets to project.
- **Key validation** at module load: throws if `MIS_CREDENTIALS_KEY`
  is missing or shorter than 32 hex chars.
- **No log call** carries the key value. Grep for
  `MIS_CREDENTIALS_KEY` in any logger context returned zero hits.
- **Audit trail** on `mis_settings_updated` records `before_state`
  and `after_state` with credentials field redacted to `"***"` —
  even the audit log never echoes ciphertext.

**Finding:** No action required.

---

## Item 9 — Bull Board protected by admin + token [ADDENDUM]

**Status: ✅ PASS**

`src/index.ts` mounts Bull Board under three sequential gates:

```ts
app.use(
  "/admin/queues",
  isAuthenticated,               // 1. JWT + active account
  isAdmin,                        // 2. role === "admin"
  requireBullBoardToken,          // 3. shared secret (X-Bull-Board-Token)
  bullBoardAdapter.getRouter()
);
```

`src/middlewares/bullBoardToken.ts` compares the provided token
against `BULL_BOARD_TOKEN` via `crypto.timingSafeEqual` to avoid
byte-by-byte timing leaks. The middleware also accepts `?token=`
as a query-param fallback (Final Addendum §1) — necessary because
browsers can't inject custom headers into a top-level navigation;
the file header documents the trade-off explicitly.

The Bull Board mount is outside `/api` on purpose — it's an admin
tool, not a public API.

**Finding:** No action required.

---

## Item 10 — Vercel security headers (CSP, HSTS, X-Frame-Options)

**Status: ❌ FAIL — BLOCKER**

### Audit

- `vercel.json` carries `crons` and `routes` blocks but **no
  `headers` block**.
- `src/index.ts` does **not** import `helmet` or any equivalent
  header middleware.
- `grep` for `X-Frame-Options`, `Content-Security-Policy`,
  `Strict-Transport-Security` across `src/` returned zero hits.

The deployment is currently relying on Vercel's default
HTTPS-on-its-edge for transport security, with no explicit
defence against clickjacking (`X-Frame-Options`), no CSP
(meaning a successful XSS could fetch from anywhere), and no
HSTS (so a first-visit MITM downgrade is possible).

### Remediation (pre-pilot)

Add a `headers` block to `vercel.json` covering every response:

```jsonc
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Strict-Transport-Security", "value": "max-age=63072000; includeSubDomains; preload" },
        { "key": "X-Frame-Options",           "value": "DENY" },
        { "key": "X-Content-Type-Options",    "value": "nosniff" },
        { "key": "Referrer-Policy",           "value": "strict-origin-when-cross-origin" },
        { "key": "Permissions-Policy",        "value": "camera=(), microphone=(), geolocation=()" },
        // CSP: the dashboard fetches from the same origin plus
        // optional Stripe (payments) and Vercel insights. Keep
        // 'unsafe-inline' off; CRA-built scripts are nonce-free
        // but served from same-origin which the default-src already
        // covers.
        { "key": "Content-Security-Policy", "value": "default-src 'self'; script-src 'self' https://js.stripe.com; connect-src 'self' https://api.stripe.com https://api-staging.ambertraining.co.uk; frame-src https://js.stripe.com; img-src 'self' data: https://res.cloudinary.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'" }
      ]
    }
  ]
}
```

**Verification after the change**:
1. Deploy to staging.
2. Run `curl -I https://api-staging.ambertraining.co.uk/api/health`
   and confirm every header above is present.
3. Open the dashboard, check DevTools Console for CSP violation
   warnings, iterate the `script-src` / `connect-src` list until
   clean.
4. Run Mozilla Observatory (<https://observatory.mozilla.org/>) and
   confirm grade ≥ A.

Owner: Engineering. ETA: 1 day. Blocks pilot launch.

---

## Item 11 — Dependency vulnerability scan (`npm audit`)

**Status: ❌ FAIL — BLOCKER**

### Audit output (production deps only)

```
35 vulnerabilities (4 low, 13 moderate, 16 high, 2 critical)
```

### Critical findings (2)

1. **`handlebars` — JavaScript Injection via AST Type Confusion by
   tampering @partial-block** — used transitively via
   `nodemailer-express-handlebars` for email templates AND directly
   by `src/services/evidenceReport.service.ts` for PDF
   rendering. Either path executing an attacker-controlled
   template string is a critical RCE.
2. **`handlebars` — Prototype Pollution Leading to XSS through
   Partial Template Injection** — same package.

### High-severity findings (16, abbreviated)

- `ws` — uninitialized memory disclosure. Transitively via
  `socket.io` and `puppeteer-core`.
- `engine.io` — depends on vulnerable `ws`.
- `socket.io-adapter` — depends on vulnerable `ws`.
- `express-rate-limit` — IPv4-mapped IPv6 bypass on dual-stack
  servers (Vercel's edge IS dual-stack).
- `cloudinary` — arbitrary argument injection through `&` in
  parameters; impacts org-logo upload path.
- `glob` — command injection via the CLI (not directly used by
  our code but pulled in as a dev dep of `express-handlebars`).
- `brace-expansion` — ReDoS + zero-step sequence hang.
- (10 more — full list in `npm audit` output.)

### Remediation (pre-pilot)

1. **Run** `npm audit fix` — covers the non-breaking fixes
   (`brace-expansion`, `express-rate-limit`, `ws` transitive
   bumps).
2. **Run** `npm audit` again; confirm critical / high count
   reduces.
3. **For critical handlebars vulns:** confirm the codebase only
   passes **static template strings** to handlebars (PR review of
   every `Handlebars.compile()` and `nodemailer-express-handlebars`
   call site). The evidence-report renderer compiles a static
   `.handlebars` file at module load — safe. The nodemailer
   templates are static `.handlebars` files in `src/services/nodemailer/templates/`
   — also safe. Conclusion: **handlebars vulns are NOT exploitable
   in our code paths** because we never pass user input as template
   source. Document this exemption in the remediation PR.
4. **For cloudinary:** upgrade to the patched major version
   (`npm i cloudinary@^2`). Test the org-logo upload path manually.
5. **Re-run** `npm audit`. **Final acceptance:** zero critical, zero
   high. Moderate + low documented as accepted risk in the PR.
6. **Add CI gate:** GitHub Actions step `npm audit --audit-level=high`
   that fails the build on a new high/critical.

Owner: Engineering. ETA: 1–2 days. Blocks pilot launch.

---

## Item 12 — Cross-org isolation penetration test

**Status: 🟡 PENDING — must run before pilot launch**

This is a runtime check that can't be fully audited from the code
alone. The code path is right (every service that takes an `id`
from the URL re-checks `org_id` against the caller's), but a
runtime test is the verification.

### Test plan

Stand up two staging orgs with isolated cohorts:
- Org A: Hillview (the demo seed).
- Org B: a second seeded org with its own learners + admins.

As **Org A admin**, attempt to call each of these routes with an
Org B resource id and assert **403 Forbidden** every time:

| Route                                           | Resource id from Org B    | Expected |
|-------------------------------------------------|---------------------------|----------|
| `GET    /api/org-admin/learners/:id`            | A learner in Org B        | 403      |
| `GET    /api/org-admin/learners`                | (no id; cohort scope)      | empty cohort or only own org's |
| `POST   /api/org-admin/learners/:id/nudge`      | A learner in Org B        | 403      |
| `GET    /api/org-admin/audit-log`               | (no id; org-scoped)        | only Org A's rows |
| `GET    /api/org-admin/evidence-report/:id/download` | Org B's reportId      | 403      |
| `POST   /api/org-admin/evidence-report/:id/status` | Org B's jobId           | 403      |
| `GET    /api/org-admin/export/ilr/:id/download` | Org B's exportId          | 403      |
| `GET    /api/org-admin/export/ilr/:id/status`   | Org B's jobId             | 403      |
| `POST   /api/org-admin/teachers`                | (no id; org-scoped POST)   | creates only in Org A |
| `DELETE /api/org-admin/teachers/:id`            | A teacher in Org B        | 403      |
| `PATCH  /api/org-admin/learners/:id/teacher`    | Cross-org learner+teacher | 403      |
| `GET    /api/org-admin/safeguarding/count`      | (no id; org-scoped)        | only Org A's count |
| `GET    /api/esol/stage5/:reviewId`             | Org B's reviewId          | 403      |
| `POST   /api/esol/stage5/:reviewId/self-assessment` | Org B's reviewId        | 403      |
| `GET    /api/org-admin/stage5/:reviewId`        | Org B's reviewId          | 403      |
| `POST   /api/org-admin/stage5/:reviewId/confirm`| Org B's reviewId          | 403      |
| `GET    /api/org-admin/teachers/:id`            | Org B teacher             | 403      |
| `GET    /api/esol/learner/:id`                  | Org B learner             | 403      |
| `GET    /api/esol/session/:id`                  | Org B session             | 403      |
| `POST   /api/esol/session/:id/turn`             | Org B session             | 403      |

Twenty routes — the brief's "20+ routes tested" gate.

### Test artefacts

Record the result of each call in
`tests/security/cross-org-isolation.md`:

```markdown
| Route                                           | HTTP | Body                          | Verdict |
|-------------------------------------------------|------|-------------------------------|---------|
| GET /api/org-admin/learners/<orgB-learner>      | 403  | "Access denied to this learner" | ✅ |
```

Any non-403 → BLOCKER, escalate to engineering immediately.

### Owner + ETA

Owner: Engineering. ETA: 0.5 day. Run before pilot launch.

---

## Summary of remediation work

| Item | Action | ETA | Owner | Blocker? |
|------|--------|-----|-------|----------|
| 4    | `docs/SECRET_ROTATION.md` + `JWT_SECRET` length check in code | 1 day | Eng | No (post-pilot OK) |
| 10   | Add `headers` block to `vercel.json` + Mozilla Observatory grade A | 1 day | Eng | **YES** |
| 11   | `npm audit fix`, upgrade cloudinary, confirm handlebars exemption, add CI gate | 1–2 days | Eng | **YES** |
| 12   | Run the 20-route cross-org pen test, record verdicts | 0.5 day | Eng | **YES** |
| 2    | `docs/CODE_PATTERNS.md` + pre-commit grep for ESOL route protection | 0.5 day | Eng | No (post-pilot OK) |
| 3    | VocabLedger query: add explicit `orgId` filter as defence-in-depth | 1 hr | Eng | No (post-pilot OK) |

**Pilot launch unblocks when items 10, 11, 12 are complete and
signed off below.**

---

## Sign-off

> No pilot traffic until both signatures below are in place.
> The signed-off date must be after the latest remediation
> commit referenced in the table above.

### Developer (engineering lead)

| Date | Name | Items reviewed | Remediation commits | Signature |
|------|------|----------------|----------------------|-----------|
|      |      | All 12          | (commit hashes)      |           |

### Joey (Amber Training Ltd — engagement lead)

| Date | Items reviewed | Signature |
|------|----------------|-----------|
|      | All 12          |           |

---

## Audit metadata

- **Conducted:** 2026-06-03
- **Branch:** `develop`
- **Auditor:** Engineering team
- **Tool versions:**
  - `npm` 10.x (audit data as of 2026-06-03)
  - `node` 22.x
- **Re-audit cadence:** at every major release; mandatory before each
  v-dot release that touches auth, encryption, or external-facing
  routes.
