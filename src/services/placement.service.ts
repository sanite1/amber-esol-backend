import { createHash } from "crypto";
import { Types } from "mongoose";
import { readFileSync } from "fs";
import { resolve } from "path";

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import PlacementAttempt from "../models/PlacementAttempt";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { geminiClient, MODEL_NAME } from "../lib/gemini";
import IdempotencyService from "./idempotency.service";
import ComplianceConfigService from "./ComplianceConfigService";
import { ALL_ILR_CODES, IlrSkillCode } from "./esolSkills";
import { createStage3ObjectivesFromPlacement } from "./rarpa.service";
import logger from "../config/logger";
import {
  PlacementBank,
  PlacementQuestion,
  EsolLevel,
} from "../interfaces/placementQuestion.interface";
import {
  AnsweredQuestion,
  IPlacementAttempt,
  PlacementResult,
} from "../interfaces/placementAttempt.interface";

/**
 * Adaptive placement service — brief Function 6 To-Do 2.
 *
 * Two public entry points the routes call:
 *   - `getOrStartAttempt(learnerId, orgId)` — open a new attempt or
 *     resume the in-progress one. Returns the next question to ask.
 *   - `submitAnswer(learnerId, body)` — records one answer, runs the
 *     adaptive recalc when answer #5 lands, returns the next question
 *     or "done" when all 20 are in.
 *   - `submitAttempt(learnerId)` — flips status to "submitted" and
 *     hands off to the Gemini scoring worker (To-Do 8.3, stubbed).
 *
 * `selectAdaptiveQuestions` is exported separately because it's a
 * pure function the unit tests will hammer directly.
 */

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

const TOTAL_QUESTIONS = 20;
const PER_LEVEL_INITIAL = 4;
const ADAPTIVE_TRIGGER = 5;

const LEVELS_ASC: EsolLevel[] = ["e1", "e2", "e3", "l1", "l2"];
const EASIER_LEVELS: EsolLevel[] = ["e1", "e2"];
const HARDER_LEVELS_DESC: EsolLevel[] = ["l2", "l1"]; // l2 first → "harder"

const BANK_PATH = resolve(__dirname, "../data/placement-questions.json");

// ─────────────────────────────────────────────────────────────────────
// Bank loader (cached)
// ─────────────────────────────────────────────────────────────────────

let cachedBank: PlacementBank | null = null;

/**
 * Read the JSON bank from disk and cache it for the process lifetime.
 * A test or the `validate:placement-bank` script can pass an explicit
 * bank into `selectAdaptiveQuestions` to bypass this cache.
 */
export const loadPlacementBank = (): PlacementBank => {
  if (cachedBank) return cachedBank;
  const raw = readFileSync(BANK_PATH, "utf8");
  cachedBank = JSON.parse(raw) as PlacementBank;
  return cachedBank;
};

// Exposed for tests that mutate disk between cases.
export const __resetPlacementBankCache = () => {
  cachedBank = null;
};

// ─────────────────────────────────────────────────────────────────────
// Pure algorithm — selectAdaptiveQuestions
// ─────────────────────────────────────────────────────────────────────

/**
 * Given the answers a learner has produced so far, return the FULL
 * 20-question plan in presentation order.
 *
 * Phases:
 *   - `answeredSoFar.length < 5`: returns the initial deterministic
 *     selection (4 per level, interleaved across levels).
 *   - `answeredSoFar.length >= 5`: applies the adaptive recalc using
 *     the first 5 answers. The 5 already-answered questions occupy
 *     positions 1–5; positions 6–20 are rewritten based on outcome.
 *
 * Outcomes:
 *   - All 5 wrong → drop every e3/l1/l2 from the trailing 15, fill
 *     with unused e1/e2 from the bank.
 *   - All 5 correct → drop 5 e1 questions from the trailing 15, fill
 *     with unused l1/l2 (l2 preferred — "harder").
 *   - Anything in between → leave the trailing 15 as the initial
 *     selection had them.
 *
 * Determinism: ties broken by `id` lexicographic order. Same inputs →
 * same 20-question output, every time. Lets us re-derive an attempt's
 * plan from `answeredSoFar` alone, no separate stored cursor needed.
 */
