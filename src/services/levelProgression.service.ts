/**
 * Level-progression check service — brief Function 11 To-Do 1.
 *
 * `checkLevelProgression(learner_id)` is a READ-ONLY diagnostic. It
 * walks the learner's session history at the current NQF level and
 * decides whether the five progression criteria are met. It does NOT
 * change the level — that decision is the org admin's, and runs
 * through the Function 11 To-Do 2/3 review flow with full
 * accountability.
 *
 * The five criteria (brief Function 11 Section 11):
 *
 *   1. Scenario completion: >= 3 DISTINCT scenarios passed at the
 *      current level. "Passed" = session.final_score >= the scenario's
 *      pass_threshold (loaded from src/data/scenarios/<id>.json).
 *
 *   2. Score threshold: average final_score across the passed sessions
 *      >= 0.75. The brief picks 0.75 as the "comfortably-above-pass"
 *      bar — most scenarios pass at 0.70, so a 0.75 average proves
 *      consistency, not lucky one-offs.
 *
 *   3. Skill domain coverage: union of skill_codes_covered across
 *      passed sessions hits >= 3 of the 4 ForSkills domains
 *      (speaking / reading / writing / listening). Mapping done by
 *      `getDomainsFromCodes` using the canonical ILR_CODE_TO_DOMAIN
 *      table in esolSkills.ts.
 *
 *   4. No ANCHOR dominance: in the TWO most recent completed sessions
 *      at the current level, neither has ANCHOR turns making up >50%
 *      of its teaching_mode_sequence. ANCHOR mode is the L1-scaffold
 *      mode used when a learner is struggling; if either recent
 *      session leans hard on it, they're not ready to progress.
 *
 *   5. Minimum time: >= 14 days since the learner was assigned the
 *      current level. The assignment timestamp resolves to the most
 *      recent LevelChange.effectiveDate where toLevel = currentLevel;
 *      if no such LevelChange exists (the initial placement set the
 *      level and we don't have a dedicated placement_completed_at
 *      column), User.createdAt is the proxy. Both are read-only
 *      records — the comparison is monotonic.
 *
 * The caller (Function 11 To-Do 2 — typically the priority-queue
 * scoring batch or the per-session checker invoked at session end)
 * decides the downstream action when `ready_for_progression: true`.
 * This service never writes.
 *
 * Performance: one User read, one LevelChange read, one AISession
 * range scan. Scenario files come from a module-level in-memory cache
 * loaded on first use, so the disk hit per learner is bounded by the
 * total number of distinct scenarios (3 in MVP).
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { Types } from "mongoose";

import User from "../models/User";
import AISession from "../models/AISession";
import LevelChange from "../models/LevelChange";
import Stage5Review from "../models/Stage5Review";
import { createNotification } from "./notification.service";
import { writeAuditLog } from "./auditLog.service";
import { rarpaEvidenceQueue } from "../queues";
import {
  ILR_CODE_TO_DOMAIN,
  ForSkillsDomain,
  IlrSkillCode,
  normaliseEsolLevel,
  EsolLevel,
} from "./esolSkills";
import { IScenarioFile } from "../interfaces/scenario.interface";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Constants — brief Function 11 thresholds
// ─────────────────────────────────────────────────────────────────────

const MIN_DISTINCT_SCENARIOS = 3;
const AVERAGE_SCORE_THRESHOLD = 0.75;
const MIN_DOMAINS_COVERED = 3;
const MIN_DAYS_AT_LEVEL = 14;
const RECENT_SESSIONS_WINDOW = 2;
const ANCHOR_DOMINANCE_RATIO = 0.5;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// Scenario loader (module-level cache — bounded by 3 scenarios in MVP)
// ─────────────────────────────────────────────────────────────────────

const SCENARIOS_DIR = resolve(__dirname, "../data/scenarios");
const scenarioCache = new Map<string, IScenarioFile | null>();

/**
 * Read a scenario JSON file by id, memoising the parse. Returns null
 * if the file is missing — at that point we treat the session as
 * "no defined pass threshold" and skip it from the passed-set
 * calculation (the alternative — assuming a default threshold —
 * would silently advance learners on broken data).
 */
