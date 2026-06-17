# Amber AI Tutor — Six-Layer System Prompt

> ⚠️ **Layers 2 and 3 are now built from
> `src/data/curriculum/system_prompt_spec.json`, NOT from the `.md`
> files here.** The AI Tutor Brief §8.1 requires the exact curriculum
> text, so `promptAssembly.service.ts` reads Layer 2 (hard rules, incl.
> the advice guardrail) and Layer 3 (per-level calibration) straight
> from that JSON. `layer2-hard-rules.md` and `layer3-level-calibration/*.md`
> are **retained for history only and NO LONGER READ** — editing them
> has no effect. Change Layer 2/3 content in `system_prompt_spec.json`.
> Layers 1 and 6 are still sourced from their `.md` files.

This directory holds the static layers of the system prompt Gemini reads
on every AI tutor turn. The full ordering at call time is:

| #   | Layer             | Source                                         | Cacheable?         |
| --- | ----------------- | ---------------------------------------------- | ------------------ |
| 1   | Identity          | `layer1-identity.md`                           | yes                |
| 2   | Hard rules        | `curriculum/system_prompt_spec.json` (layer_2) | yes                |
| 3   | Level calibration | `curriculum/system_prompt_spec.json` (layer_3) | yes                |
| 4   | Scenario          | the live `Scenario` document                   | yes (per scenario) |
| 5   | Learner profile   | built at runtime from `User` + session         | **no** — dynamic   |
| 6   | Output format     | `layer6-output-format.md`                      | yes                |

**Concatenation order at the wire:**
`1 → 2 → 3 → 4 → 6 → 5`

The cacheable portion (`1 + 2 + 3 + 4 + 6`) lives in the Vertex AI
`cachedContents` resource. Layer 5 — the dynamic per-session payload —
is appended after the cache hit, never cached itself. That's what makes
the cache useful: 1–4 + 6 are stable per `(scenarioId, learnerLevel)`,
and the learner-specific bits (recent summaries, vocab to reinforce,
current mode) are the only thing that changes turn-to-turn.

## Ownership

- **Layers 1, 2, 3** — Joey (curriculum lead) owns the content.
  Developer ownes the file structure and assembly. Each MD file below
  has `TODO` markers showing exactly where Joey writes.
- **Layer 4** — per-scenario, lives on the `Scenario` document.
  Authored by the scenario author (see Function 9).
- **Layer 5** — built by `promptAssembly.service.ts` from the learner's
  User record + session context. Pure derivation, no human authoring.
- **Layer 6** — developer-owned. The JSON schema instruction has to
  match the response schema declared in `geminiAI.service.ts`.

## Editing protocol

1. Edit the MD file directly. Markdown is read verbatim into the prompt
   — that is, anything you write is sent to Gemini. Comments in HTML
   form (`<!-- … -->`) are STRIPPED before sending. Use them for
   editorial notes that should not reach the model.
2. Bump the version number at the bottom of the file. The assembly
   service hashes the cacheable layers; a content change invalidates
   the Vertex cache automatically, but the version number is what a
   human reviewer reads.
3. Run the AI tutor in staging against at least 5 scenarios at the
   affected level before promoting to production.

## Why MD, not JSON

The content is prose Gemini reads as prose. Storing it as JSON adds
escape rules, makes diff review noisier, and tempts editors to
introduce structure ("rules": [...]) that the model would render less
faithfully than the natural English. MD lets curriculum authors write
how they'd write a teaching guide.