export const selectAdaptiveQuestions = (
  answeredSoFar: AnsweredQuestion[],
  bank: PlacementQuestion[]
): PlacementQuestion[] => {
  // ── 1. Group + sort the bank by level ────────────────────────────
  const byLevel = new Map<EsolLevel, PlacementQuestion[]>();
  for (const level of LEVELS_ASC) {
    byLevel.set(
      level,
      bank
        .filter((q) => q.level === level)
        .sort((a, b) => a.id.localeCompare(b.id))
    );
  }

  // ── 2. Guard: bank must have ≥ 4 per level for the initial pick ─
  for (const level of LEVELS_ASC) {
    const count = byLevel.get(level)?.length ?? 0;
    if (count < PER_LEVEL_INITIAL) {
      throw new ApiError(
        500,
        `Placement bank has ${count} ${level} question(s); ` +
          `needs ≥ ${PER_LEVEL_INITIAL} to run an attempt`
      );
    }
  }

  // ── 3. Initial pick: first 4 (by id) of each level ──────────────
  const initialByLevel = new Map<EsolLevel, PlacementQuestion[]>();
  for (const level of LEVELS_ASC) {
    initialByLevel.set(level, byLevel.get(level)!.slice(0, PER_LEVEL_INITIAL));
  }

  // ── 4. Interleave: 4 tranches × 5 levels = 20 questions ─────────
  // Order: e1,e2,e3,l1,l2, e1,e2,e3,l1,l2, ... — keeps the first 5
  // questions one-of-each-level so the adaptive trigger sees a full
  // spread of levels.
  const initial20: PlacementQuestion[] = [];
  for (let tranche = 0; tranche < PER_LEVEL_INITIAL; tranche++) {
    for (const level of LEVELS_ASC) {
      initial20.push(initialByLevel.get(level)![tranche]);
    }
  }

  // ── 5. Pre-trigger: return initial selection unchanged ──────────
  if (answeredSoFar.length < ADAPTIVE_TRIGGER) {
    return initial20;
  }

  // ── 6. Pin the answered first 5 ─────────────────────────────────
  const firstFive = answeredSoFar.slice(0, ADAPTIVE_TRIGGER);
  const firstFiveIds = new Set(firstFive.map((a) => a.question_id));

  const firstFiveOut: PlacementQuestion[] = [];
  for (const a of firstFive) {
    const q = bank.find((b) => b.id === a.question_id);
    if (!q) {
      throw new ApiError(
        500,
        `Answered question ${a.question_id} is not in the current bank — ` +
          `bank version may have shifted mid-attempt`
      );
    }
    firstFiveOut.push(q);
  }

  // ── 7. Build the trailing 15 candidate pool ─────────────────────
  // Start from the initial trailing 15, drop anything already used.
  let trailing = initial20
    .slice(ADAPTIVE_TRIGGER)
    .filter((q) => !firstFiveIds.has(q.id));

  const correctCount = firstFive.filter((a) => a.was_correct).length;

  if (correctCount === 0) {
    // All wrong → keep only e1/e2 in the trailing, top up from bank.
    trailing = trailing.filter((q) => EASIER_LEVELS.includes(q.level));
    const usedIds = new Set<string>([
      ...firstFiveIds,
      ...trailing.map((q) => q.id),
    ]);
    const topup: PlacementQuestion[] = [];
    for (const level of EASIER_LEVELS) {
      for (const q of byLevel.get(level)!) {
        if (!usedIds.has(q.id)) topup.push(q);
      }
    }
    trailing = topup.length
      ? padTrailing(trailing, topup, TOTAL_QUESTIONS - ADAPTIVE_TRIGGER)
      : trailing;
  } else if (correctCount === ADAPTIVE_TRIGGER) {
    // All correct → drop 5 e1 from trailing, top up from l2/l1 (l2 first).
    let dropped = 0;
    trailing = trailing.filter((q) => {
      if (q.level === "e1" && dropped < ADAPTIVE_TRIGGER) {
        dropped += 1;
        return false;
      }
      return true;
    });
    const usedIds = new Set<string>([
      ...firstFiveIds,
      ...trailing.map((q) => q.id),
    ]);
    const topup: PlacementQuestion[] = [];
    for (const level of HARDER_LEVELS_DESC) {
      for (const q of byLevel.get(level)!) {
        if (!usedIds.has(q.id)) topup.push(q);
      }
    }
    trailing = padTrailing(trailing, topup, TOTAL_QUESTIONS - ADAPTIVE_TRIGGER);
  }
  // correctCount in [1, ADAPTIVE_TRIGGER - 1] — no reshape, trailing
  // is exactly what the initial selection placed there.

  // ── 8. Guarantee exactly TOTAL_QUESTIONS out ────────────────────
  return [
    ...firstFiveOut,
    ...trailing.slice(0, TOTAL_QUESTIONS - ADAPTIVE_TRIGGER),
  ];
};