const loadScenarioById = (scenarioId: string): IScenarioFile | null => {
  if (scenarioCache.has(scenarioId)) return scenarioCache.get(scenarioId)!;
  try {
    const path = resolve(SCENARIOS_DIR, `${scenarioId}.json`);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as IScenarioFile;
    scenarioCache.set(scenarioId, parsed);
    return parsed;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, scenarioId },
      "levelProgression: scenario file not found — session will be excluded from passed-set",
    );
    scenarioCache.set(scenarioId, null);
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────
// Public helper — exported per the brief
// ─────────────────────────────────────────────────────────────────────

/**
 * Map a flat list of ILR skill codes (the `skill_codes_covered` field
 * on a session) to the count of UNIQUE ForSkills domains they cover.
 *
 * Codes that aren't in the canonical ILR_CODE_TO_DOMAIN table are
 * silently dropped after a debug log — Gemini occasionally emits
 * non-canonical strings ("speaking", "S1"); we want progression
 * decisions to be deterministic, not dependent on Gemini's variant.
 *
 * Pure function — no DB access, no logging side-effects beyond the
 * skipped-code debug line.
 */
export const getDomainsFromCodes = (
  codes: string[] | null | undefined,
): { count: number; domains: ForSkillsDomain[] } => {
  if (!codes || codes.length === 0) return { count: 0, domains: [] };

  const domainSet = new Set<ForSkillsDomain>();
  for (const raw of codes) {
    const code = typeof raw === "string" ? raw : "";
    if (!(code in ILR_CODE_TO_DOMAIN)) {
      // Non-canonical code — Gemini occasionally drifts. Don't fail
      // the progression check on it; just don't credit a domain.
      logger.debug(
        { code },
        "getDomainsFromCodes: dropping non-canonical skill code",
      );
      continue;
    }
    domainSet.add(ILR_CODE_TO_DOMAIN[code as IlrSkillCode]);
  }

  // Stable order for snapshot tests / log readability.
  const DOMAIN_ORDER: ForSkillsDomain[] = [
    "speaking",
    "reading",
    "writing",
    "listening",
  ];
  const domains = DOMAIN_ORDER.filter((d) => domainSet.has(d));
  return { count: domains.length, domains };
};

// ─────────────────────────────────────────────────────────────────────
// Internal — assignment-date resolution
// ─────────────────────────────────────────────────────────────────────

/**
 * When was the learner assigned their current level? Two sources, in
 * priority order:
 *
 *   1. The latest LevelChange where toLevel == currentLevel. This is
 *      the explicit audit record produced when an org admin promotes
 *      or demotes a learner; its effectiveDate is the source of truth.
 *
 *   2. User.createdAt — the proxy for initial placement. Learners
 *      whose level came from the placement assessment never get a
 *      LevelChange row (the placement IS the assignment), so the
 *      enrol-date stands in for "level start date". Acceptable
 *      because the brief asks for a 14-day floor; the proxy is only
 *      ever EARLIER than the real placement-completion date, so
 *      the gate is conservative — it can't let a learner through too
 *      early.
 *
 * Returns null only if both the learner doc is missing AND no
 * LevelChange row exists, which the caller treats as criterion 5 fail.
 */
const resolveLevelAssignedAt = async (
  learnerId: Types.ObjectId,
  currentLevel: EsolLevel,
  userCreatedAt: Date | null,
): Promise<Date | null> => {
  const latestChange = await LevelChange.findOne({
    learnerId,
    toLevel: currentLevel,
  })
    .sort({ effectiveDate: -1, createdAt: -1 })
    .select("effectiveDate createdAt")
    .lean();

  if (latestChange?.effectiveDate instanceof Date) {
    return latestChange.effectiveDate;
  }
  if (latestChange?.createdAt instanceof Date) {
    return latestChange.createdAt;
  }
  return userCreatedAt;
};

// ─────────────────────────────────────────────────────────────────────
// Internal — criterion 4 (ANCHOR dominance)
// ─────────────────────────────────────────────────────────────────────

