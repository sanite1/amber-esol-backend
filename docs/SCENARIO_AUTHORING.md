# Scenario Authoring Workflow

**Owner:** Joey (curriculum lead)
**Counter-signer:** ESOL practitioner (independent, NATECLA-referred)
**Acceptance gate:** Function 7 To-Do 2 (brief)

The three MVP scenarios — GP appointment, Payslip, Housing rights —
are the live English content the AI tutor (Amber) drives every learner
session against. Authoring them is **content work, not engineering**.
This doc defines the workflow so the content lands at the right
quality before integration.

The schema and validator are the engineering side of this:

- Schema: `src/interfaces/scenario.interface.ts`
- Shell files: `src/data/scenarios/{s1,s2,s3}_*.json`
- Validator: `npm run validate:scenarios`

The validator catches structural problems (missing translations,
under-sized vocabulary, malformed thresholds) but cannot judge
**quality**. That's what the human review steps below are for.

---

## Workflow at a glance

```
1. English author writes v0.1     →    Joey
2. ESOL practitioner reviews       →    independent practitioner
3. Translators translate v0.2      →    one per non-English language
4. ESOL practitioner reviews v0.3  →    same practitioner
5. Sign-off + version bump to 1.0  →    Joey + practitioner
6. Commit to main + run validator  →    Joey
```

Each step is gated — do not start step N+1 until step N has signed
off. Cutting corners here lands as bad first-session experiences for
real learners, and the cost of fixing a bad scenario after launch is
much higher than the cost of one extra review round.

---

## Step 1 — English author writes v0.1

**Who:** Joey, working from the shell file in `src/data/scenarios/`.

**What goes into each field:**

| Field                      | Source                      | Notes                                                                                                |
| -------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `scenario_id`              | already populated           | Must match the filename                                                                              |
| `title.en`                 | starting draft populated    | Joey may refine wording                                                                              |
| `nqf_level_range`          | already populated per brief | Don't widen without practitioner approval                                                            |
| `skill_codes`              | already populated per brief | The 9 ILR Skills for Life sub-codes — see `src/services/esolSkills.ts`                               |
| `stage3_objective_domains` | populated                   | Maps to the four ForSkills domains the scenario produces evidence for                                |
| `vocabulary_set`           | Joey writes                 | See §1.1 below                                                                                       |
| `grammar_targets`          | Joey writes                 | 3–5 items; match the level range                                                                     |
| `roleplay_prompt_en`       | Joey writes                 | 2–4 sentences telling Amber what role she's playing and what the learner needs to do                 |
| `pass_threshold`           | Joey sets                   | 0.6–0.9; default 0.7. Higher for assessment-prep scenarios, lower for early-confidence-building ones |
| `cultural_notes_en`        | Joey writes                 | 3–5 sentences of UK-context the learner needs (NHS, PAYE, AST tenancy etc.)                          |

### 1.1 The vocabulary set

The validator requires **≥ 20 items per scenario**. Each item has:

```json
{
  "word": "appointment",
  "definition_en": "A planned time to see someone, like a doctor.",
  "translations": { "ar": "…", "so": "…", "fa": "…", "zh": "…" },
  "example_sentence": "I have an appointment with the doctor at three o'clock.",
  "reinforcement_weight": 1.0
}
```

`reinforcement_weight` tells the AI tutor how often to weave this word
back into dialogue:

- **1.0** — core item; must appear in ≥ 2 turns of a typical session
- **0.5** — secondary item; appears 1 turn if conversation permits
- **0.0** — passive item; only counted if the **learner** uses it

Target distribution:

- 5–8 items at weight 1.0 (the core vocabulary)
- 8–12 items at weight 0.5 (supporting vocabulary)
- 2–5 items at weight 0.0 (advanced terms the learner may or may not
  encounter; we want to reward usage but not push it)

### 1.2 What to AVOID at this stage

- Don't write translations yet — that's step 3. Leave `translations`
  empty for now. The validator will flag them; that's fine, you're
  not at sign-off yet.
- Don't speculate about cultural notes in non-English languages —
  same reason. `cultural_notes_ar/so/fa/zh` stay empty until step 3.
- Don't tune `pass_threshold` to "feel right" — calibration comes
  from real session data after launch. 0.7 is the right default
  unless you have a specific reason.

**Output:** v0.1 draft in the JSON file. Bump `authoring.version`
to `"0.1-draft"`. Commit on a feature branch.

---

## Step 2 — ESOL practitioner review (level + content)

**Who:** A qualified ESOL practitioner, independent of Amber Training.

**Recruitment:** Email NATECLA (`info@natecla.org.uk`) — the same
contact used for the placement calibration. Ask for a referral to a
practitioner who holds CELTA / DELTA / DipTESOL or equivalent and has
taught at the level range the scenario covers.

**Budget:** £300–£500 per scenario for the level review (one session,
~2 hours per scenario including the follow-up call). Confirm in
writing before the work starts.

**What the practitioner checks:**

- Is the vocabulary appropriate for the declared level range?
  - Too easy → learner is bored; too hard → learner shuts down.
- Are the grammar targets correctly scoped?
- Does the roleplay prompt set up a realistic UK situation?
- Does it avoid culturally-specific knowledge the learner may not
  have (e.g. mentioning supermarket brands learners might not
  recognise)?
- Are the cultural notes accurate and non-judgemental?
  - "If the landlord refuses to fix the boiler, you can contact
    Shelter" → fine.
  - "If your landlord is unhelpful, that is normal in some areas" →
    not fine. Doesn't equip the learner; reinforces stereotypes.

**Output:** annotated PDF or doc with line-by-line suggestions. Joey
revises the JSON. Bump version to `"0.2-practitioner-reviewed"`.