const padTrailing = (
  current: PlacementQuestion[],
  topup: PlacementQuestion[],
  targetLength: number
): PlacementQuestion[] => {
  const out = [...current];
  let i = 0;
  while (out.length < targetLength && i < topup.length) {
    out.push(topup[i]);
    i += 1;
  }
  return out;
};

// ─────────────────────────────────────────────────────────────────────
// Orchestration entry points
// ─────────────────────────────────────────────────────────────────────

const findBankQuestion = (
  bank: PlacementBank,
  id: string
): PlacementQuestion | null => bank.questions.find((q) => q.id === id) ?? null;

const renderQuestionForLearner = (q: PlacementQuestion) => ({
  // No `correct_answer` — never leaks to the wire.
  id: q.id,
  level: q.level,
  skill_domain: q.skill_domain,
  question_en: q.question_en,
  question_ar: q.question_ar,
  question_so: q.question_so,
  question_fa: q.question_fa,
  question_zh: q.question_zh,
  options: q.options.map((o) => ({
    id: o.id,
    text_en: o.text_en,
    text_ar: o.text_ar,
    text_so: o.text_so,
    text_fa: o.text_fa,
    text_zh: o.text_zh,
  })),
});

/**
 * Open a new attempt for this learner OR resume the in-progress one.
 * Returns the question to ask next (or null if all 20 are answered).
 */
export const getOrStartAttempt = async (
  learnerId: string,
  orgId: string | null
) => {
  if (!orgId) {
    throw new ApiError(403, "Learner must belong to an organisation");
  }

  // Resume any in-progress attempt before creating a fresh one.
  let attempt = await PlacementAttempt.findOne({
    learnerId,
    status: "in_progress",
  }).sort({ startedAt: -1 });

  const bank = loadPlacementBank();

  if (!attempt) {
    const plan = selectAdaptiveQuestions([], bank.questions);
    attempt = await PlacementAttempt.create({
      learnerId: new Types.ObjectId(learnerId),
      orgId: new Types.ObjectId(orgId),
      bank_version: bank.version,
      selected_question_ids: plan.map((q) => q.id),
      answers: [],
      status: "in_progress",
    });
  }

  const nextIdx = attempt.answers.length;
  if (nextIdx >= TOTAL_QUESTIONS) {
    return new ApiResponse(200, "Attempt ready to submit", {
      attempt_id: attempt._id.toString(),
      next_question: null,
      progress: { answered: nextIdx, total: TOTAL_QUESTIONS },
      done: true,
    });
  }
  const nextQ = findBankQuestion(
    bank,
    attempt.selected_question_ids[nextIdx]
  );
  if (!nextQ) {
    throw new ApiError(
      500,
      `Bank does not contain queued question ${attempt.selected_question_ids[nextIdx]}`
    );
  }

  return new ApiResponse(200, "Attempt resumed", {
    attempt_id: attempt._id.toString(),
    next_question: renderQuestionForLearner(nextQ),
    progress: { answered: nextIdx, total: TOTAL_QUESTIONS },
    done: false,
  });
};

interface SubmitAnswerBody {
  question_id: string;
  answer: string;
}

/**
 * Record one answer against the learner's in-progress attempt. Runs
 * the adaptive recalc when answer #5 lands. Returns the next question
 * (or { done: true } when all 20 are in).
 */
