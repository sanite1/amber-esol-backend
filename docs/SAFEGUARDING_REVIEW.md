# Safeguarding-Messages Review Protocol

**Status:** Required before launch. Required again on any content change.
**Owner:** Joey (curriculum lead).
**Counter-signer:** Independent safeguarding professional (NSPCC, Samaritans, or equivalent).
**Acceptance gate:** Function 10 To-Do 1 (brief).

`src/data/safeguarding-messages.json` holds 30 pre-cached replies — 6
safeguarding categories × 5 MVP languages — that the AI tutor serves
**instead of calling Gemini** when a learner discloses harm. These
messages are the most consequential text the platform will ever send
to a learner: they go out in moments of crisis, often to people whose
English is rudimentary, often in seconds after disclosure.

A poorly-worded pre-cache reply can:

- Escalate distress (over-clinical wording, mis-pitched warmth)
- Mis-signpost (wrong helpline for the category)
- Confuse (translation that loses the meaning)
- Re-traumatise (probing language, despite the rule against it)

This protocol exists to make sure that doesn't happen.

---

## Workflow at a glance

```
1. Joey drafts English content (current state)
2. Independent safeguarding professional reviews English drafts
3. Native-speaker translators translate v2 into ar / so / fa / zh
4. Same safeguarding professional reviews the translated set
5. Sign-off + version bump
6. Commit + `npm run validate:safeguarding-messages` → exit 0
```

Each step gates the next. Do not start step N+1 until step N has
signed off.

---

## Step 1 — English drafts (current state)

`src/data/safeguarding-messages.json` ships with English drafts for
all six categories. Joey wrote these against the brief's signposting
spec; they are **starting drafts**, not approved content.

Format rules baked into every message:

- **Warm acknowledgement** ("Thank you for telling me…") — never
  shock, never silence.
- **No probing questions.** The disclosure is the learner's; we don't
  fish for detail.
- **Single helpline per category** — per the brief, more helplines
  = decision fatigue in a crisis. The signposting per category:

| Category               | Signposting                                                                |
| ---------------------- | -------------------------------------------------------------------------- |
| `self_harm`            | Samaritans 116 123 (24/7); text SHOUT to 85258                             |
| `domestic_abuse`       | National Domestic Abuse Helpline 0808 2000 247                             |
| `radicalisation`       | **No external signposting** — "I've made a note, someone will be in touch" |
| `child_concern`        | NSPCC 0808 800 5000                                                        |
| `exploitation`         | Modern Slavery Helpline 08000 121 700                                      |
| `mental_health_crisis` | NHS 111 (option 2); text SHOUT 85258                                       |

- **Offer of continuity.** Every message ends with "I'm here when
  you're ready" or similar — the learner stays in control of what
  happens next.

The `radicalisation` message is **deliberately** the only one without
a direct external phone number. Per Prevent duty guidance, direct
helpline signposting in a learner-facing tool can be
counterproductive — the DSL (Designated Safeguarding Lead) handles
the referral via the alert that fires alongside this reply. The
message's job is to land softly without confrontation while the
backend flow picks up.

---

## Step 2 — Safeguarding professional reviews English

**Who:** A qualified safeguarding professional independent of Amber.

**Recruitment:** Contact one of:

- **NSPCC** safeguarding consultancy — `helpline@nspcc.org.uk` for a
  referral to their consultancy service
- **Samaritans** training team — `training@samaritans.org` for a
  professional reviewer
- A local-authority Designated Safeguarding Officer (DSO) via your
  partner FE college's safeguarding lead

NSPCC consultancy rates are public on their website; budget
~£500–£1,000 for a structured review of all six categories.

**What the reviewer checks (per message):**

- **Warmth without performativity.** "Thank you for telling me" yes;
  "I'm so sorry to hear that" no (over-sympathy can read as
  performative under translation).
- **Reading level.** Target ESOL Entry 2 — every word in the message
  should be familiar to a learner who has been in the UK 6 months.
  A reviewer skilled in plain-language work will spot register
  problems (passive voice, polysyllabic alternatives where simple
  ones exist).
- **Signposting accuracy.** Numbers correct, hours correct, language
  about cost ("free from any UK phone") accurate.
- **No probing.** Pre-cache replies must never ask the learner to
  describe what happened, name a person, or quantify how often. The
  reviewer flags any such phrasing.
- **Cultural neutrality.** "Your husband" assumes marriage; "police"
  has different connotations in different countries — the reviewer
  flags terms that might be alienating across the MVP language
  populations.
- **Crisis-appropriate.** A learner reading this is in distress. The
  message has to land in one read, not require interpretation.

**Output:** Annotated PDF / doc with line-by-line suggestions. Joey
revises the JSON. Bump `authoring.version` (when present) to
`2-en-reviewed`.

---

## Step 3 — Translators translate

**Who:** Four translators — one per non-English MVP language.
**Never machine translation.** Crisis-language MT failures are not
recoverable.

**Recruitment:** Source via:

