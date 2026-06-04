/**
 * Stage 5 AI tutor summary generator — brief Function 17.
 *
 * Worker entry point: dispatched from `processRarpaEvidence` on the
 * `rarpa-evidence` BullMQ queue when `kind === "stage5_summary"`.
 *
 * Pipeline
 * ========
 *
 *   1. Load the Stage5Review by id. Skip if already populated
 *      (single-shot — re-running a Gemini call against a row that's
 *      already been signed off would re-prompt against stale data).
 *   2. Load every AISession at `nqf_level_at_start === level_completed`
 *      for the learner. Aggregate: total sessions, total hours,
 *      scenarios passed, vocab retention, weakest skill domains.
 *   3. Build a Gemini prompt — system instruction is fixed; the
 *      user message carries the aggregated stats and the learner's
 *      first name only (PII-light by design).
 *   4. Call Gemini with `responseMimeType: "application/json"` so
 *      the response parses deterministically.
 *   5. Validate the parsed JSON. Refuse to write a malformed
 *      response — the row stays null and the job retries.
 *   6. Persist the structured summary to
 *      `Stage5Review.ai_tutor_summary`.
 *   7. Notify every org admin: "Stage 5 review for <name> is ready
 *      for your confirmation."
 *   8. AuditLog `stage5_review_generated` for the org-admin trail.
 *
 * Why a separate service from the processor
 * =========================================
 *
 * `queueProcessors/index.ts` is the dispatch hub — keeping the
 * actual Gemini call here means:
 *   - Stage-5 summarisation can be unit-tested in isolation, by
 *     calling `generateStage5Summary()` directly with a mock
 *     Gemini client.
 *   - The processor stays a one-line `await generateStage5Summary
 *     (job.data.stage5_review_id)` — no business logic in the
 *     dispatch hub.
 */

import { Types } from "mongoose";
import { geminiClient, MODEL_NAME } from "../lib/gemini";
import Stage5Review from "../models/Stage5Review";
import User from "../models/User";
import AISession from "../models/AISession";
import VocabLedger from "../models/VocabLedger";
import { createNotification } from "./notification.service";
import { writeAuditLog } from "./auditLog.service";
import { ILR_CODE_TO_DOMAIN, ForSkillsDomain } from "./esolSkills";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Public result shape
// ─────────────────────────────────────────────────────────────────────

export type ReadinessRating = "low" | "medium" | "high";