export const submitAnswer = async (
  learnerId: string,
  body: SubmitAnswerBody
) => {
  if (!body.question_id || !body.answer) {
    throw new ApiError(400, "question_id and answer are required");
  }

  const attempt = await PlacementAttempt.findOne({
    learnerId,
    status: "in_progress",
  }).sort({ startedAt: -1 });
  if (!attempt) {
    throw new ApiError(
      404,
      "No in-progress placement attempt — call /placement/start first"
    );
  }

  const bank = loadPlacementBank();

  // ── 1. The answered question must be the expected next one ──────
  const expectedIdx = attempt.answers.length;
  if (expectedIdx >= TOTAL_QUESTIONS) {
    throw new ApiError(409, "All 20 questions already answered — call /submit");
  }
  const expectedId = attempt.selected_question_ids[expectedIdx];
  if (body.question_id !== expectedId) {
    throw new ApiError(
      409,
      `Out-of-order answer: expected ${expectedId}, got ${body.question_id}. ` +
        `Learners cannot go back or skip ahead.`
    );
  }

  // ── 2. Validate option id + derive correctness ──────────────────
  const question = findBankQuestion(bank, body.question_id);
  if (!question) {
    throw new ApiError(
      500,
      `Queued question ${body.question_id} is not in the bank — bank version may have shifted`
    );
  }
  const validOptionIds = new Set(question.options.map((o) => o.id));
  if (!validOptionIds.has(body.answer)) {
    throw new ApiError(
      400,
      `answer "${body.answer}" is not one of the option ids for this question`
    );
  }

  // ── 3. Append the answer ────────────────────────────────────────
  const answered: AnsweredQuestion = {
    question_id: body.question_id,
    answer: body.answer,
    was_correct: body.answer === question.correct_answer,
    answered_at: new Date(),
  };
  attempt.answers.push(answered);

  // ── 4. Adaptive recalc — fires exactly once, at answer #5 ───────
  if (
    attempt.answers.length === ADAPTIVE_TRIGGER &&
    !attempt.recalc_applied_at
  ) {
    const newPlan = selectAdaptiveQuestions(attempt.answers, bank.questions);
    // The first 5 are pinned; rewrite positions 6–20.
    attempt.selected_question_ids = newPlan.map((q) => q.id);
    const correctCount = attempt.answers.filter((a) => a.was_correct).length;
    attempt.recalc_applied_at = new Date();
    attempt.recalc_outcome =
      correctCount === 0
        ? "all_wrong"
        : correctCount === ADAPTIVE_TRIGGER
          ? "all_correct"
          : "mixed";
  }

  await attempt.save();

  // ── 5. Return the next question (or done) ───────────────────────
  const nextIdx = attempt.answers.length;
  if (nextIdx >= TOTAL_QUESTIONS) {
    return new ApiResponse(200, "All 20 questions answered", {
      attempt_id: attempt._id.toString(),
      next_question: null,
      progress: { answered: nextIdx, total: TOTAL_QUESTIONS },
      done: true,
    });
  }
  const nextQ = findBankQuestion(bank, attempt.selected_question_ids[nextIdx]);
  if (!nextQ) {
    throw new ApiError(
      500,
      `Bank does not contain queued question ${attempt.selected_question_ids[nextIdx]}`
    );
  }
  return new ApiResponse(200, "Answer recorded", {
    attempt_id: attempt._id.toString(),
    next_question: renderQuestionForLearner(nextQ),
    progress: { answered: nextIdx, total: TOTAL_QUESTIONS },
    done: false,
  });
};

// ─────────────────────────────────────────────────────────────────────
// Gemini scoring (brief Function 6 To-Do 3)
// ─────────────────────────────────────────────────────────────────────

const SCORING_TEMPERATURE = 0.2;     // structured-output call — low temp
const SCORING_MAX_TOKENS = 1024;
const CONFIDENCE_CONSERVATIVE_FLOOR = 0.7;
const LEVEL_FALLBACK: EsolLevel = "e1";

/** ESOL Skills for Life scoring rubric. Compact on purpose: Gemini does
 *  better with a tight, structured rubric than a long discursive one. */
