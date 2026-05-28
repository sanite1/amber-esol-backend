# Project Silk — Compliance Gate

Section 0 of the brief is the legal/operational gate that must close before any **real learner data** can flow through production. Dev work with fictional data may proceed in parallel.

> **GATE CONDITION (non-negotiable)**
> No production deployment that processes real learner data goes live until every task marked _**production-blocker**_ below is `Complete`.

Update statuses by editing the task blocks. Use:
- `Pending` — not started
- `In Progress` — started, awaiting external response, mid-document, etc.
- `Complete` — fully closed, evidence filed

Last updated: 2026-05-27 (initial creation)

---

## Status summary

| # | Task                                  | Owner   | Status     | Blocks                                       |
|---|---------------------------------------|---------|------------|----------------------------------------------|
| 1 | ICO registration                      | Joey    | Pending    | Any real learner data processing             |
| 2 | UKPRN application                     | Joey    | Pending    | ILR submission (Function 13); G-Cloud listing |
| 3 | Google Cloud Vertex AI DPA            | Joey    | Pending    | Any real Gemini call (production)            |
| 4 | DPIA 1 — D1 onboarding data           | Joey    | Pending    | Production launch                            |
| 5 | DPIA 2 — D2 AI session data           | Joey    | Pending    | Production launch                            |
| 6 | Privacy notice                        | Joey    | Pending    | Registration screen goes live                |
| 7 | Cyber Essentials certification        | Joey    | Pending    | G-Cloud Lot 2b listing (Horizon 3, not MVP)  |
| 8 | Insurance (£5M PL + £1M PI minimum)   | Joey    | Pending    | G-Cloud listing                              |
| 9 | SEIS advance assurance                | Joey    | Pending    | Investor conversations (not platform launch) |
| 10 | WCAG 2.1 AA agreement                | Joey + Dev | Pending | Frontend launch with real learners           |

---

## 1. ICO registration

- **Owner**: Joey
- **Status**: `Pending`
- **Blocks**: Any real learner data processing — strict UK GDPR requirement
- **Link**: <https://ico.org.uk/registration/new>
- **Cost**: £40/year
- **Target**: Week 1 of build

**Actions**
- [ ] Open the ICO new-registration form
- [ ] Select **"Training and education"** as the processing purpose
- [ ] Complete the registration form for Amber Training Ltd
- [ ] Pay the £40 annual fee
- [ ] Save the confirmation email
- [ ] Record the ICO registration number — store in `AMBER_ICO_NUMBER` env var (add to `.env.example` when received)

**Notes**
- Registration is a legal precondition. Without it, processing personal data is a notifiable offence.
- Renew annually.

---

## 2. UKPRN application

- **Owner**: Joey
- **Status**: `Pending`
- **Blocks**:
  - ILR submission (Function 13) — production launch with real learners
  - Direct ASF funding claims (Horizon 3)
  - G-Cloud Lot 2b listing
- **Link**: <https://www.ukrlp.co.uk>
- **Cost**: Free
- **ETA from submission**: 2–4 weeks

**Actions**
- [ ] Register Amber Training Ltd at ukrlp.co.uk
- [ ] Receive UKPRN by email
- [ ] Set `AMBER_UKPRN` in `.env` and Vercel env vars
- [ ] Confirm UKPRN renders correctly in test ILR export header row

**Notes**
- Clock starts on application, not approval. Submit on Day 1.
- The ILR export validator in Phase 14 should warn loudly if `AMBER_UKPRN` is unset.

---

## 3. Google Cloud Vertex AI DPA

- **Owner**: Joey (with dev review of Appendix 3)
- **Status**: `Pending`
- **Blocks**: Any real Gemini call (production)
- **Link**: <https://cloud.google.com/terms/data-processing-addendum>

**Actions**
- [ ] Review the Google Cloud DPA
- [ ] Verify UK GDPR (retained EU law) is named in the Definitions section
- [ ] Contact Google legal to confirm:
  - DPA 2018 (UK domestic Act) is covered
  - Special category data handling is addressed in Appendix 3