- The NSPCC consultancy if they have a translator network (they do
  for some languages)
- Refugee Council translator panel — pre-vetted for community ESOL
  context
- Translators Without Borders specialist humanitarian register
- Per-language community organisations (Hong Kong Forum for
  Cantonese, etc.)

**Budget:** £150–£300 per language for 6 messages. ~£800–£1,200
total. Pay a premium for the safeguarding domain — translators with
crisis-line experience exist; ordinary translators often soften the
register in ways that lose the crisis-readiness.

**Brief for each translator:**

- Translate **meaning**, not literal text. "Thank you for telling me"
  in Somali should be what a Somali-speaking crisis-line operator
  would say to begin a call.
- **Preserve the UK helpline numbers verbatim** — they're the same
  call regardless of language.
- **Preserve the offer of continuity** — the closing "I'm here when
  you're ready" is the part that gives the learner agency.
- The `radicalisation` message must stay neutral in tone — no
  language that signals judgement or alarm.

**Output:** Filled-out copy of the JSON with all `ar / so / fa / zh`
fields populated.

---

## Step 4 — Safeguarding professional reviews translated set

Same reviewer as step 2. Lighter pass focused on:

- Did the translators preserve the signposting (numbers correct, no
  added "alternative" helplines)?
- Did anything shift in tone — softer / harsher / more clinical —
  between English and the target language?
- Spot-checks per language where the reviewer can read the language
  themselves (typically Arabic or Somali via the NSPCC network).

For languages the reviewer can't read, they sign off on structural
integrity (every message present, plausible length, no obvious
copy-paste of English). The translator's credentials carry the
linguistic-quality weight.

**Budget:** ~£200 for the review (≈ 2 hours).

---

## Step 5 — Sign-off

Both parties counter-sign:

- **Joey** confirms the content workflow was followed and translators
  - reviewer were engaged + paid.
- **Safeguarding professional** confirms in writing that the messages
  are fit for use with adult ESOL learners disclosing safeguarding
  concerns.

Signed PDF filed at
`compliance/safeguarding-messages-signoff-v1.0.pdf`.

Until both signatures are on file, the safeguarding pre-cache path
serves the legacy English-only fallback (`PRECACHED_SAFEGUARDING_REPLY`
in `src/services/geminiAI.service.ts`), NOT the per-language
messages. This is enforced by feature flag — once sign-off lands, the
flag flips and the per-language messages go live.

---

## Step 6 — Commit + validate

```bash
git add src/data/safeguarding-messages.json
npm run validate:safeguarding-messages   # MUST exit 0
git commit -m "safeguarding: v1.0 — professional-signed"
```

The validator MUST exit 0 (zero errors). It will likely emit
warnings about translated messages being identical to English on
edge cases the translator left intentionally untranslated (e.g.
"SHOUT" is a brand name) — review these and confirm they're
intentional before merge.

CI gates the merge on `npm run validate:safeguarding-messages`
exiting 0 across the full file.

---

## When this protocol re-runs

- **Bank version bump.** Any material change to a message restarts at
  step 2.
- **Helpline change.** If a helpline number, hours, or operating
  charity changes, restart at step 2 for the affected category. The
  validator's signposting heuristic flags a removed expected string,
  but doesn't replace the review — phone numbers are the
  signposting; the review confirms the wording around them.
- **New language.** Adding a language (Pashto?) restarts at step 3
  for the new language, then step 4 spot-checks it. English doesn't
  need re-reviewing.
- **Annual review.** Even with no changes, re-run a lightweight
  step 4 review every 12 months — helpline numbers and operating
  hours do change.

---

## Naming reconciliation (engineering follow-up)

The brief's category list in this file uses `child_concern`. Other
parts of the codebase use `child_protection`:

- `src/utils/geminiOutputValidator.ts` (Zod enum)
- `src/interfaces/auditLog.interface.ts` (AuditAction-adjacent)
- `src/models/SafeguardingKeyword.ts` (category enum)
- `src/services/aiSession.service.ts` (recordSafeguardingTrigger
  severity mapping)

These need reconciling before the per-language pre-cache goes live.
The current pre-cache path uses the legacy English-only fallback so
the inconsistency doesn't ship to production yet, but the
look-up-by-category code path needs to know which name is canonical.

**Recommendation:** Adopt `child_concern` from this file as the
canonical name (matches the brief), update the other four locations,
update the safeguarding keyword seed in `seedSafeguardingKeywords.ts`.
One-PR rename. Track as a separate ticket from the content review.

---

## Appendix — What the validator checks

`npm run validate:safeguarding-messages`:

**Errors (block CI):**

- Missing category
- Missing language within a category
- Empty / non-string message value

**Warnings (don't block):**

- TODO / REPLACE markers in any value
- English message under 80 chars (likely a stub)
- English message doesn't reference the expected signposting for
  its category
- Translated message identical to English (likely a paste error
  during translation)
- Unknown top-level keys (Joey may have added metadata)