const SCORING_SYSTEM_PROMPT = `You are an ESOL placement assessor working to
the UK Skills for Life framework. You score a learner's 20-question
multiple-choice placement attempt against the published NQF levels:
Entry 1 (e1), Entry 2 (e2), Entry 3 (e3), Level 1 (l1), Level 2 (l2).

Rubric:
- Map correct answers across reading / writing / listening / speaking
  domains. A learner's recommended level is the highest level at which
  they answer the MAJORITY of questions correctly, weighted by each
  question's difficulty_weight.
- If a learner gets ≥ 80% across all domains AT the highest level
  they were shown, they may be placed one level higher.
- If a learner gets < 50% at every level shown, place them at e1.
- Identify weak ILR sub-skill codes from this set:
  Rt, Rs, Rw, Wt, Ws, Ww, Lr, Sc, Sd.
  A domain is "weak" if the learner got < 50% of that domain's
  questions correct at their recommended_level.
  Map weak domains to their child codes:
    reading   → Rt, Rs, Rw
    writing   → Wt, Ws, Ww
    listening → Lr
    speaking  → Sc, Sd
- "confidence" is a 0..1 number representing how sure you are. Below
  0.7 means the evidence is mixed or sparse; the caller will assign one
  level lower as a safety measure.
- "rationale" is a single paragraph (2-3 sentences) explaining the
  level call in plain English. The org admin will read this verbatim.

Return STRICT JSON only, no preamble:
{
  "esol_level": "e1" | "e2" | "e3" | "l1" | "l2",
  "confidence": number,                // 0.0 to 1.0
  "skill_weakness_flags": string[],    // subset of the 9 ILR codes above
  "rationale": string                  // 2-3 sentences, plain English
}`;

const SCORING_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    esol_level: { type: "string", enum: ["e1", "e2", "e3", "l1", "l2"] },
    confidence: { type: "number" },
    skill_weakness_flags: {
      type: "array",
      items: { type: "string", enum: ALL_ILR_CODES as readonly string[] },
    },
    rationale: { type: "string" },
  },
  required: ["esol_level", "confidence", "skill_weakness_flags", "rationale"],
};

interface GeminiScoringResponse {
  esol_level: EsolLevel;
  confidence: number;
  skill_weakness_flags: IlrSkillCode[];
  rationale: string;
}

const LEVELS_ORDERED: EsolLevel[] = ["e1", "e2", "e3", "l1", "l2"];

/** One level below `level`. e1 stays at e1 (no lower bucket). */
const oneLevelLower = (level: EsolLevel): EsolLevel => {
  const idx = LEVELS_ORDERED.indexOf(level);
  if (idx <= 0) return "e1";
  return LEVELS_ORDERED[idx - 1];
};

/**
 * Build the user-message payload Gemini scores. Each question shows the
 * stem (English only — the rubric works on language meaning, not on
 * presentation), every option's English text, the correct option, and
 * the learner's submitted option.
 */
const buildScoringPayload = (
  bank: PlacementBank,
  answers: AnsweredQuestion[]
): string => {
  const rows = answers.map((a, idx) => {
    const q = bank.questions.find((b) => b.id === a.question_id);
    if (!q) {
      // Caller has already validated this — guard remains as defence.
      throw new ApiError(
        500,
        `Bank does not contain answered question ${a.question_id}`
      );
    }
    const optionLines = q.options
      .map((o) => `    ${o.id}) ${o.text_en}`)
      .join("\n");
    return [
      `Q${idx + 1} [${q.level} / ${q.skill_domain}, weight=${q.difficulty_weight}]`,
      `  Stem: ${q.question_en}`,
      `  Options:`,
      optionLines,
      `  Correct answer: ${q.correct_answer}`,
      `  Learner answered: ${a.answer}  (${a.was_correct ? "correct" : "wrong"})`,
    ].join("\n");
  });
  return [
    "Score this learner's 20-question placement attempt. Return JSON only.",
    "",
    rows.join("\n\n"),
  ].join("\n");
};

/** Validate Gemini's JSON against the expected shape. Returns the
 *  parsed object or throws with a specific error. */
const parseScoringResponse = (raw: string): GeminiScoringResponse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Gemini returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Gemini response is not an object");
  }
  const p = parsed as Partial<GeminiScoringResponse>;
  if (!p.esol_level || !LEVELS_ORDERED.includes(p.esol_level)) {
    throw new Error(`Invalid esol_level: ${p.esol_level}`);
  }
  if (
    typeof p.confidence !== "number" ||
    !Number.isFinite(p.confidence) ||
    p.confidence < 0 ||
    p.confidence > 1
  ) {
    throw new Error(`Invalid confidence: ${p.confidence}`);
  }
  if (!Array.isArray(p.skill_weakness_flags)) {
    throw new Error("skill_weakness_flags must be an array");
  }
  const validCodes = new Set<string>(ALL_ILR_CODES);
  for (const flag of p.skill_weakness_flags) {
    if (typeof flag !== "string" || !validCodes.has(flag)) {
      throw new Error(`Invalid skill_weakness_flag: ${flag}`);
    }
  }
  if (typeof p.rationale !== "string" || p.rationale.trim() === "") {
    throw new Error("rationale must be a non-empty string");
  }
  return p as GeminiScoringResponse;
};