export interface Stage5AiTutorSummary {
  summary: string;
  key_achievements: string[];
  readiness_for_next_level: ReadinessRating;
  generated_at: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface GenerateStage5SummaryResult {
  stage5_review_id: string;
  status: "completed" | "skipped" | "failed";
  reason?: string;
  summary?: Stage5AiTutorSummary;
  notified_admins: number;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are summarising a learner's progress for their RARPA Stage 5 review. " +
  "Write 4-6 plain-English sentences in a warm, encouraging tone. " +
  "Focus on what they achieved and what they're ready for next. " +
  "Do not use jargon.";

const LEVEL_LABELS: Record<string, string> = {
  e1: "Entry Level 1",
  e2: "Entry Level 2",
  e3: "Entry Level 3",
  l1: "Level 1",
  l2: "Level 2",
};

const GEMINI_TIMEOUT_MS = 30_000;
const TEMPERATURE = 0.6;
const MAX_OUTPUT_TOKENS = 600;

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const withTimeout = async <T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

interface SessionAggregates {
  total_sessions: number;
  total_hours: number;
  scenarios_passed: number;
  scenarios_attempted: number;
  vocab_retained: number;
  vocab_total: number;
  vocab_retention_pct: number;
  top_retained_words: string[];
  weak_domains: string[];
  level_label: string;
}

/**
 * Map weakness-flag skill codes (Sc, Lr, Ws, …) to ForSkills
 * domain names (speaking, listening, reading, writing). Returns
 * deduped, human-readable strings.
 */
const domainsFromCodes = (codes: string[]): string[] => {
  const domains = new Set<ForSkillsDomain>();
  for (const c of codes) {
    const d = ILR_CODE_TO_DOMAIN[c as keyof typeof ILR_CODE_TO_DOMAIN];
    if (d) domains.add(d);
  }
  return Array.from(domains);
};

const aggregateSessions = async (
  learnerId: Types.ObjectId,
  levelCompleted: string,
): Promise<SessionAggregates> => {
  // ── Sessions at the just-completed level ────────────────────────
  // Filter on nqf_level_at_start so a learner who jumped levels
  // mid-period still gets the right slice. Pre-platform GLH imports
  // typically don't carry this field; including null would mix
  // current-level evidence with carry-forward — we exclude null
  // explicitly.
  const sessions = await AISession.find({
    learnerId,
    nqf_level_at_start: levelCompleted,
  })
    .select(
      "duration_mins passed completedAt scenario_id skill_weakness_flags",
    )
    .lean();

  let total_mins = 0;
  let scenarios_passed = 0;
  let scenarios_attempted = 0;
  const weakDomainCodes = new Set<string>();
  for (const s of sessions) {
    total_mins += s.duration_mins ?? 0;
    if (s.completedAt) scenarios_attempted += 1;
    if (s.passed === true) scenarios_passed += 1;
    const flags = (s as { skill_weakness_flags?: string[] }).skill_weakness_flags;
    if (Array.isArray(flags)) flags.forEach((f) => weakDomainCodes.add(f));
  }

  // ── Vocab ledger (whole learner — there's no per-level partition;
  // a word retained at this level remains retained going forward) ──
  const vocab = await VocabLedger.find({ learnerId })
    .select("word retained times_encountered last_seen_at")
    .lean();

  const retained = vocab.filter(
    (v) => (v as { retained?: boolean }).retained === true,
  );
  const top_retained_words = retained
    .slice()
    .sort((a, b) => {
      const av = (a as { times_encountered?: number }).times_encountered ?? 0;
      const bv = (b as { times_encountered?: number }).times_encountered ?? 0;
      return bv - av;
    })
    .slice(0, 10)
    .map((v) => (v as { word: string }).word);

  const vocab_retention_pct =
    vocab.length > 0
      ? Math.round((retained.length / vocab.length) * 100)
      : 0;

  return {
    total_sessions: sessions.length,
    total_hours: Math.round((total_mins / 60) * 10) / 10,
    scenarios_passed,
    scenarios_attempted,
    vocab_retained: retained.length,
    vocab_total: vocab.length,
    vocab_retention_pct,
    top_retained_words,
    weak_domains: domainsFromCodes(Array.from(weakDomainCodes)),
    level_label: LEVEL_LABELS[levelCompleted] ?? levelCompleted.toUpperCase(),
  };
};

/**
 * Build the user-content message — a compact, factual summary the
 * model uses to ground its narrative. Carries firstname only; never
 * surname, email, ULN, or other PII.
 */
const buildUserPrompt = (
  firstName: string,
  agg: SessionAggregates,
): string => {
  const lines: string[] = [];
  lines.push(`Learner first name: ${firstName}`);
  lines.push(`Level completed: ${agg.level_label}`);
  lines.push(`Total guided learning hours at this level: ${agg.total_hours}`);
  lines.push(`Sessions completed: ${agg.total_sessions}`);
  lines.push(
    `Scenarios: ${agg.scenarios_passed} passed of ${agg.scenarios_attempted} attempted`,
  );
  lines.push(
    `Vocabulary retention: ${agg.vocab_retained} retained of ${agg.vocab_total} encountered (${agg.vocab_retention_pct}%)`,
  );
  if (agg.top_retained_words.length > 0) {
    lines.push(
      `Top retained words: ${agg.top_retained_words.slice(0, 8).join(", ")}`,
    );
  }
  if (agg.weak_domains.length > 0) {
    lines.push(
      `Skills still developing: ${agg.weak_domains.join(", ")}`,
    );
  }
  lines.push("");
  lines.push(
    "Produce a JSON object with these keys:",
    '  - "summary": 4-6 sentences, warm and encouraging, no jargon.',
    '  - "key_achievements": array of 3-5 short strings (one sentence each).',
    '  - "readiness_for_next_level": one of "low", "medium", "high".',
  );
  return lines.join("\n");
};

/**
 * Parse + validate the JSON Gemini returns. Refuses on the slightest
 * malformation so we never persist garbage. The retry policy on the
 * worker handles the transient case.
 */
const parseGeminiJson = (raw: string): Stage5AiTutorSummary | null => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof candidate !== "object" || candidate === null) return null;
  const c = candidate as Record<string, unknown>;
  if (typeof c.summary !== "string" || c.summary.trim().length < 20) {
    return null;
  }
  if (!Array.isArray(c.key_achievements)) return null;
  const achievements = c.key_achievements.filter(
    (a): a is string => typeof a === "string" && a.trim().length > 0,
  );
  if (achievements.length === 0) return null;
  if (
    c.readiness_for_next_level !== "low" &&
    c.readiness_for_next_level !== "medium" &&
    c.readiness_for_next_level !== "high"
  ) {
    return null;
  }
  return {
    summary: c.summary.trim(),
    key_achievements: achievements,
    readiness_for_next_level: c.readiness_for_next_level,
    generated_at: new Date().toISOString(),
    model: MODEL_NAME,
    input_tokens: 0, // filled in by caller from usage metadata
    output_tokens: 0,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Top-level worker entry — generateStage5Summary
// ─────────────────────────────────────────────────────────────────────

export const generateStage5Summary = async (
  stage5ReviewId: string,
): Promise<GenerateStage5SummaryResult> => {
  if (!stage5ReviewId || !Types.ObjectId.isValid(stage5ReviewId)) {
    return {
      stage5_review_id: stage5ReviewId,
      status: "failed",
      reason: "stage5_review_id must be a valid ObjectId",
      notified_admins: 0,
    };
  }

  // ── 1. Load the review ─────────────────────────────────────────
  const review = await Stage5Review.findById(stage5ReviewId);
  if (!review) {
    return {
      stage5_review_id: stage5ReviewId,
      status: "failed",
      reason: "Stage5Review not found",
      notified_admins: 0,
    };
  }
  if (review.ai_tutor_summary !== null) {
    // Already populated — skip to avoid clobbering a finalised
    // record (and to keep Gemini spend down on a re-driven job).
    return {
      stage5_review_id: stage5ReviewId,
      status: "skipped",
      reason: "ai_tutor_summary already populated",
      notified_admins: 0,
    };
  }

  // Load the learner — firstname only goes into the prompt.
  const learner = await User.findById(review.learner_id)
    .select("_id firstname")
    .lean();
  if (!learner) {
    return {
      stage5_review_id: stage5ReviewId,
      status: "failed",
      reason: "Learner not found for this Stage5Review",
      notified_admins: 0,
    };
  }
  const firstName = (learner.firstname ?? "").trim() || "the learner";

  // ── 2. Aggregate sessions + vocab ──────────────────────────────
  const aggregates = await aggregateSessions(
    review.learner_id as Types.ObjectId,
    review.level_completed,
  );

  // ── 3+4. Gemini call ──────────────────────────────────────────
  // Reuses the singleton — never instantiate a new VertexAI here.
  // System instruction is the fixed prompt; user content is the
  // structured stats. `responseMimeType: "application/json"`
  // forces structured output we can `JSON.parse` deterministically.
  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: {
      role: "system",
      parts: [{ text: SYSTEM_PROMPT }],
    },
    generationConfig: {
      responseMimeType: "application/json",
      temperature: TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  });

  const userMessage = buildUserPrompt(firstName, aggregates);

  let parsed: Stage5AiTutorSummary | null;
  let usage:
    | { promptTokenCount?: number; candidatesTokenCount?: number }
    | undefined;
  try {
    const result = await withTimeout(
      model.generateContent({
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
      }),
      GEMINI_TIMEOUT_MS,
      "stage5-ai-summary",
    );

    const text =
      result.response?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    if (!text) {
      throw new Error("Gemini returned empty content");
    }
    usage = result.response?.usageMetadata;
    parsed = parseGeminiJson(text);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, stage5_review_id: stage5ReviewId },
      "generateStage5Summary: Gemini call failed — worker will retry",
    );
    // Re-throw so BullMQ retries (3 attempts, 5s/30s/120s backoff).
    throw err;
  }

  if (!parsed) {
    // A malformed Gemini response is treated as a hard error so
    // the worker retries. After 3 failures the row stays null and
    // the daily/admin re-drive endpoint (separate task) is the
    // recovery path.
    throw new Error(
      "Stage 5 summary: Gemini returned malformed JSON or insufficient content",
    );
  }
  parsed.input_tokens = usage?.promptTokenCount ?? 0;
  parsed.output_tokens = usage?.candidatesTokenCount ?? 0;

  // ── 5+6. Persist ──────────────────────────────────────────────
  review.ai_tutor_summary = parsed;
  await review.save();

  // ── 7. Notify org admins ──────────────────────────────────────
  let notified_admins = 0;
  try {
    const orgAdmins = await User.find({
      orgId: review.org_id,
      role: "org_admin",
    })
      .select("_id")
      .lean();
    await Promise.all(
      orgAdmins.map(async (admin) => {
        try {
          await createNotification({
            userId: admin._id,
            type: "stage5_review_initiated",
            title: `Stage 5 review ready — ${firstName}`,
            message: `Stage 5 review for ${firstName} is ready for your confirmation.`,
            data: {
              stage5_review_id: stage5ReviewId,
              learner_id: (learner._id as Types.ObjectId).toString(),
              level_completed: review.level_completed,
              readiness: parsed.readiness_for_next_level,
            },
          });
          notified_admins += 1;
        } catch (err) {
          logger.error(
            {
              err: (err as Error).message,
              org_admin_id: admin._id.toString(),
              stage5_review_id: stage5ReviewId,
            },
            "generateStage5Summary: per-admin notification failed",
          );
        }
      }),
    );
  } catch (err) {
    // Lookup itself failed — log but don't roll back the summary.
    logger.error(
      { err: (err as Error).message, stage5_review_id: stage5ReviewId },
      "generateStage5Summary: org-admin lookup failed — summary already saved",
    );
  }

  // ── 8. AuditLog ───────────────────────────────────────────────
  await writeAuditLog({
    actor_type: "system",
    actor_id: null,
    org_id: review.org_id,
    learner_id: review.learner_id,
    action: "stage5_review_generated",
    before_state: null,
    after_state: {
      stage5_review_id: stage5ReviewId,
      level_completed: review.level_completed,
      readiness_for_next_level: parsed.readiness_for_next_level,
      key_achievements_count: parsed.key_achievements.length,
      input_tokens: parsed.input_tokens,
      output_tokens: parsed.output_tokens,
      notified_admins,
    },
    reason: `AI tutor summary generated for ${firstName} — Stage 5 review pending org-admin confirmation.`,
  });

  logger.info(
    {
      stage5_review_id: stage5ReviewId,
      level_completed: review.level_completed,
      input_tokens: parsed.input_tokens,
      output_tokens: parsed.output_tokens,
      readiness: parsed.readiness_for_next_level,
      notified_admins,
    },
    "generateStage5Summary: complete",
  );

  return {
    stage5_review_id: stage5ReviewId,
    status: "completed",
    summary: parsed,
    notified_admins,
  };
};

// Re-exports for tests
export const __internals__ = {
  aggregateSessions,
  buildUserPrompt,
  parseGeminiJson,
  SYSTEM_PROMPT,
};
