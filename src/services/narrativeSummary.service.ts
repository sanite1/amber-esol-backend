/**
 * Cohort narrative summary — brief Function 12 To-Do 3.
 *
 * Backs GET /api/org-admin/narrative-summary. Two halves:
 *
 *   1. `computeCohortMetrics(orgId)` — pure aggregate computation,
 *      no PII. Produces the bag of numbers the brief lists
 *      (active_count, total_glh_this_period, level_progression_count,
 *      avg_sessions_per_learner, top_3_weakest_skill_domains,
 *      inactive_learner_count, teacher_oversight_hours).
 *
 *   2. `getCohortNarrativeService(orgId)` — cache-aware wrapper.
 *      Returns the cached narrative when one exists within the
 *      24-hour TTL window; otherwise builds metrics, calls Gemini,
 *      writes a fresh NarrativeCache row, returns the new value.
 *
 * Privacy contract:
 *
 *   - Metrics are aggregates only — counts, sums, averages, and a
 *     ranked list of skill-domain frequencies. No names, no emails,
 *     no user ids reach the prompt.
 *   - The Gemini system prompt forbids naming individuals.
 *   - Cache rows carry the metrics snapshot AND the narrative, so a
 *     reviewer can correlate what numbers drove which sentence without
 *     ever needing to re-resolve to per-learner records.
 *
 * Quality gate: the brief explicitly notes the quality manager reads
 * this before an Ofsted conversation. The prompt's tone instructions
 * mirror that audience — plain English, concrete numbers, no jargon.
 */

import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import AISession from "../models/AISession";
import LevelChange from "../models/LevelChange";
import NarrativeCache from "../models/NarrativeCache";
import { geminiClient, MODEL_NAME } from "../lib/gemini";
import { ILR_CODE_TO_DOMAIN, ForSkillsDomain } from "./esolSkills";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** Reporting window — last 28 days mirrors a typical 4-week funding period. */
const REPORTING_WINDOW_DAYS = 28;

/** Inactivity threshold — matches the cohort sweep's "inactive" band. */
const INACTIVE_THRESHOLD_DAYS = 14;

/** Cache lifetime — must be ≤ NarrativeCache TTL (86,400s = 24h). */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Gemini generation knobs.
 *
 * Temperature 0.4 sits between the deterministic JSON-schema'd turn
 * handler (0.2) and free-form creative writing (0.7+). Narratives
 * should reword the metrics, not invent — 0.4 lets the prose flow
 * without straying.
 */
const NARRATIVE_TEMPERATURE = 0.4;
const NARRATIVE_MAX_OUTPUT_TOKENS = 400;
const NARRATIVE_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────
// Metrics types
// ─────────────────────────────────────────────────────────────────────

export interface CohortMetrics {
  active_count: number;
  total_glh_this_period: number;
  level_progression_count: number;
  avg_sessions_per_learner: number;
  top_3_weakest_skill_domains_across_cohort: Array<{
    domain: ForSkillsDomain;
    learner_count: number;
  }>;
  inactive_learner_count: number;
  teacher_oversight_hours: number;
  /** Snapshot — `28d ending YYYY-MM-DD` so the cache row is reproducible. */
  reporting_window: {
    start: string;
    end: string;
    days: number;
  };
  /** Cohort denominator — the active_count divisor for "this month" framings. */
  total_learners: number;
}

// ─────────────────────────────────────────────────────────────────────
// Metrics computation
// ─────────────────────────────────────────────────────────────────────

const roundHour = (mins: number): number => Math.round((mins / 60) * 10) / 10;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Build the cohort metrics for one org over the last 28 days.
 *
 * Three Mongo round-trips in parallel:
 *   - User.aggregate over active learners (counts, weak-skill flags,
 *     teacher_oversight_hours, last_session_at-derived bands)
 *   - AISession.aggregate over the 28-day window (period GLH, session
 *     counts for avg)
 *   - LevelChange.countDocuments over the 28-day window
 *
 * No PII leaves Mongo — every projection in the User aggregate is
 * count-shaped. The skill-domain ranking aggregates raw `skill_codes`
 * across learners then collapses to domains in Node so the four-domain
 * categorisation lives in one place (esolSkills.ts).
 */