/** Single Gemini call. Throws if the response is empty / malformed —
 *  the caller decides whether to retry. */
const callGeminiOnce = async (
  prompt: string
): Promise<GeminiScoringResponse> => {
  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: {
      role: "system",
      parts: [{ text: SCORING_SYSTEM_PROMPT }],
    },
    generationConfig: {
      // Per the gemini.ts contract — responseMimeType is per-request only.
      responseMimeType: "application/json",
      responseSchema: SCORING_RESPONSE_SCHEMA as any,
      temperature: SCORING_TEMPERATURE,
      maxOutputTokens: SCORING_MAX_TOKENS,
    },
  });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  const text =
    result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) {
    throw new Error("Empty response from Gemini");
  }
  return parseScoringResponse(text);
};

/**
 * Score the placement attempt with Gemini and commit the result.
 *
 * Pipeline:
 *   1. Idempotency lock on sha256(learnerId + "placement_submit")
 *   2. Cross-check the body answers against the persisted attempt
 *   3. Call Gemini with retry-once-on-parse-failure
 *   4. Fall back to e1 if both attempts fail (logged)
 *   5. Confidence < 0.70 → drop one level (conservative placement)
 *   6. Persist result on the attempt, patch the User, AuditLog row
 *   7. Stub Stage 3 objectives (To-Do 8.4)
 */