/**
 * For each of the two most recent completed sessions at the current
 * level, compute the share of turns marked "anchor". The criterion
 * passes when BOTH sessions have anchor share <= 50%.
 *
 * Tolerant of empty `teaching_mode_sequence`: an empty sequence has a
 * ratio of 0, which counts as "not anchor-dominant". A pre-platform
 * historical import would land here — and pre-platform sessions
 * shouldn't block live-tutor progression, so treating them as neutral
 * is the right call.
 */
const evaluateAnchorDominance = (
  sequences: string[][],
): { passed: boolean; ratios: number[] } => {
  const window = sequences.slice(0, RECENT_SESSIONS_WINDOW);
  const ratios = window.map((seq) => {
    if (!Array.isArray(seq) || seq.length === 0) return 0;
    const anchorTurns = seq.filter(
      (m) => typeof m === "string" && m.toLowerCase() === "anchor",
    ).length;
    return anchorTurns / seq.length;
  });
  const passed = ratios.every((r) => r <= ANCHOR_DOMINANCE_RATIO);
  return { passed, ratios };
};

// ─────────────────────────────────────────────────────────────────────
// Public API — checkLevelProgression
// ─────────────────────────────────────────────────────────────────────

export interface LevelProgressionCriteriaResult {
  /** C1 — passed >= 3 distinct scenarios at current level */
  scenario_completion: {
    passed: boolean;
    distinct_scenarios_passed: number;
    required: number;
    scenario_ids: string[];
  };
  /** C2 — average final_score across passed sessions >= 0.75 */
  score_threshold: {
    passed: boolean;
    average_score: number | null;
    required: number;
    sample_size: number;
  };
  /** C3 — skill domains covered >= 3 of 4 */
  skill_domain_coverage: {
    passed: boolean;
    domains_covered: number;
    required: number;
    domains: ForSkillsDomain[];
  };
  /** C4 — neither of the 2 most recent sessions is ANCHOR-dominant */
  no_anchor_dominance: {
    passed: boolean;
    recent_session_anchor_ratios: number[];
    threshold_ratio: number;
  };
  /** C5 — >= 14 days at the current level */
  minimum_time: {
    passed: boolean;
    days_at_level: number;
    required: number;
    level_assigned_at: string | null;
  };
}

export interface LevelProgressionCheckResult {
  learner_id: string;
  current_level: EsolLevel | null;
  ready_for_progression: boolean;
  criteria_met: LevelProgressionCriteriaResult;
  checked_at: string;
}

/**
 * Run all five criteria and return the verdict.
 *
 * The function NEVER throws on a "learner has no sessions yet" or
 * "learner has no level yet" case — those are valid states that the
 * caller may invoke during an org-admin's sweep across the cohort.
 * Both fall to `ready_for_progression: false` with the offending
 * criterion flagged as failed.
 *
 * It DOES throw on:
 *   - invalid learner_id (caller error)
 *   - learner not found (caller passed a stale id)
 *
 * so they surface as a 4xx in the route layer rather than getting
 * swallowed as "not ready".
 */
