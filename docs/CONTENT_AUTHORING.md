# Content Authoring Tracker — Project Silk v1.0

> Live tracker for every piece of human-authored content that must
> ship before the v1.0 production launch. Engineering has built the
> machinery; this document tracks the words it operates on.
>
> **No content ships to production without the sign-off block at the
> bottom of this document, signed by both Joey and the relevant
> qualified professional.** Engineering will refuse to merge a
> content PR that lands `is_demo: false` data without those
> signatures present in the PR description.

## How to use this tracker

- Update the **status** field as work progresses:
  - `not_started` — nothing in the draft URL yet
  - `in_progress` — drafting underway; the draft URL is live
  - `blocked` — owner has flagged an external dependency (waiting on
    a translator, a safeguarding professional review, etc)
  - `complete` — sign-offs in place and content has landed at the
    production path
- Update the **deadline** field as soon as it slips, with a note in
  the **notes** field explaining why.
- Each content item below links to the production code path that
  consumes it. If you're authoring content and the consuming path
  has changed, talk to engineering before editing.
- The **draft URL** is wherever the author is working — usually a
  Notion or Google Doc, sometimes a markdown file in the repo. When
  content lands at the production path, the draft URL stays in this
  tracker as the editorial history.

---

## Section A — Original brief items

### 1. Layer 1 system prompt — Amber persona and voice

| Field               | Value                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------ |
| **Status**          | `not_started`                                                                              |
| **Owner**           | Joey + ESOL practitioner                                                                   |
| **Deadline**        | TBD — set when the ESOL practitioner is engaged                                            |
| **Draft URL**       | _(none yet)_                                                                               |
| **Production path** | `src/data/system-prompts/layer1-identity.md`                                               |
| **Consumed by**     | AI tutor session worker — wrapped into every Gemini call as the topmost system instruction |

**Notes:**

- Layer 1 is the _who_ — Amber's tone, persona, and voice principles.
  Warm, encouraging, never patronising. ESOL-practitioner review is
  required to catch any accidentally infantilising phrasing.
- One file, English only. The model handles L1 output via the
  scenario-level translations (Section A.4) — Layer 1 is the
  meta-personality the model wears regardless of language.
- Target length: 200–400 words. Anything longer eats the context
  window the scenarios need.

---

### 2. Layer 2 system prompt — hard rules + safeguarding triggers + length caps

| Field               | Value                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| **Status**          | `not_started`                                                                        |
| **Owner**           | Joey + safeguarding professional                                                     |
| **Deadline**        | TBD — must precede _any_ live learner traffic                                        |
| **Draft URL**       | _(none yet)_                                                                         |
| **Production path** | `src/data/system-prompts/layer2-hard-rules.md`                                       |
| **Consumed by**     | AI tutor session worker — second-layer system instruction, applied on top of Layer 1 |

**Notes:**

- Layer 2 is the _must-nots_. Hard refusals (medical advice, legal
  advice, anything safeguarding-relevant gets escalated rather than
  answered). Response length caps. Forbidden topics.
- Safeguarding-professional review is the gating signature here —
  the language used to escalate must align with the platform's
  safeguarding alert pipeline (Function 10) and not pre-empt a
  designated-lead conversation.
- Cross-references the safeguarding keyword bank (A.9) — the layer
  prompt names the categories the keyword bank seeds detect.
- Target length: 400–800 words.

---

### 3. Layer 3 system prompts — level calibration (5 files)

| Field               | Value                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Status**          | `not_started`                                                                                                         |
| **Owner**           | Joey + ESOL practitioner                                                                                              |
| **Deadline**        | TBD — all five files needed before v1.0                                                                               |
| **Draft URL**       | _(none yet)_                                                                                                          |
| **Production path** | `src/data/system-prompts/layer3-level-calibration/` (one file per level: `e1.md`, `e2.md`, `e3.md`, `l1.md`, `l2.md`) |
| **Consumed by**     | AI tutor session worker — third-layer system instruction, selected by the learner's current `esolLevel`               |

**Notes:**

- Each file calibrates the AI's vocabulary, sentence length, and
  grammatical scaffolding to the target NQF level.