export const scorePlacement = async (
  learnerId: string,
  body: { answers: { question_id: string; answer: string }[] }
): Promise<ApiResponse> => {
  if (!Array.isArray(body.answers) || body.answers.length !== TOTAL_QUESTIONS) {
    throw new ApiError(
      400,
      `Body must contain exactly ${TOTAL_QUESTIONS} answers, got ${body.answers?.length ?? 0}`
    );
  }

  const attempt = await PlacementAttempt.findOne({
    learnerId,
    status: { $in: ["in_progress", "submitted"] },
  }).sort({ startedAt: -1 });
  if (!attempt) {
    throw new ApiError(
      404,
      "No active placement attempt for this learner — call /placement/start first"
    );
  }
  if (attempt.answers.length !== TOTAL_QUESTIONS) {
    throw new ApiError(
      409,
      `Attempt has ${attempt.answers.length}/${TOTAL_QUESTIONS} answers; complete them via /answer first`
    );
  }

  // Body answers must match the persisted attempt's answers, in order.
  // The body is essentially a self-check that the wizard and the server
  // agree on what was submitted — protects against a stale wizard cache.
  for (let i = 0; i < TOTAL_QUESTIONS; i += 1) {
    const persisted = attempt.answers[i];
    const claimed = body.answers[i];
    if (
      !claimed ||
      claimed.question_id !== persisted.question_id ||
      claimed.answer !== persisted.answer
    ) {
      throw new ApiError(
        409,
        `Body answer #${i + 1} does not match the persisted attempt — ` +
          `the wizard's view of the attempt is out of date. Refresh and resubmit.`
      );
    }
  }

  const bank = loadPlacementBank();

  // ── Idempotency wrap: re-submitting the same attempt returns the
  //    cached result, never re-charges Gemini.
  const key = createHash("sha256")
    .update(`${learnerId}|placement_submit|${attempt._id.toString()}`)
    .digest("hex");

  const outcome = await IdempotencyService.check(
    key,
    "placement-scoring",
    async () => {
      // ── 1. Call Gemini (retry once on parse failure) ──────────────
      let scored: GeminiScoringResponse | null = null;
      let lastError: Error | null = null;
      const prompt = buildScoringPayload(bank, attempt.answers);
      for (const attemptNum of [1, 2]) {
        try {
          scored = await callGeminiOnce(prompt);
          break;
        } catch (err) {
          lastError = err as Error;
          logger.warn(
            { err, learnerId, attemptId: attempt._id.toString(), attemptNum },
            "Gemini placement scoring call failed — will retry"
          );
        }
      }

      // ── 2. Fallback to e1 if both calls failed ────────────────────
      let suggested: GeminiScoringResponse;
      let fellBackToE1 = false;
      if (!scored) {
        logger.error(
          { err: lastError, learnerId, attemptId: attempt._id.toString() },
          "Gemini scoring failed twice — falling back to e1"
        );
        fellBackToE1 = true;
        suggested = {
          esol_level: LEVEL_FALLBACK,
          confidence: 0,
          skill_weakness_flags: [],
          rationale:
            "Automatic scoring was unavailable for this attempt. The learner " +
            "has been provisionally placed at Entry 1 pending tutor review.",
        };
      } else {
        suggested = scored;
      }

      // ── 3. Confidence-conservative downshift ──────────────────────
      const finalLevel: EsolLevel =
        suggested.confidence < CONFIDENCE_CONSERVATIVE_FLOOR
          ? oneLevelLower(suggested.esol_level)
          : suggested.esol_level;

      // ── 4. Persist result on the attempt ──────────────────────────
      const result: PlacementResult = {
        nqf_level: finalLevel,
        placement_confidence: suggested.confidence,
        skill_breakdown: {}, // populated by To-Do 8.4 (per-domain rollup)
        weakness_flags: suggested.skill_weakness_flags,
        rationale: suggested.rationale,
      };
      attempt.result = result;
      attempt.status = "scored";
      attempt.submittedAt = attempt.submittedAt ?? new Date();
      attempt.scoredAt = new Date();
      await attempt.save();

      // ── 5. Patch User: esolLevel + merged skill_weakness_flags ────
      const learner = await User.findById(attempt.learnerId);
      const beforeLevel = learner?.esolLevel ?? null;
      if (learner) {
        learner.esolLevel = finalLevel;
        const existing = new Set<string>(learner.skillWeaknessFlags ?? []);
        for (const f of suggested.skill_weakness_flags) existing.add(f);
        learner.skillWeaknessFlags = ALL_ILR_CODES.filter((c) =>
          existing.has(c)
        );
        await learner.save();
      }

      // ── 6. AuditLog ──────────────────────────────────────────────
      const ilrConfig = ComplianceConfigService.getCurrent("ilr");
      await AuditLog.create({
        timestamp: new Date(),
        actor_type: "system",
        actor_id: null,
        org_id: attempt.orgId,
        learner_id: attempt.learnerId,
        action: "placement_completed",
        before_state: { esol_level: beforeLevel },
        after_state: {
          esol_level: finalLevel,
          placement_confidence: suggested.confidence,
          skill_weakness_flags: suggested.skill_weakness_flags,
          attempt_id: attempt._id.toString(),
          fell_back_to_e1: fellBackToE1,
          downshifted_for_low_confidence:
            suggested.confidence < CONFIDENCE_CONSERVATIVE_FLOOR,
        },
        reason: "Placement assessment scored by Gemini",
        compliance_config_version: ilrConfig?.version ?? null,
      }).catch((err) =>
        logger.error(
          { err, attemptId: attempt._id.toString() },
          "AuditLog write failed for placement_completed"
        )
      );

      // ── 7. Stage 3 objectives (brief Function 6 To-Do 4) ──────────
      // Real generator now — template-driven per skill_domain, merged
      // against any prior teacher-set objectives.
      let stage3_objectives: Awaited<
        ReturnType<typeof createStage3ObjectivesFromPlacement>
      > = [];
      try {
        stage3_objectives = await createStage3ObjectivesFromPlacement(
          attempt.learnerId.toString(),
          finalLevel,
          suggested.skill_weakness_flags
        );
      } catch (err) {
        // Don't fail the scoring response on a Stage-3 hiccup — the
        // placement-completed AuditLog already captured the level call.
        // The teacher can re-derive objectives via the Stage 3 view.
        logger.error(
          { err, learnerId: attempt.learnerId.toString() },
          "Stage 3 objective creation failed after placement scoring"
        );
      }

      return {
        esol_level: finalLevel,
        confidence: suggested.confidence,
        rationale: suggested.rationale,
        stage3_objectives,
      };
    },
    { org_id: attempt.orgId.toString(), learner_id: attempt.learnerId.toString() }
  );

  return new ApiResponse(
    200,
    outcome.hit ? "Placement already scored" : "Placement scored",
    outcome.result
  );
};

// Re-export so the tests can introspect the attempt type without
// importing from two paths.
export type { IPlacementAttempt };