export const computeCohortMetrics = async (
  orgId: string
): Promise<CohortMetrics> => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "orgId must be a valid ObjectId");
  }
  const orgObjectId = new Types.ObjectId(orgId);

  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - REPORTING_WINDOW_DAYS * MS_PER_DAY);
  const inactiveCutoff = new Date(
    windowEnd.getTime() - INACTIVE_THRESHOLD_DAYS * MS_PER_DAY
  );

  // ── 1. Per-cohort User aggregate ─────────────────────────────────
  // One $facet split into:
  //   - totals: total_learners, active_count, inactive_count,
  //             teacher_oversight_hours
  //   - weakFlags: raw flag occurrences (counted in Node so the
  //                ILR_CODE_TO_DOMAIN mapping stays single-sourced)
  const userFacet: Array<{
    totals: Array<{
      total_learners: number;
      active_count: number;
      inactive_count: number;
      teacher_oversight_hours: number;
    }>;
    weakFlags: Array<{ flag: string; count: number }>;
  }> = await User.aggregate([
    {
      $match: { orgId: orgObjectId, role: "student", isActive: true },
    },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total_learners: { $sum: 1 },
              active_count: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        // cohort_status precomputed by the daily cron
                        { $in: ["$cohort_status", ["active", "new"]] },
                        // …or live: had a session within the window
                        {
                          $and: [
                            { $eq: [{ $ifNull: ["$cohort_status", null] }, null] },
                            { $gte: [{ $ifNull: ["$last_session_at", null] }, windowStart] },
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              inactive_count: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        {
                          $in: [
                            "$cohort_status",
                            ["inactive_mild", "inactive_moderate", "dormant"],
                          ],
                        },
                        {
                          $and: [
                            { $eq: [{ $ifNull: ["$cohort_status", null] }, null] },
                            { $lt: [{ $ifNull: ["$last_session_at", new Date(0)] }, inactiveCutoff] },
                          ],
                        },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              teacher_oversight_hours: {
                $sum: { $ifNull: ["$glh_teacher_contact", 0] },
              },
            },
          },
        ],
        weakFlags: [
          { $unwind: { path: "$skillWeaknessFlags", preserveNullAndEmptyArrays: false } },
          {
            $group: {
              _id: "$skillWeaknessFlags",
              count: { $sum: 1 },
            },
          },
          { $project: { _id: 0, flag: "$_id", count: 1 } },
        ],
      },
    },
  ]);

  const totals = userFacet[0]?.totals?.[0] ?? {
    total_learners: 0,
    active_count: 0,
    inactive_count: 0,
    teacher_oversight_hours: 0,
  };
  const flagRows = userFacet[0]?.weakFlags ?? [];

  // ── 2. Sessions over the 28-day window ───────────────────────────
  const [sessionAgg] = await AISession.aggregate([
    {
      $match: {
        orgId: orgObjectId,
        createdAt: { $gte: windowStart, $lte: windowEnd },
      },
    },
    {
      $group: {
        _id: null,
        total_mins: { $sum: { $ifNull: ["$duration_mins", 0] } },
        session_count: { $sum: 1 },
      },
    },
  ]);

  const periodSessionMins = (sessionAgg?.total_mins as number | undefined) ?? 0;
  const periodSessionCount = (sessionAgg?.session_count as number | undefined) ?? 0;

  // ── 3. Level changes in the window ───────────────────────────────
  const level_progression_count = await LevelChange.countDocuments({
    orgId: orgObjectId,
    effectiveDate: { $gte: windowStart, $lte: windowEnd },
  });

  // ── 4. Collapse raw skill codes → domain frequencies (Node-side) ──
  // The domain mapping is the single source of truth in esolSkills.ts;
  // doing this in Node keeps that file the only place that needs to
  // change when the ILR taxonomy evolves.
  const domainCounts = new Map<ForSkillsDomain, number>();
  for (const row of flagRows) {
    const domain = ILR_CODE_TO_DOMAIN[row.flag as keyof typeof ILR_CODE_TO_DOMAIN];
    if (!domain) continue;
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + row.count);
  }
  const top_3_weakest_skill_domains_across_cohort = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([domain, learner_count]) => ({ domain, learner_count }));

  // ── 5. Compose ───────────────────────────────────────────────────
  const total_glh_this_period = round1(
    periodSessionMins / 60 + (totals.teacher_oversight_hours ?? 0)
  );
  const avg_sessions_per_learner =
    totals.total_learners > 0
      ? round1(periodSessionCount / totals.total_learners)
      : 0;

  return {
    active_count: totals.active_count ?? 0,
    total_glh_this_period,
    level_progression_count,
    avg_sessions_per_learner,
    top_3_weakest_skill_domains_across_cohort,
    inactive_learner_count: totals.inactive_count ?? 0,
    teacher_oversight_hours: round1(totals.teacher_oversight_hours ?? 0),
    reporting_window: {
      start: windowStart.toISOString().split("T")[0],
      end: windowEnd.toISOString().split("T")[0],
      days: REPORTING_WINDOW_DAYS,
    },
    total_learners: totals.total_learners ?? 0,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Gemini prompt
// ─────────────────────────────────────────────────────────────────────

/**
 * System instruction — defines the audience, voice, and the privacy
 * constraints. Repeats "no names" because Gemini will otherwise
 * paraphrase the metric ("Sara from Newcastle FE…") even when no
 * names are in the input.
 */
const NARRATIVE_SYSTEM_PROMPT = `You write 4–6 sentence cohort progress summaries for a UK FE-college quality manager preparing for an Ofsted conversation.

Tone:
- Plain English, the kind a non-specialist would understand on first read.
- Concrete numbers from the JSON metrics provided. Round to the nearest whole number when reading aloud naturally.
- Calm, factual. Not promotional. Not anxious.

You MUST:
- Lead with the most informative metric for the period (typically scenario completion, level progressions, or active engagement).
- Mention any inactive learners as a check-in prompt, not a warning.
- Reference the top weakest skill domain by NAME (e.g., "written English" for writing, "spoken English" for speaking) — translate the domain codes for the reader.
- Include total guided learning hours with a brief acknowledgement of the teacher-oversight component.

You MUST NOT:
- Name any individual learner, teacher, or organisation. There are no names in the metrics by design.
- Invent figures not present in the metrics.
- Use bullet points or headers. Output ONLY the prose paragraph.
- Add disclaimers, follow-up questions, or meta-commentary about the data.

Output: a single paragraph of 4–6 sentences. No quotation marks, no preamble.`;

/**
 * Translate the four ForSkills domain codes into the phrasing a quality
 * manager uses on the Ofsted call. Gemini sees both the code and the
 * label so it can choose the right register.
 */
const DOMAIN_PROSE: Record<ForSkillsDomain, string> = {
  reading: "reading English",
  writing: "written English",
  listening: "listening to spoken English",
  speaking: "spoken English",
};

const buildNarrativeUserPrompt = (metrics: CohortMetrics): string => {
  const topDomains = metrics.top_3_weakest_skill_domains_across_cohort.map(
    (d) => ({
      domain: d.domain,
      label: DOMAIN_PROSE[d.domain],
      learner_count: d.learner_count,
    })
  );

  // Hand Gemini a clean JSON object with prose-friendly labels.
  // Avoiding a hand-rolled English string keeps Gemini's contribution
  // distinct from the metrics it's working from.
  const payload = {
    reporting_window_days: metrics.reporting_window.days,
    reporting_window_end: metrics.reporting_window.end,
    cohort_size: metrics.total_learners,
    active_count: metrics.active_count,
    inactive_learner_count: metrics.inactive_learner_count,
    avg_sessions_per_learner: metrics.avg_sessions_per_learner,
    level_progression_count: metrics.level_progression_count,
    total_glh_this_period: metrics.total_glh_this_period,
    teacher_oversight_hours: metrics.teacher_oversight_hours,
    top_weakest_skill_domains: topDomains,
  };

  return `Cohort metrics for the period:\n${JSON.stringify(payload, null, 2)}\n\nWrite the 4–6 sentence summary now. Paragraph only.`;
};

// ─────────────────────────────────────────────────────────────────────
// Gemini call
// ─────────────────────────────────────────────────────────────────────

/**
 * Race a Promise against a wall-clock timeout. Identical pattern to
 * gemini.service.ts (the per-turn handler) so a future refactor can
 * lift this into a shared util — for now it stays inline to keep this
 * service self-contained.
 */
const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * Single Gemini call — plain text output.
 *
 * Differs from the per-turn handler's `generateTurn`:
 *   - No JSON schema; we want prose, not structured output.
 *   - No retry on transient error (the cache fallback below handles
 *     the cold-call failure path — we serve the previous day's
 *     narrative if one exists; freshness is not life-critical).
 *
 * Returns the narrative text + usage metadata for logging.
 */
const callGeminiForNarrative = async (
  metrics: CohortMetrics
): Promise<{
  narrative: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}> => {
  const startedAt = Date.now();
  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: {
      role: "system",
      parts: [{ text: NARRATIVE_SYSTEM_PROMPT }],
    },
    generationConfig: {
      // Plain text — explicitly NOT application/json (the per-turn
      // handler's default). Keeps Gemini in prose mode.
      responseMimeType: "text/plain",
      temperature: NARRATIVE_TEMPERATURE,
      maxOutputTokens: NARRATIVE_MAX_OUTPUT_TOKENS,
    },
  });

  const userMessage = buildNarrativeUserPrompt(metrics);

  const result = await withTimeout(
    model.generateContent({
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
    }),
    NARRATIVE_TIMEOUT_MS,
    "narrative-summary"
  );

  const narrative =
    result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!narrative) {
    throw new Error("Gemini returned empty narrative");
  }

  const usage = result.response?.usageMetadata;
  return {
    narrative,
    input_tokens: usage?.promptTokenCount ?? 0,
    output_tokens: usage?.candidatesTokenCount ?? 0,
    latency_ms: Date.now() - startedAt,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Cache-aware service entry
// ─────────────────────────────────────────────────────────────────────

export interface NarrativeSummaryResult {
  narrative: string;
  generated_at: string;
  expires_at: string;
  cache_hit: boolean;
  metrics: CohortMetrics;
}

export const getCohortNarrativeService = async (
  orgId: string
): Promise<ApiResponse> => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "Organisation context is required and must be a valid id");
  }
  const orgObjectId = new Types.ObjectId(orgId);
  const now = Date.now();

  // ── 1. Cache lookup ──────────────────────────────────────────────
  // Find the most recent cache row for this org. Mongo's TTL index
  // sweeps expired rows asynchronously, so we still do a freshness
  // check in code (a row could survive a few minutes past expiry
  // between TTL sweeps).
  const cached = await NarrativeCache.findOne({ org_id: orgObjectId })
    .sort({ generated_at: -1 })
    .lean();

  if (
    cached &&
    cached.generated_at instanceof Date &&
    now - cached.generated_at.getTime() < CACHE_TTL_MS
  ) {
    return new ApiResponse(200, "Cohort narrative (cached)", {
      narrative: cached.narrative,
      generated_at: cached.generated_at.toISOString(),
      expires_at:
        cached.expires_at instanceof Date
          ? cached.expires_at.toISOString()
          : new Date(cached.generated_at.getTime() + CACHE_TTL_MS).toISOString(),
      cache_hit: true,
      metrics: (cached.metrics as unknown as CohortMetrics) ?? null,
    });
  }

  // ── 2. Compute fresh metrics ─────────────────────────────────────
  const metrics = await computeCohortMetrics(orgId);

  // ── 3. Gemini — with a graceful-degrade fallback to stale cache ──
  let narrative: string;
  let geminiUsage: { input_tokens: number; output_tokens: number; latency_ms: number } | null = null;
  try {
    const out = await callGeminiForNarrative(metrics);
    narrative = out.narrative;
    geminiUsage = {
      input_tokens: out.input_tokens,
      output_tokens: out.output_tokens,
      latency_ms: out.latency_ms,
    };
  } catch (err) {
    // If Gemini is down or times out, serve the previous cache row
    // (even if it's >24h old) rather than blank. The dashboard would
    // rather show "yesterday's narrative" than "narrative unavailable"
    // ahead of an Ofsted call.
    logger.error(
      { err: (err as Error).message, org_id: orgId },
      "narrativeSummary: Gemini call failed — falling back to stale cache if present"
    );
    if (cached?.narrative) {
      return new ApiResponse(200, "Cohort narrative (stale fallback)", {
        narrative: cached.narrative,
        generated_at: cached.generated_at.toISOString(),
        expires_at:
          cached.expires_at instanceof Date
            ? cached.expires_at.toISOString()
            : new Date(cached.generated_at.getTime() + CACHE_TTL_MS).toISOString(),
        cache_hit: true,
        metrics: (cached.metrics as unknown as CohortMetrics) ?? null,
      });
    }
    throw new ApiError(502, "Narrative service unavailable — please retry");
  }

  // ── 4. Persist + return ──────────────────────────────────────────
  const generatedAt = new Date(now);
  const expiresAt = new Date(now + CACHE_TTL_MS);
  await NarrativeCache.create({
    org_id: orgObjectId,
    narrative,
    metrics,
    generated_at: generatedAt,
    expires_at: expiresAt,
  });

  logger.info(
    {
      org_id: orgId,
      input_tokens: geminiUsage?.input_tokens,
      output_tokens: geminiUsage?.output_tokens,
      latency_ms: geminiUsage?.latency_ms,
      total_learners: metrics.total_learners,
    },
    "narrativeSummary: cohort narrative generated"
  );

  return new ApiResponse(200, "Cohort narrative generated", {
    narrative,
    generated_at: generatedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    cache_hit: false,
    metrics,
  });
};

export const __internals__ = {
  CACHE_TTL_MS,
  REPORTING_WINDOW_DAYS,
  NARRATIVE_SYSTEM_PROMPT,
  DOMAIN_PROSE,
  buildNarrativeUserPrompt,
};