- The ESOL practitioner sign-off is critical — a Level-1 prompt that
  accidentally uses Entry-2 grammar will undermine every learner
  outcome that downstream evidence-report depends on.
- Recommend authoring E1 first, then drafting E2–L2 as
  delta-against-E1 to keep the five files consistent.
- Target length: 200–400 words per file.

---

### 4. Scenarios (3 files) — initial scenario bank

| Field               | Value                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **Status**          | `not_started`                                                                            |
| **Owner**           | Joey + ESOL practitioner + qualified translators                                         |
| **Deadline**        | TBD — gates v1.0 launch                                                                  |
| **Draft URL**       | _(none yet)_                                                                             |
| **Production path** | `src/data/scenarios/s1_gp_appointment.json`, `s2_payslip.json`, `s3_housing_rights.json` |
| **Consumed by**     | AI tutor session worker; placement assessment; evidence-report renderer                  |

**Per-scenario requirements:**

- Minimum 20 vocab items per scenario.
- Full translations into all 5 MVP L1s: Arabic, Somali, Dari,
  English (source), Cantonese.
- Cultural notes per L1 — what a Somali speaker should know about a
  UK GP appointment that doesn't map from their country of origin.
- Validates against `npm run validate:scenarios` (engineering owns
  the schema; content owns the words).

**Translation budget:**

- £500 – £1,500 across all three scenarios, sourced through Joey's
  network. Higher end if a single qualified translator covers all
  three; lower if the cost is split per L1.
- **Always commission via qualified translators with ESOL teaching
  context.** A general-purpose translator without ESOL background
  will produce technically correct copy that misses the level
  calibration.

**Notes:**

- Engineering's `validateScenarios` script catches schema errors;
  content reviewers catch meaning errors. Both are required.
- Cultural notes are surfaced to learners on first encounter with
  the scenario — not optional flavour text.

---

### 5. Placement question bank — 80 questions minimum

| Field               | Value                                                        |
| ------------------- | ------------------------------------------------------------ |
| **Status**          | `not_started`                                                |
| **Owner**           | Joey + ESOL practitioner + translators                       |
| **Deadline**        | TBD — gates v1.0 launch                                      |
| **Draft URL**       | _(none yet)_                                                 |
| **Production path** | `src/data/placement-bank.json`                               |
| **Consumed by**     | Placement service (Function 7) — adaptive question selection |

**Notes:**

- Minimum 80 questions to give the adaptive algorithm enough breadth
  to avoid placing two consecutive learners onto the same path.
- Balanced across the five MVP levels (E1–L2) and the four ForSkills
  skill domains (speaking, listening, reading, writing).
- Each question carries its L1 translations alongside the English
  source.
- Validates via `npm run validate:placement-bank` (the engineering
  schema check is the gate; the editorial review is the substance).
- ESOL-practitioner sign-off must explicitly cover **adaptive
  fairness** — no two questions should produce the same result for
  meaningfully different learners.

---

### 6. Safeguarding messages — 30 pre-cached messages

| Field               | Value                                                                           |
| ------------------- | ------------------------------------------------------------------------------- |
| **Status**          | `not_started`                                                                   |
| **Owner**           | Joey + safeguarding professional                                                |
| **Deadline**        | TBD — **required** before live traffic in _any_ org                             |
| **Draft URL**       | _(none yet)_                                                                    |
| **Production path** | `src/data/safeguarding-messages.json`                                           |
| **Consumed by**     | Safeguarding detector (Function 10) — surfaced verbatim when an alert is raised |

**Grid:** 6 categories × 5 languages = 30 messages.

Categories: `self_harm`, `domestic_abuse`, `radicalisation`,
`child_concern`, `exploitation`, `mental_health_crisis`.

Languages: Arabic, Somali, Dari, English, Cantonese.

**Notes:**

- **Every message must be reviewed by the safeguarding professional
  before any production traffic.** A mis-phrased safeguarding message
  is a real-world safety hazard, not a UX issue.
- Each message carries a tested phone-number / website pointer for
  the relevant UK service (Samaritans, Refuge, Prevent, NSPCC, etc).
  The links don't expire on a year boundary, but the safeguarding
  professional confirms each one is still operational at sign-off.
- Validation: `npm run validate:safeguarding-messages` (schema only;
  the substantive review is human).
