# Tutor eval harness (Silk brief section 3)

The teaching quality items in the brief are prompt and settings work,
not code bugs, so nothing here is "done" on an automated pass. This
folder gives the specialist a repeatable way to judge a change.

## Run

```bash
npm run eval:tutor                       # every case, 2 runs each
npm run eval:tutor -- --runs 3 --only e3-tr-back-pain
TUTOR_TEMPERATURE=0.7 npm run eval:tutor # compare a setting
RECAST_MODE=separate npm run eval:tutor  # include the separate recast call
```

Reports land in `docs/eval/tutor-eval-<timestamp>.md`. Every run also
writes diagnostic traces with source `eval_tutor`, so the full prompt
and raw output of any case can be pulled with the trace script.

## What is automatic and what is not

Automatic checks: English word share against the level's floor,
banned words (Layer 2 rule 4 and generic praise), must and must not
patterns, expected mode, score band, and stability across repeated
runs (score spread, recast decision consistent).

Not automatic: whether a recast is grammatical. Cases with
`specialist_review: true` have a marking line in the report. A
DELTA qualified ESOL specialist fills it in. The live test showed why:
automated grammar checks passed 14 of 14 while the recast "I have back
pain for two weeks" was wrong.

## Settings under evaluation

| Setting             | Default now                           | Proposal                                                          | Where                  |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------- | ---------------------- |
| `TUTOR_TEMPERATURE` | 0.3 (was 0.7 via the wrapper default) | keep 0.3 unless the specialist finds replies flat                 | `aiSession.service.ts` |
| `TURN_SCORE_MODE`   | `model`                               | move to `deterministic` or `blend` once compared on real sessions | `turnScore.service.ts` |
| `RECAST_MODE`       | `inline`                              | `separate` once the specialist has marked a report                | `recast.service.ts`    |

Both turn scores and both recasts are recorded on every live turn's
trace whatever the mode, so the comparison can run on real sessions
without changing what learners see.

## Prompt changes made in this pass

- The per turn ratio guidance now states a hard floor: "at least N% of
  the words in reply must be English", because the Entry 3 reply in
  the live test was entirely Turkish despite a 20 percent L1 target.
- BRIDGE and IMMERSION directives now carry an i+1 rule: a message
  clearly above the level gets an English reply pitched one level up
  and one stretch question, never generic praise.

## Adding a case

Append to `tutorEvalCases.json`. Keep the purpose to one line, set the
expectations you can defend, and set `specialist_review: true` on
anything that judges grammar. `npm test -- tutorEval` validates the
file offline.
