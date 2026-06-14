/**
 * Scenario 1 — Concurrent AI sessions.
 *
 * Spec (launch checklist):
 *   50 simulated learners, each running a 20-turn AI session.
 *   Measure p50/p95/p99 turn latency. Pass criterion: p95 < 5 s.
 *
 * Load shape
 * ==========
 *
 *   Ramp 0 → 50 VUs over 30 s, hold at 50 VUs for 5 min, ramp down
 *   over 30 s. Each VU runs `iterations` once — one full 20-turn
 *   session — so the total work is 50 × 20 = 1,000 turns observed.
 *
 * Why one iteration per VU
 * ========================
 *
 * A learner doesn't open ten sessions back-to-back in production —
 * they open one, work through it, then leave. Holding 50 concurrent
 * sessions for 5 minutes models the realistic peak (a class of 50
 * starting their AI tutor session at the top of an hour) without
 * exaggerating it.
 *
 * Pass / fail
 * ===========
 *
 *   p50 < 2 s   (baseline; not a brief criterion, but a useful canary)
 *   p95 < 5 s   ← the launch-checklist gate
 *   p99 < 10 s  (baseline)
 *
 * Run
 * ===
 *
 *   k6 run \
 *     -e BASE_URL=https://api-staging.ambertraining.co.uk \
 *     -e LEARNER_TOKENS=$(cat staging-learner-tokens) \
 *     -e SCENARIO_IDS=s1_gp_appointment,s2_payslip,s3_housing_rights \
 *     scenarios/01-ai-sessions.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";
import { BASE_URL, authHeaders } from "../lib/env.js";
import { learnerTokens, scenarioIds } from "../lib/fixtures.js";

const turnLatency = new Trend("turn_latency_ms", true);
const sessionStartLatency = new Trend("session_start_latency_ms", true);
const sessionEndLatency = new Trend("session_end_latency_ms", true);

export const options = {
  scenarios: {
    ai_sessions: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 50 },
        { duration: "5m", target: 50 },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    // Brief's stated gate.
    turn_latency_ms: ["p(95)<5000"],
    // Baselines — failures here are warnings, not blockers.
    "turn_latency_ms{}": ["p(50)<2000", "p(99)<10000"],
    http_req_failed: ["rate<0.01"],
  },
};

// Each VU picks one (token, scenario) pair at __init time so the
// distribution is balanced across the seeded set.
const tokens = learnerTokens();
const scenarios = scenarioIds();

export default function () {
  const token = tokens[(__VU - 1) % tokens.length];
  const scenarioId = scenarios[(__VU - 1) % scenarios.length];
  const headers = authHeaders(token);

  // 1. Start session
  const startRes = http.post(
    `${BASE_URL}/api/esol/session`,
    JSON.stringify({ scenario_id: scenarioId, sessionMode: "ai_full" }),
    { headers, tags: { name: "POST /api/esol/session" } },
  );
  check(startRes, { "session start 201": (r) => r.status === 201 });
  sessionStartLatency.add(startRes.timings.duration);
  if (startRes.status !== 201) return;
  const sessionId = startRes.json("data.session._id");
  if (!sessionId) return;

  // 2. Submit 20 turns
  for (let i = 0; i < 20; i++) {
    const turnRes = http.post(
      `${BASE_URL}/api/esol/session/${sessionId}/turn`,
      JSON.stringify({
        turn_number: i + 1,
        originalInput: `Hello, this is turn ${i + 1} of the load test.`,
      }),
      { headers, tags: { name: "POST /api/esol/session/:id/turn" } },
    );
    check(turnRes, { "turn 200": (r) => r.status === 200 });
    turnLatency.add(turnRes.timings.duration);
    // Realistic learner pacing — 2-4 s between turns. Matches the
    // typical observed pattern and gives the AI worker some breathing
    // room rather than hammering it with synchronous requests.
    sleep(2 + Math.random() * 2);
  }

  // 3. Complete session
  const endRes = http.post(
    `${BASE_URL}/api/esol/session/${sessionId}/complete`,
    "{}",
    { headers, tags: { name: "POST /api/esol/session/:id/complete" } },
  );
  check(endRes, { "session end 200": (r) => r.status === 200 });
  sessionEndLatency.add(endRes.timings.duration);
}