- Re-review on a quarterly cadence post-launch. New review = new
  sign-off block here.

---

### 7. CSV import templates and instructions

| Field               | Value                                                                              |
| ------------------- | ---------------------------------------------------------------------------------- |
| **Status**          | `not_started`                                                                      |
| **Owner**           | Joey                                                                               |
| **Deadline**        | TBD — gates org-admin onboarding                                                   |
| **Draft URL**       | _(none yet)_                                                                       |
| **Production path** | `src/data/csv-templates/` + accompanying section in `docs/ORG_ADMIN_ONBOARDING.md` |
| **Consumed by**     | Bulk-import flow (Function 3 / Phase 6.1)                                          |

**Notes:**

- CSV templates: `learners.csv`, `forskills.csv`,
  `pre-platform-sessions.csv` (one per import flow on the org-admin
  dashboard).
- Each template carries a single example row + comment header
  documenting required vs optional columns.
- Pair the templates with plain-English instructions in the org-admin
  onboarding doc explaining how to populate from a typical college
  MIS export.
- No translator involvement — this is org-admin-facing in English.

---

## Section B — Addendum additions

### 8. Teacher message templates [ADDENDUM]

| Field               | Value                                                                               |
| ------------------- | ----------------------------------------------------------------------------------- |
| **Status**          | `not_started`                                                                       |
| **Owner**           | Joey + ESOL practitioner                                                            |
| **Deadline**        | TBD — gates Phase 24 launch                                                         |
| **Draft URL**       | _(none yet)_                                                                        |
| **Production path** | `src/data/teacher-message-templates.json`                                           |
| **Consumed by**     | Phase 24 teacher messaging flow + the re-engagement cron (dormant-learner outreach) |

**Categories:**

- `re_engagement` — learner has been inactive 14+ days, teacher
  reaches out
- `encouragement` — milestone reached, teacher acknowledges
- `pathway_change` — Stage 3 objectives have been edited, teacher
  explains why

**Languages:** all 5 MVP L1s (Arabic, Somali, Dari, English,
Cantonese), with each template carrying placeholder tokens for the
learner's first name, the teacher's first name, and (where relevant)
the level / objective being referenced.

**Notes:**

- ESOL-practitioner review is needed to keep the templates
  consistent with the AI tutor's voice — a teacher message that
  reads in a sharply different register from the AI tutor confuses
  the learner.
- Templates are NOT auto-sent: the teacher reviews and personalises
  in the messaging UI before send. The template gives the teacher a
  starting point.

---

### 9. Safeguarding keyword bank seeds [ADDENDUM]

| Field               | Value                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Status**          | `not_started`                                                                                                |
| **Owner**           | Joey + safeguarding professional                                                                             |
| **Deadline**        | TBD — **must precede live learner traffic**                                                                  |
| **Draft URL**       | _(none yet)_                                                                                                 |
| **Production path** | `src/scripts/seedSafeguardingKeywords.ts` populates the `safeguarding_keywords` Mongo collection (Phase 1.F) |
| **Consumed by**     | Safeguarding detector (Function 10) — substring / regex match against learner turns + teacher messages       |

**Languages:**

- **English first** — the literal v1.0 launch is English-only
  detection. Joey + safeguarding professional sign off the English
  bank before any production traffic.
- **Other languages added incrementally** as the safeguarding
  professional reviews each. Until a language is signed off, learner
  turns in that language are still safe — the AI tutor itself
  refuses on the topics, and the detector falls back to category-level
  context (e.g. a turn talking about self-harm in Arabic still
  triggers via the AI tutor's own safeguarding flag, just not via
  keyword match).

**Notes:**

- Keyword bank is intentionally conservative — false positives are
  acceptable, false negatives are not. The DSL workflow then has the
  judgement call on whether the alert is genuine.
- Quarterly re-review post-launch, with re-signing here.

---

### 10. Compliance Config seeds [ADDENDUM]

| Field               | Value                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| **Status**          | `not_started`                                                                                         |
| **Owner**           | Joey (compliance lead)                                                                                |
| **Deadline**        | TBD — gates the first real ILR export                                                                 |
| **Draft URL**       | _(none yet)_                                                                                          |
| **Production path** | `src/scripts/seedComplianceConfig.ts` populates the `compliance_configs` Mongo collection (Phase 1.E) |
| **Consumed by**     | ILR export pipeline (Function 13); RARPA evidence pipeline (Function 14); ASF postcode router         |