- [ ] Accept the DPA terms in the Google Cloud console: **IAM and Admin → Privacy**
- [ ] Save a signed PDF copy of the accepted DPA in the compliance archive

**Notes**
- Must use **Vertex AI** (`europe-west4`), NOT the free-tier Gemini API at `ai.google.dev`.
- Vertex AI commits in writing: _"Google will not use Customer Data to train or fine-tune any AI/ML models without Customer's prior permission or instruction."_
- Google Search Grounding retains data for 30 days — **do NOT enable** that feature.

---

## 4. DPIA 1 — D1 onboarding data

- **Owner**: Joey
- **Status**: `Pending`
- **Blocks**: Production launch
- **Link**: ICO DPIA guidance — <https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/accountability-and-governance/guide-to-accountability-and-governance/data-protection-impact-assessments-dpias/>

**Scope**: name, date of birth, nationality, postcode (`postcode_prior`), employment status, LLDD status, eligibility declaration.

**Actions**
- [ ] Document the data fields collected at D1 onboarding
- [ ] Legal basis: **Article 6(1)(f) UK GDPR — legitimate interests** (providers' legitimate interest in submitting accurate ILR data)
- [ ] Document who has access (org_admin, Amber admin, learner themselves)
- [ ] Document retention: **6 years minimum** (ASF audit requirement — overrides right-to-erasure)
- [ ] Document risk register and mitigations
- [ ] Sign the DPIA
- [ ] File in `/docs/compliance/` (off-repo if it contains identifying detail)

---

## 5. DPIA 2 — D2 AI session data

- **Owner**: Joey
- **Status**: `Pending`
- **Blocks**: Production launch
- **Link**: ICO DPIA guidance (as above)

**Scope**: learner chat messages, scenario interactions, safeguarding triggers, session logs. Key risk: messages may contain unsolicited sensitive personal disclosures.

**Actions**
- [ ] Document the data flow (learner → Gemini via Vertex AI in europe-west4 → response)
- [ ] Document mitigations:
  - EU data residency (`europe-west4`, Netherlands)
  - Signed Google DPA (Task 3)
  - No-training commitment
  - Pre-cached safeguarding responses (Phase 1.F — patterns scan happens BEFORE Gemini call)
  - Safeguarding alerts store SHA-256 hash, never raw message content
- [ ] Note: London (`europe-west2`) is NOT operational for Gemini 2.5 Flash — must be europe-west4
- [ ] Note: Google Search Grounding retains for 30 days — explicitly NOT enabled
- [ ] Sign the DPIA
- [ ] File alongside DPIA 1

---

## 6. Privacy notice

- **Owner**: Joey
- **Status**: `Pending`
- **Blocks**: Registration screen going live (D1 wizard)
- **Link**: ICO privacy notice generator — <https://ico.org.uk/for-organisations/make-your-own-privacy-notice/>

**Actions**
- [ ] Draft via the ICO generator
- [ ] Cover key points:
  - ILR submission to ESFA
  - Vertex AI named as a data processor
  - 6-year retention for ASF audit (and its impact on right-to-erasure)
  - ULN verification via DfE Learning Records Service
  - Safeguarding alert process and recipients
- [ ] Publish at `esol.ambertraining.co.uk/privacy`
- [ ] Link from D1 onboarding wizard step 1 (before learner enters any personal data)
- [ ] Translate to all 5 MVP languages (Arabic, Somali, Dari, Cantonese, English) — same translator engagement as scenario translation

---

## 7. Cyber Essentials certification

- **Owner**: Joey (with dev support for the technical questionnaire)
- **Status**: `Pending`
- **Blocks**: G-Cloud Lot 2b (SaaS) listing — Horizon 3 (not MVP launch)
- **Links**:
  - <https://www.ncsc.gov.uk/cyberessentials/overview>
  - IASME (most common certification body for SMEs): <https://iasme.co.uk>
- **Cost**: ~£300–£500
- **Validity**: 12 months — must be renewed annually

**Actions**
- [ ] Choose certification body (IASME recommended)
- [ ] Complete the self-assessment questionnaire (dev assists with the technical sections)
- [ ] Submit for assessment
- [ ] Pay the certification fee
- [ ] Receive certificate
- [ ] Diarise renewal

**Notes**
- **Cyber Essentials** (not Plus) is sufficient for G-Cloud Lot 2b.
- G-Cloud 15 application window closed January 2026. Next window ~March 2028. Start certification now so it's ready when the window opens.

---

## 8. Insurance — £5M PL + £1M PI minimum

- **Owner**: Joey
- **Status**: `Pending`
- **Blocks**: G-Cloud listing
- **Current insurer**: Simply Business (from existing Amber Training setup — confirm)

**Required levels**:
- Public Liability: **minimum £5 million**
- Professional Indemnity: **minimum £1 million** (£2M preferred)

**Actions**
- [ ] Confirm current policy limits with Simply Business
- [ ] If below threshold: increase to required levels
- [ ] Obtain certificate of insurance for the G-Cloud application package
- [ ] Diarise renewal

---

## 9. SEIS advance assurance

- **Owner**: Joey
- **Status**: `Pending`
- **Blocks**: Nothing on the platform — enables investor conversations only
- **Link**: <https://www.gov.uk/guidance/apply-for-seis-or-eis-advance-assurance>
- **Cost**: Free
- **ETA**: 4–6 weeks

**Actions**
- [ ] Complete HMRC form SEIS1 (advance assurance application)
- [ ] Submit by post or email to HMRC SITR Team, Cardiff
- [ ] Receive advance assurance letter from HMRC
- [ ] Use in investor pitch deck appendix

**Notes**
- Advance assurance lets angel investors claim 50% income tax relief on their investment — typically the difference between an angel saying yes or no at this stage.
- Apply this month so it's ready before the first serious investor conversation.

---

## 10. WCAG 2.1 AA accessibility agreement

- **Owner**: Joey + Dev (joint)
- **Status**: `Pending`
- **Blocks**: Frontend launch with real learners
- **Link**: <https://www.w3.org/WAI/WCAG21/quickref/>

**Agreed minimums** (sign off in writing before any new D1/D2 frontend work):
- [ ] 4.5:1 colour contrast ratio for all body text
- [ ] All form fields and buttons have ARIA labels
- [ ] All screens fully navigable by keyboard alone
- [ ] Minimum 44×44px touch targets
- [ ] Font-size toggle on learner-facing screens
- [ ] `<html lang="…">` attribute set to the learner's detected language throughout the session

**Dev tooling**
- [ ] Install **axe DevTools** browser extension: <https://www.deque.com/axe/devtools/>
- [ ] Run on every screen before marking that screen complete
- [ ] Zero critical or serious violations before merge

**Notes**
- Retrofitting accessibility is significantly more expensive than building it in. Agree the standards now; the dev applies them by default in every new screen rather than as a separate audit pass.

---

## Production launch gating logic

A deployment that processes real learner data MUST have these closed:

- Tasks 1, 3, 4, 5, 6, 10 marked `Complete`

A deployment that submits ILR to ESFA / MCAs MUST have these closed:

- All of the above, plus Task 2 (UKPRN)

A G-Cloud listing application MUST have these closed:

- All of the above, plus Tasks 7 and 8

SEIS (Task 9) is independent of platform launch — close it whenever investor activity begins.

---

## Compliance evidence archive

Where to keep signed/issued artefacts (off-repo for anything containing identifying detail):

- ICO registration confirmation email + registration number
- UKPRN confirmation
- Signed Google Cloud DPA (PDF)
- Signed DPIA 1 and DPIA 2
- Published privacy notice (URL + dated PDF snapshot)
- Cyber Essentials certificate
- Insurance certificate
- SEIS advance assurance letter
- WCAG 2.1 AA agreement (signed by Joey + Dev)