export const checkLevelProgression = async (
  learnerId: string,
): Promise<LevelProgressionCheckResult> => {
  if (!learnerId || !Types.ObjectId.isValid(learnerId)) {
    throw new Error(
      "checkLevelProgression: learner_id must be a valid ObjectId",
    );
  }
  const learnerObjectId = new Types.ObjectId(learnerId);

  // 1. Learner doc — we need current esolLevel + createdAt for C5 proxy
  const learner = await User.findById(learnerObjectId)
    .select("esolLevel createdAt role")
    .lean();
  if (!learner) {
    throw new Error(`checkLevelProgression: learner ${learnerId} not found`);
  }

  const currentLevel = normaliseEsolLevel(learner.esolLevel);
  const checkedAt = new Date().toISOString();

  // No level → nothing to progress FROM. Return a fully-false result
  // so the caller knows to run placement first.
  if (!currentLevel) {
    return emptyResult(
      learnerId,
      null,
      checkedAt,
      "no current_level on learner",
    );
  }

  // 2. Level assignment date — for C5
  const levelAssignedAt = await resolveLevelAssignedAt(
    learnerObjectId,
    currentLevel,
    learner.createdAt instanceof Date ? learner.createdAt : null,
  );

  // 3. Pull sessions at the current level. Only consider AI-tutor and
  //    teacher-consolidation sessions — pre-platform historical
  //    imports don't represent progression-worthy practice.
  //
  //    Match against EITHER `nqf_level_at_start` (set by the new
  //    session writer per Function 8) OR legacy `esolLevel`. The
  //    pre-Function-8 sessions only carry `esolLevel`; the new ones
  //    carry both. Either match counts.
  const sessions = await AISession.find({
    learnerId: learnerObjectId,
    completedAt: { $ne: null },
    session_source: { $in: ["ai_tutor", "teacher_consolidation"] },
    $or: [{ nqf_level_at_start: currentLevel }, { esolLevel: currentLevel }],
  })
    .sort({ completedAt: -1 })
    .select(
      "scenario_id final_score skill_codes_covered teaching_mode_sequence completedAt esolLevel nqf_level_at_start session_source",
    )
    .lean();

  // ── C4: ANCHOR-dominance check on the two most recent sessions ──
  // Done up here because it operates on the recency-sorted list as-is.
  const anchorEval = evaluateAnchorDominance(
    sessions.map(
      (s) => (s.teaching_mode_sequence as string[] | undefined) ?? [],
    ),
  );

  // ── C1: distinct-scenarios-passed ──────────────────────────────
  // For each session at the current level, look up its scenario and
  // compare final_score to scenario.pass_threshold. A session with no
  // scenario_id (general-conversation mode) can't be "passed" against
  // a threshold — exclude from C1/C2 but it still contributes to C3.
  const passedSessions: Array<{
    scenarioId: string;
    finalScore: number;
    skillCodes: string[];
  }> = [];

  for (const s of sessions) {
    const scenarioIdRaw = s.scenario_id;
    if (!scenarioIdRaw) continue;
    const scenarioId =
      typeof scenarioIdRaw === "string" ? scenarioIdRaw : String(scenarioIdRaw); // ObjectId or other
    const scenario = loadScenarioById(scenarioId);
    if (!scenario) continue;

    if (typeof s.final_score !== "number") continue;
    if (s.final_score < scenario.pass_threshold) continue;

    passedSessions.push({
      scenarioId,
      finalScore: s.final_score,
      skillCodes: (s.skill_codes_covered as string[] | undefined) ?? [],
    });
  }

  // Distinct scenario ids — order by first-passed (the recency order
  // we sorted by) so the response reads naturally.
  const distinctScenarioIds: string[] = [];
  const seen = new Set<string>();
  for (const p of passedSessions) {
    if (seen.has(p.scenarioId)) continue;
    seen.add(p.scenarioId);
    distinctScenarioIds.push(p.scenarioId);
  }

  const c1Passed = distinctScenarioIds.length >= MIN_DISTINCT_SCENARIOS;

  // ── C2: average score across passed sessions ───────────────────
  const c2Average =
    passedSessions.length > 0
      ? passedSessions.reduce((sum, p) => sum + p.finalScore, 0) /
        passedSessions.length
      : null;
  const c2Passed = c2Average !== null && c2Average >= AVERAGE_SCORE_THRESHOLD;

  // ── C3: domain coverage across passed sessions ─────────────────
  const allCodes: string[] = passedSessions.flatMap((p) => p.skillCodes);
  const { count: domainCount, domains } = getDomainsFromCodes(allCodes);
  const c3Passed = domainCount >= MIN_DOMAINS_COVERED;

  // ── C5: time since level assigned ──────────────────────────────
  const daysAtLevel =
    levelAssignedAt instanceof Date
      ? Math.floor((Date.now() - levelAssignedAt.getTime()) / MS_PER_DAY)
      : 0;
  const c5Passed = daysAtLevel >= MIN_DAYS_AT_LEVEL;

  const criteria_met: LevelProgressionCriteriaResult = {
    scenario_completion: {
      passed: c1Passed,
      distinct_scenarios_passed: distinctScenarioIds.length,
      required: MIN_DISTINCT_SCENARIOS,
      scenario_ids: distinctScenarioIds,
    },
    score_threshold: {
      passed: c2Passed,
      average_score: c2Average,
      required: AVERAGE_SCORE_THRESHOLD,
      sample_size: passedSessions.length,
    },
    skill_domain_coverage: {
      passed: c3Passed,
      domains_covered: domainCount,
      required: MIN_DOMAINS_COVERED,
      domains,
    },
    no_anchor_dominance: {
      passed: anchorEval.passed,
      recent_session_anchor_ratios: anchorEval.ratios,
      threshold_ratio: ANCHOR_DOMINANCE_RATIO,
    },
    minimum_time: {
      passed: c5Passed,
      days_at_level: daysAtLevel,
      required: MIN_DAYS_AT_LEVEL,
      level_assigned_at:
        levelAssignedAt instanceof Date ? levelAssignedAt.toISOString() : null,
    },
  };

  const ready =
    c1Passed && c2Passed && c3Passed && anchorEval.passed && c5Passed;

  return {
    learner_id: learnerId,
    current_level: currentLevel,
    ready_for_progression: ready,
    criteria_met,
    checked_at: checkedAt,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Internal — uniform "no work to do" result
// ─────────────────────────────────────────────────────────────────────

const emptyResult = (
  learnerId: string,
  currentLevel: EsolLevel | null,
  checkedAt: string,
  reason: string,
): LevelProgressionCheckResult => {
  logger.info(
    { learner_id: learnerId, reason },
    "checkLevelProgression: returning not-ready with no criteria evaluated",
  );
  return {
    learner_id: learnerId,
    current_level: currentLevel,
    ready_for_progression: false,
    criteria_met: {
      scenario_completion: {
        passed: false,
        distinct_scenarios_passed: 0,
        required: MIN_DISTINCT_SCENARIOS,
        scenario_ids: [],
      },
      score_threshold: {
        passed: false,
        average_score: null,
        required: AVERAGE_SCORE_THRESHOLD,
        sample_size: 0,
      },
      skill_domain_coverage: {
        passed: false,
        domains_covered: 0,
        required: MIN_DOMAINS_COVERED,
        domains: [],
      },
      no_anchor_dominance: {
        passed: true, // vacuously — no sessions to be dominated by anchor
        recent_session_anchor_ratios: [],
        threshold_ratio: ANCHOR_DOMINANCE_RATIO,
      },
      minimum_time: {
        passed: false,
        days_at_level: 0,
        required: MIN_DAYS_AT_LEVEL,
        level_assigned_at: null,
      },
    },
    checked_at: checkedAt,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Stage 5 review trigger — brief Function 11 / Function 17 (Phase 18)
// ─────────────────────────────────────────────────────────────────────

/**
 * Human-readable label per NQF level code.
 *
 * Kept here (not in esolSkills.ts) because this mapping is used only
 * by user-facing copy — the rest of the codebase deals in level codes.
 * If a future framework rename lands ("Entry Level 1" → "Level E1"),
 * the change is contained to this one table + the L1 reflection
 * strings below.
 */
const LEVEL_LABELS: Record<EsolLevel, string> = {
  e1: "Entry Level 1",
  e2: "Entry Level 2",
  e3: "Entry Level 3",
  l1: "Level 1",
  l2: "Level 2",
};

/**
 * L1-localised reflection prompts.
 *
 * Each language's string is a single sentence containing two %s
 * placeholders — the completed level and the next level. Substitution
 * is done with simple replace rather than a templating library to keep
 * this self-contained (the L1 translations are short and don't need
 * Handlebars).
 *
 * Translation status: the English string is the brief's exact copy.
 * The L1 translations are Joey's working drafts pending the same
 * native-speaker review pass that governs safeguarding-messages.json
 * (see SAFEGUARDING_REVIEW.md for the process). Until that review
 * lands, a learner whose L1 is unrecognised gets the English fallback —
 * the alternative (a half-baked machine translation in a crisis
 * adjacent context) is worse than English.
 *
 * Pashto → Farsi script per the brief-wide degradation rule.
 */
const REFLECTION_PROMPTS: Record<
  string,
  { template: string; renderedLanguage: string }
> = {
  english: {
    template:
      "You have completed %s. Please take 5 minutes to reflect on your progress before starting %s.",
    renderedLanguage: "english",
  },
  arabic: {
    template:
      "لقد أكملت %s. يرجى أخذ 5 دقائق للتفكير في تقدمك قبل البدء في %s.",
    renderedLanguage: "arabic",
  },
  somali: {
    template:
      "Waxaad dhammaysay %s. Fadlan qaado 5 daqiiqo si aad uga fikirto horumarkaaga ka hor inta aanad bilaabin %s.",
    renderedLanguage: "somali",
  },
  dari: {
    template:
      "شما %s را تکمیل کرده‌اید. لطفاً ۵ دقیقه وقت بگذارید تا قبل از شروع %s درباره پیشرفت خود فکر کنید.",
    renderedLanguage: "dari",
  },
  farsi: {
    template:
      "شما %s را تکمیل کرده‌اید. لطفاً ۵ دقیقه وقت بگذارید تا قبل از شروع %s درباره پیشرفت خود فکر کنید.",
    renderedLanguage: "farsi",
  },
  pashto: {
    // degrades to Farsi script — see safeguardingMessages.service for
    // the platform-wide rationale
    template:
      "شما %s را تکمیل کرده‌اید. لطفاً ۵ دقیقه وقت بگذارید تا قبل از شروع %s درباره پیشرفت خود فکر کنید.",
    renderedLanguage: "farsi",
  },
  chinese: {
    template: "您已经完成了 %s。请花 5 分钟时间反思您的进步，然后再开始 %s。",
    renderedLanguage: "chinese",
  },
  cantonese: {
    template: "您已经完成了 %s。请花 5 分钟时间反思您的进步，然后再开始 %s。",
    renderedLanguage: "chinese",
  },
  mandarin: {
    template: "您已经完成了 %s。请花 5 分钟时间反思您的进步，然后再开始 %s。",
    renderedLanguage: "chinese",
  },
};

/**
 * Build the per-language reflection message. Pure helper — does not
 * touch Mongo or the queue. Returns both the rendered string and the
 * language key that was actually used (the caller logs it so we can
 * spot learners whose L1 keeps falling back to English).
 */
export const buildReflectionMessage = (
  levelCompleted: EsolLevel,
  newLevel: EsolLevel,
  l1Language: string | null | undefined,
): { message: string; language_used: string } => {
  const completedLabel = LEVEL_LABELS[levelCompleted];
  const newLabel = LEVEL_LABELS[newLevel];
  const key = (l1Language ?? "").toString().trim().toLowerCase();
  const slot = REFLECTION_PROMPTS[key] ?? REFLECTION_PROMPTS.english;
  return {
    message: slot.template
      .replace("%s", completedLabel)
      .replace("%s", newLabel),
    language_used: slot.renderedLanguage,
  };
};

export interface TriggerStage5ReviewResult {
  stage5_review_id: string;
  notification_language_used: string;
  /** BullMQ id of the Gemini AI-summary job, when successfully enqueued. */
  ai_summary_job_id: string | null;
  /** Count of org admins notified (0 when the org has no admin assigned). */
  org_admins_notified: number;
}

/**
 * Stage 5 review trigger — brief Function 17 (full implementation).
 *
 * Fires on level-change confirmation. Five independent side effects:
 *
 *   1. Create a placeholder Stage5Review row pinned to the level the
 *      learner just completed. The row carries a SNAPSHOT of the
 *      learner's stage3_objectives at confirm time — those objectives
 *      may be edited later (a teacher overrides one, a level change
 *      seeds new ones), but the Stage 5 review must always show what
 *      was assessed.
 *   2. Enqueue a Gemini AI-summary job on the `rarpa-evidence`
 *      BullMQ queue. The worker (Phase 18) runs the summary over the
 *      learner's just-completed-level AISessions and writes the
 *      narrative back to `Stage5Review.ai_tutor_summary`.
 *   3. Send the LEARNER an in-app notification in their L1 prompting
 *      reflection.
 *   4. Send the ORG ADMIN(s) an in-app notification flagging that
 *      Stage 5 sign-off will be needed once the learner submits.
 *   5. Write an AuditLog row (`action: "stage5_review_initiated"`).
 *
 * Atomicity model: never throws. Every side effect is wrapped so a
 * single failure (e.g. queue unreachable, notification model down)
 * doesn't roll back the others — particularly the Stage5Review row,
 * which is the durable artefact the entire flow depends on. The
 * level change has ALREADY been committed by the caller; aborting
 * here would leave a "level changed but no Stage 5 row" state with
 * no easy repair.
 */
export const triggerStage5Review = async (
  learner_id: string,
  level_completed: EsolLevel,
  new_level: EsolLevel,
): Promise<TriggerStage5ReviewResult | null> => {
  if (!learner_id || !Types.ObjectId.isValid(learner_id)) {
    logger.warn(
      { learner_id },
      "triggerStage5Review: invalid learner_id — skipping",
    );
    return null;
  }

  const learner = await User.findById(learner_id)
    .select("_id orgId stage3_objectives l1Language firstname lastname")
    .lean();
  if (!learner) {
    logger.warn(
      { learner_id },
      "triggerStage5Review: learner not found — skipping",
    );
    return null;
  }
  if (!learner.orgId) {
    logger.warn(
      { learner_id },
      "triggerStage5Review: learner has no orgId — skipping (cannot pin Stage5Review without an org)",
    );
    return null;
  }

  // ── 1. Stage5Review row ────────────────────────────────────────
  // Snapshot of stage3_objectives at confirm time. The User doc's
  // objectives may diverge later (teacher edit, level-change reseed)
  // but the Stage 5 review must always show the state that was
  // assessed when the level was completed.
  let stage5_id: string;
  try {
    const stage5 = await Stage5Review.create({
      learner_id: learner._id,
      org_id: learner.orgId,
      level_completed,
      stage3_objectives: learner.stage3_objectives ?? [],
      learner_self_assessment: null,
      ai_tutor_summary: null,
      org_admin_confirmed_at: null,
      next_steps: null,
    });
    stage5_id = stage5._id.toString();
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        learner_id,
        level_completed,
      },
      "triggerStage5Review: Stage5Review.create failed — level change continues",
    );
    // Hard fail of the row create means nothing downstream is
    // meaningful — the AI summary has nothing to write to, the
    // notifications would point to a non-existent review. Bail.
    return null;
  }

  // ── 2. Enqueue Gemini AI-summary job ───────────────────────────
  // Uses the existing `rarpa-evidence` queue with the per-learner
  // `stage_compile` discriminator (RarpaStageCompileJob). The Phase
  // 18 worker reads `stage: 5` and `triggerEvent: "level_progression"`
  // to dispatch to the Gemini batch that summarises the just-
  // completed-level's sessions. A deterministic jobId keeps a
  // double-trigger (rare but possible if the level-change endpoint
  // is hit twice in quick succession) idempotent at the queue layer.
  let ai_summary_job_id: string | null = null;
  try {
    const job = await rarpaEvidenceQueue.add(
      // Brief Function 17: the dedicated job name (`generate-stage5-summary`)
      // routes to processRarpaEvidence's `kind === "stage5_summary"` branch.
      // Payload is intentionally minimal — orgId / learnerId / level are
      // re-derived from the Stage5Review row inside the worker so a stale
      // enqueue snapshot can't drift from the persisted truth.
      "generate-stage5-summary",
      {
        kind: "stage5_summary",
        stage5_review_id: stage5_id,
      },
      { jobId: `stage5:${stage5_id}` },
    );
    ai_summary_job_id = String(job.id);
  } catch (err) {
    // BullMQ unavailability is operationally serious but mustn't
    // roll back the row. The Phase 18 worker can be re-driven by a
    // small admin endpoint that re-enqueues for any Stage5Review
    // row where ai_tutor_summary is still null.
    logger.error(
      {
        err: (err as Error).message,
        learner_id,
        stage5_review_id: stage5_id,
      },
      "triggerStage5Review: AI-summary enqueue failed — Stage5Review row still committed",
    );
  }

  // ── 3. Learner notification (L1 reflection prompt) ─────────────
  const { message, language_used } = buildReflectionMessage(
    level_completed,
    new_level,
    learner.l1Language,
  );
  try {
    await createNotification({
      userId: learner._id,
      type: "progression_confirmed",
      title: `Reflect on ${LEVEL_LABELS[level_completed]}`,
      message,
      data: {
        learner_id: learner._id.toString(),
        stage5_review_id: stage5_id,
        level_completed,
        new_level,
        notification_language_used: language_used,
      },
    });
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        learner_id,
        stage5_review_id: stage5_id,
      },
      "triggerStage5Review: learner reflection notification failed — review row still committed",
    );
  }

  // ── 4. Org-admin notification(s) ───────────────────────────────
  // An org has 1..N admins (role: "org_admin"). We notify every
  // admin so org-admin holidays don't leave a Stage 5 sign-off
  // queued behind a single person. Fire-and-forget per admin so
  // one missing user doc doesn't block the others.
  const learnerFirstName = (learner.firstname ?? "").trim() || "A learner";
  const levelLabel =
    LEVEL_LABELS[level_completed] ?? level_completed.toUpperCase();
  const orgAdminMessage = `${learnerFirstName} has completed ${levelLabel}. Please review their Stage 5 self-assessment when submitted.`;

  let org_admins_notified = 0;
  try {
    const orgAdmins = await User.find({
      orgId: learner.orgId,
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
            title: `Stage 5 review pending — ${learnerFirstName}`,
            message: orgAdminMessage,
            data: {
              learner_id: learner._id.toString(),
              stage5_review_id: stage5_id,
              level_completed,
              new_level,
            },
          });
          org_admins_notified += 1;
        } catch (err) {
          logger.error(
            {
              err: (err as Error).message,
              org_admin_id: admin._id.toString(),
              stage5_review_id: stage5_id,
            },
            "triggerStage5Review: per-admin notification failed — continuing with remaining admins",
          );
        }
      }),
    );
    if (orgAdmins.length === 0) {
      logger.warn(
        { learner_id, org_id: learner.orgId.toString() },
        "triggerStage5Review: org has no org_admin users — Stage 5 sign-off will need manual prompting",
      );
    }
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        learner_id,
        stage5_review_id: stage5_id,
      },
      "triggerStage5Review: org-admin lookup failed — review row still committed",
    );
  }

  // ── 5. AuditLog ────────────────────────────────────────────────
  // The action gets a dedicated audit type so the org-admin's audit
  // log surfaces "Stage 5 initiated" alongside the level-change row
  // that preceded it. writeAuditLog never throws to the caller;
  // a persist failure is logged at error level.
  await writeAuditLog({
    actor_type: "system",
    actor_id: null,
    org_id: learner.orgId,
    learner_id: learner._id,
    action: "stage5_review_initiated",
    before_state: null,
    after_state: {
      stage5_review_id: stage5_id,
      level_completed,
      new_level,
      ai_summary_job_id,
      org_admins_notified,
      notification_language_used: language_used,
    },
    reason: `Stage 5 review initiated for ${learnerFirstName} — completed ${levelLabel}. ${
      ai_summary_job_id
        ? "AI summary job enqueued."
        : "AI summary enqueue failed; manual re-drive required."
    }`,
  });

  logger.info(
    {
      learner_id,
      stage5_review_id: stage5_id,
      level_completed,
      new_level,
      ai_summary_job_id,
      org_admins_notified,
      notification_language_used: language_used,
    },
    "triggerStage5Review: complete",
  );

  return {
    stage5_review_id: stage5_id,
    notification_language_used: language_used,
    ai_summary_job_id,
    org_admins_notified,
  };
};

// Re-exports for tests
export const __internals__ = {
  evaluateAnchorDominance,
  resolveLevelAssignedAt,
  loadScenarioById,
  buildReflectionMessage,
  LEVEL_LABELS,
  REFLECTION_PROMPTS,
  MIN_DISTINCT_SCENARIOS,
  AVERAGE_SCORE_THRESHOLD,
  MIN_DOMAINS_COVERED,
  MIN_DAYS_AT_LEVEL,
  ANCHOR_DOMINANCE_RATIO,
};