**Three domains × current academic year:**

- `ilr` / `2025/26` — ESFA ILR field mappings, valid value lists,
  breaking-change handlers (SOF code 19 routing, EnglishProgType,
  SOC2000 → SOC, LLDDT code 15 expired). All four documented in the
  breaking-change handler implementation.
- `rarpa` / `2025/26` — Stage 1–5 evaluation rules, threshold
  values, evidence-report aggregation policy.
- `asf-routing` / `2025/26` — postcode-to-MCA routing table sourced
  from the DfE ASF dataset.

**Notes:**

- This is the only Section B item Joey owns solo — it's
  configuration data, not narrative content, and the technical
  accuracy is verifiable against the published ESFA spec rather
  than requiring a separate professional review.
- Engineering's `verifyComplianceCache.ts` script can be run against
  the seeded data to confirm every required rule is present —
  treating it as part of the sign-off checklist below.
- Annual renewal: at 1 August every year, the next academic year's
  seed needs to be authored and activated via the
  `/admin/compliance-config` editor (Final Addendum §3). Tracked
  separately in the operations calendar.

---

## Sign-off block

**No content item above ships to production with `is_demo: false`
without the signatures below. Sign-offs are scoped: a signature on
this document covers only the items the signatory's role requires.**

### Joey (Amber Training Ltd — engagement lead)

Joey's signature is required on **every** content item in this
document. Joey is the final accountability holder for content
quality and compliance fitness.

| Date | Items signed off | Signature |
| ---- | ---------------- | --------- |
|      |                  |           |
|      |                  |           |
|      |                  |           |

### ESOL practitioner (qualified ESOL teacher, NQF Level 3+ ESOL qualification)

Required sign-off for **content items A.1, A.3, A.4, A.5, B.8** —
anything where the words go in front of a learner.

| Date | Practitioner name | Items signed off | Signature |
| ---- | ----------------- | ---------------- | --------- |
|      |                   |                  |           |
|      |                   |                  |           |

### Safeguarding professional (DSL or equivalent)

Required sign-off for **content items A.2, A.6, B.9** — the layer-2
hard rules, the safeguarding pre-cached messages, and the keyword
bank seeds.

| Date | Professional name | Items signed off | Signature |
| ---- | ----------------- | ---------------- | --------- |
|      |                   |                  |           |
|      |                   |                  |           |

### Qualified translators (one per L1)

Required sign-off for the L1-specific portion of **A.4, A.5, A.6,
B.8, B.9** — every set of translated strings must be signed off by a
qualified translator in the target language with ESOL teaching
context.

| Date | Translator name | Language(s) | Items signed off | Signature |
| ---- | --------------- | ----------- | ---------------- | --------- |
|      |                 |             |                  |           |
|      |                 |             |                  |           |
|      |                 |             |                  |           |
|      |                 |             |                  |           |
|      |                 |             |                  |           |

---

## Out-of-scope (tracked elsewhere)

The following are _not_ tracked here because they're either
engineering-owned or covered by a separate process:

- **Demo seed fixture** — covered in `docs/DEMO_ENVIRONMENT.md` and
  `src/scripts/seedDemoEnvironment.ts`. Demo learners and demo orgs
  are deliberately fictional and don't need professional sign-off.
- **Frontend UI strings** — owned by engineering; live in the React
  components. Localisation for the Stage 5 self-assessment is in
  `src/modules/esol/lib/stage5/translations.ts` and is flagged for
  native-speaker review in that file's header.
- **Email templates** — Handlebars files in
  `src/services/nodemailer/templates/` are engineering-owned shells;
  the L1 message text inside them comes from items A.6 and B.8 here.
- **Compliance breaking-change handlers** — code paths owned by
  engineering; the rules they implement come from item B.10 above.

---

## Change log for this document

| Date      | Change                                                             | By          |
| --------- | ------------------------------------------------------------------ | ----------- |
| (initial) | Document created from Function 17 brief + Final Addendum additions | Engineering |