---

## Step 3 — Translators translate

**Who:** Four translators — one per non-English MVP language. **Never
machine translation** for the bank itself; machine output can be a
helpful starting point for a _human_ translator to revise, but the
file must contain human-revised content.

**Recruitment:** Source translators via:

- NATECLA's translator network (preferred — they pre-vet for ESOL
  context)
- Refugee Council (Arabic, Somali, Dari — community-rooted)
- Hong Kong Forum / Hongkongers in Britain (Cantonese / Traditional
  Chinese)
- Translators Without Borders (specialist humanitarian register)

**Budget:** £500–£1,500 across the three scenarios per language,
depending on translator rate and vocabulary volume. Realistic
ranges:

- £150–£500 per scenario per language (60 vocabulary items + title +
  cultural notes ≈ 600–900 words including the example sentences)
- Cantonese (Traditional) tends to be at the higher end of the range
  because there are fewer translators with ESOL/community experience
- Pay above the per-word rate for the cultural-notes section — the
  translator is often **localising**, not literally translating
  (e.g. "Universal Credit (housing element)" needs context the
  source English doesn't carry)

**Brief for each translator:**

- Translate `title`, `cultural_notes`, every `translations` entry on
  the vocabulary items, and the L1 portions of `example_sentence` IF
  the source contains L1 hints (most don't — keep example sentences
  in English).
- **Translate meaning, not literally.** "Tenancy" in Arabic should be
  the word a real Arabic-speaking tenant in the UK would use, not
  the dictionary-perfect translation of "the legal right to live in
  a property".
- Cultural notes need the most care. The English source assumes a
  specific UK context; the translator may need to expand or
  contract the explanation depending on how much of that context
  the target audience already shares.
- Output: a filled-out copy of the JSON file. Validator-friendly.

**Output:** v0.3 with all `translations` and `cultural_notes_*`
fields populated. Bump version to `"0.3-translated"`.

---

## Step 4 — ESOL practitioner reviews v0.3

Same practitioner as step 2. Lighter review focused on:

- Did the translators preserve the level appropriateness?
- Did anything cultural shift in translation that the English doesn't
  flag?
- Spot-checks on 5–10 vocabulary entries per language against the
  English definition.

The practitioner can read at least one of the four target languages
themselves (typical: Arabic OR Somali). For the languages they can't
read, they sign off on the structural integrity (presence of
translations, plausible length, no obviously copy-pasted blocks)
rather than the linguistic quality. That's why the recruitment in
step 3 matters — we trust the translator on linguistic quality
because the practitioner can't independently verify it.

**Budget:** £100–£200 per scenario for this lighter review (one hour).

**Output:** any final tweaks. Bump version to `"0.4-reviewed"`.

---

## Step 5 — Sign-off

Both parties counter-sign:

- **Joey** confirms the English content is right and the translators
  - practitioner were paid + the workflow was followed.
- **ESOL practitioner** confirms the scenario is fit for launch use
  in their professional judgement.

Populate `authoring`:

```json
{
  "authoring": {
    "version": "1.0",
    "english_author": "Joey (Amber Training)",
    "translators": {
      "ar": "Translator name, agency",
      "so": "Translator name, agency",
      "fa": "Translator name, agency",
      "zh": "Translator name, agency"
    },
    "esol_practitioner_reviewer": "Practitioner name, qualification",
    "signed_off_at": "2026-08-15"
  }
}
```

Signed PDF filed at `compliance/scenario-signoff-{scenario_id}-v1.0.pdf`.

---

## Step 6 — Commit + validate

```bash
git add src/data/scenarios/*.json
npm run validate:scenarios   # MUST exit 0
git commit -m "scenario(s1_gp_appointment): v1.0 — practitioner-signed"
```

The validator MUST exit 0 (zero errors). Warnings about TODO markers
in any remaining placeholder content are acceptable while OTHER
scenarios are still in earlier steps, but a scenario being promoted
to v1.0 cannot itself carry TODO markers.

CI gates the merge to `main` on `npm run validate:scenarios` exiting
0 across all files.

---

## Budget summary

Realistic launch cost for all three scenarios:

| Step                               | Per scenario      | Across 3 scenarios |
| ---------------------------------- | ----------------- | ------------------ |
| 1. English authoring               | (Joey's time)     | —                  |
| 2. Practitioner level review       | £300–£500         | £900–£1,500        |
| 3. Translation (4 languages)       | £600–£2,000       | £1,800–£6,000      |
| 4. Practitioner translation review | £100–£200         | £300–£600          |
| 5. Sign-off                        | (admin time)      | —                  |
| **Total**                          | **£1,000–£2,700** | **£3,000–£8,100**  |

The brief's "£500–£1,500 across 3 scenarios" target is achievable at
the low end if translators are sourced through community networks
(Refugee Council, Hong Kong Forum) rather than commercial agencies.
The high end reflects commercial-agency rates if community sourcing
falls through.

---

## What to do if step 2 or 4 says "this isn't ready"

Don't ship it. Loop back to the failing step:

- **Level too high/low** → revise vocabulary set, possibly the
  level range itself if the brief misjudged the scope.
- **Cultural inaccuracy** → rewrite the affected section; cultural
  notes are the single most common revision point.
- **Translation quality concern** → engage a second translator for
  spot-check on the disputed language. If the second translator
  agrees with the practitioner's concern, replace the first
  translator's work for that language.

The version number in `authoring.version` tracks where you are in
the loop. A scenario can be at `0.2-practitioner-reviewed` for the
second time after a level-revision pass — note this in the commit
message and the sign-off PDF.
