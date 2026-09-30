# Latency findings (Silk brief section 5)

Measured on 30 September 2026 with the section 0 traces. Every tutor
turn now records `stage_ms` on its trace row, so these numbers can be
re-checked on production after any change with
`npm run trace:session -- <sessionId>`.

## Where a typed turn spends its time

One live turn on the local backend against Atlas and Vertex (europe-west4):

| Stage                                  | ms     |
| -------------------------------------- | ------ |
| load session and learner               | 392    |
| safeguarding scan and turn log         | 204    |
| profile and prompt assembly            | 468    |
| Gemini call (3,237 tokens in, 429 out) | 12,549 |
| commit turn                            | 211    |
| total                                  | 13,824 |

Gemini is over 90 percent of the turn. The database stages were four
sequential round trips; two pairs are now run in parallel (session
with learner, recent summaries with reinforcement targets), which
removes roughly 400 to 600 ms.

## The 30 second placement submit and the "connection error"

Production health check from a cold client:

| Call           | Seconds |
| -------------- | ------- |
| first request  | 42.1    |
| second request | 1.1     |
| third request  | 0.5     |

The Render instance sleeps when idle and takes about 40 seconds to
wake. The first request after a quiet spell, whatever it is, exceeds
the client's 30 second timeout. The tester's placement submit was that
first request. This is a hosting setting, not code: keep the instance
awake (a paid instance type, or an external ping every few minutes)
before the pilot. Section 2 also gave the placement call itself a
deadline and the client a 60 second budget, so a slow score no longer
shows as a connection error once the instance is awake.

## Gemini call time

The tutor turn used the wrapper defaults: temperature 0.7 and a
1,024 token thinking budget on a 3,200 token prompt. Section 3 set the
temperature to 0.3. The thinking budget was A/B tested with the eval
harness (three runs per setting, first run of each batch excluded as
cold):

| Budget | Case              | Seconds  |
| ------ | ----------------- | -------- |
| 1,024  | back pain recast  | 6.7, 7.2 |
| 256    | back pain recast  | 4.4, 3.9 |
| 256    | vocabulary answer | 3.5, 3.7 |

A 256 budget saves about three seconds, but in one of three runs the
Entry 3 reply came back entirely in Turkish, ignoring the English
floor. The default stays at 1,024; `TUTOR_THINKING_BUDGET` is there so
the specialist can rerun the eval at 512 and decide.

## Quota

Six parallel tiny calls succeed, so the project is not limited by
concurrent requests. The eval harness hit `429 RESOURCE_EXHAUSTED`
after a handful of full size turns per minute, which points at a
tokens per minute quota on gemini-2.5-flash for this project. With a
3,200 token prompt that is a small number of learners typing at once.
Ask Google Cloud to raise the quota before the pilot, and treat the
prompt size as the lever: Vertex context caching of the static layers
(identity, hard rules, level calibration, output format) would cut the
billed and counted input to a few hundred tokens per turn. The wrapper
already accepts a `cachedContentId`; the cache lifecycle is not built.

## End of session

Ending a session generates the summary inline (about 6 seconds) before
the response returns. Sessions under two turns now skip the model call
(section 1). For longer sessions the summary could be generated after
the response and shown when ready; not changed in this pass.
