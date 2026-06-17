/**
 * Bridge-Method mode controller — AI Tutor Build Brief F26.
 *
 * The brief is explicit that the ANCHOR / BRIDGE / IMMERSION decision is
 * a PLATFORM responsibility driven by OBSERVABLE SIGNALS, not something
 * we hand wholesale to the model. Gemini still reports the `mode` it
 * thinks it used (it sees nuance we can't — "only L1, no English
 * attempt", "same error three times"), but the server is authoritative:
 *
 *   1. BEFORE the turn, `decideMode` reads the conversation so far +
 *      the learner's level and computes the mode to OPERATE IN and the
 *      L1:English ratio to AIM FOR. That decision is injected into
 *      Layer 5 so Gemini generates its reply already calibrated.
 *   2. AFTER the turn, `reconcileMode` takes the more-supportive of the
 *      controller's directed mode and Gemini's reported mode. We never
 *      record (or carry into the next turn) a mode LESS supportive than
 *      either source believes is warranted — support ratchets down only
 *      when both agree it's safe.
 *
 * Two constraints from the brief shape the design:
 *   - Thresholds are CONFIGURABLE, not hard-coded: they come from the
 *     active `bridge-mode` ComplianceConfig, falling back to
 *     DEFAULT_MODE_THRESHOLDS when none is seeded. Curriculum changes a
 *     number → a config write, no code release.
 *   - L1 is ALWAYS AVAILABLE for distress, overriding the ratio: a
 *     learner who signals confusion gets ANCHOR + "use as much L1 as
 *     you need", regardless of the level's normal L1 band.
 *
 * Ratios come from `CurriculumLevel.bridgeL1Ratio` (seeded from
 * esol_curriculum.json), never invented here.
 */

import ComplianceConfigService from "./ComplianceConfigService";
import CurriculumLevelService from "./curriculumLevel.service";
import { EsolLevel } from "../interfaces/placementQuestion.interface";

export type Mode = "anchor" | "bridge" | "immersion";

/** Support ordering — lower rank = MORE supportive. */
const SUPPORT_RANK: Record<Mode, number> = {
  anchor: 0,
  bridge: 1,
  immersion: 2,
};

export interface ModeThresholds {
  /** turn_score below this on the previous turn → ANCHOR. */
  anchorScoreBelow: number;
  /** learner message shorter than this many words → ANCHOR. */
  anchorMinWords: number;
  /** consecutive high-scoring turns required before IMMERSION. */
  immersionStreak: number;
  /** the score each of those turns must reach. */
  immersionScoreAtLeast: number;
}

/**
 * Brief defaults (Layer 6 "Mode switching" + curriculum). An admin can
 * override any subset via an active `bridge-mode` ComplianceConfig.
 */
export const DEFAULT_MODE_THRESHOLDS: ModeThresholds = {
  anchorScoreBelow: 0.4,
  anchorMinWords: 5,
  immersionStreak: 3,
  immersionScoreAtLeast: 0.8,
};

/**
 * Fallback L1:English bands per level when CurriculumLevel hasn't been
 * seeded (cache empty). Mirrors esol_curriculum.json so the controller
 * degrades to the right ballpark rather than to zero L1.
 */
const FALLBACK_L1_RATIO: Record<EsolLevel, { min: number; max: number }> = {
  e1: { min: 0.6, max: 0.7 },
  e2: { min: 0.4, max: 0.6 },
  e3: { min: 0.3, max: 0.4 },
  l1: { min: 0.1, max: 0.2 },
  l2: { min: 0.0, max: 0.1 },
};

/**
 * Multilingual "I don't understand" / confusion markers across the MVP
 * languages (en / ar / yue / tr). A match forces ANCHOR and unlocks
 * full L1 — the distress override. STARTER set: the safeguarding lead /
 * native reviewers extend this alongside the keyword banks. Kept
 * deliberately small + high-precision so it doesn't fire on ordinary
 * sentences that happen to contain a fragment.
 */
const CONFUSION_PATTERNS: RegExp[] = [
  /\bi (do not|don'?t|dont) understand\b/i,
  /\bi (do not|don'?t|dont) (get|follow|know) (it|this|what)\b/i,
  /\bwhat does (that|this|it) mean\b/i,
  /\bi('?m| am)? (so )?confused\b/i,
  /\btoo (hard|difficult|fast)\b/i,
  // Arabic — "I don't understand" / "difficult"
  /لا أفهم/,
  /لم أفهم/,
  /صعب/,
  // Cantonese / Traditional Chinese — "I don't understand" / "too hard"
  /我唔明/,
  /我不明白/,
  /唔識/,
  /太難/,
  // Turkish — "I don't understand" / "difficult"
  /anlamıyorum/i,
  /anlamadım/i,
  /çok zor/i,
];

export const matchesConfusion = (message: string): boolean => {
  const m = (message ?? "").trim();
  if (!m) return false;
  return CONFUSION_PATTERNS.some((re) => re.test(m));
};

const wordCount = (message: string): number => {
  const t = (message ?? "").trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
};

/**
 * Read the active thresholds. Shallow-merges the `bridge-mode` config's
 * rules over the defaults so a partial override (e.g. only
 * `anchorMinWords`) still yields a complete set.
 */
export const getModeThresholds = (): ModeThresholds => {
  const cfg = ComplianceConfigService.getCurrent("bridge-mode");
  const rules = (cfg?.rules ?? {}) as Partial<ModeThresholds>;
  const merged: ModeThresholds = { ...DEFAULT_MODE_THRESHOLDS };
  for (const key of Object.keys(DEFAULT_MODE_THRESHOLDS) as Array<
    keyof ModeThresholds
  >) {
    const v = rules[key];
    if (typeof v === "number" && Number.isFinite(v)) merged[key] = v;
  }
  return merged;
};

/** L1:English band for a level, from the curriculum (fallback table otherwise). */
export const l1RatioForLevel = (
  level: EsolLevel,
): { min: number; max: number } => {
  const doc = CurriculumLevelService.getLevel(level);
  const band = doc?.bridgeL1Ratio;
  if (
    band &&
    typeof band.min === "number" &&
    typeof band.max === "number" &&
    band.max >= band.min
  ) {
    return { min: band.min, max: band.max };
  }
  return FALLBACK_L1_RATIO[level] ?? FALLBACK_L1_RATIO.e2;
};

export interface ModeDecisionInput {
  level: EsolLevel;
  /** The learner's message THIS turn (an observable signal). */
  message: string;
  /** session.turn_scores so far (oldest → newest). */
  recentScores: number[];
  /** session.teaching_mode_sequence so far (lowercase modes). */
  recentModes: string[];
}

export interface ModeDecision {
  mode: Mode;
  /** The L1 band Gemini should aim for THIS turn (widened on distress). */
  l1Ratio: { min: number; max: number };
  /** Prose for Layer 5 — the L1:English guidance. */
  l1RatioGuidance: string;
  /** Prose for Layer 5 — how to operate this turn. */
  modeDirective: string;
  /** True when a confusion/distress marker fired (L1 fully unlocked). */
  distress: boolean;
  /** Short machine reason for logs / the audit trail. */
  reason: string;
}

const pct = (n: number): number => Math.round(n * 100);

/** Trailing run of scores at/above a bar (counts from the newest). */
const trailingStreak = (scores: number[], atLeast: number): number => {
  let n = 0;
  for (let i = scores.length - 1; i >= 0; i -= 1) {
    if (typeof scores[i] === "number" && scores[i] >= atLeast) n += 1;
    else break;
  }
  return n;
};

/**
 * Decide the mode + L1 ratio to operate in for the upcoming turn, from
 * observable signals of the conversation so far plus this turn's
 * message. Pure — no DB, no Gemini.
 */
export const decideMode = (input: ModeDecisionInput): ModeDecision => {
  const t = getModeThresholds();
  const band = l1RatioForLevel(input.level);
  const words = wordCount(input.message);
  const confusion = matchesConfusion(input.message);
  const scores = (input.recentScores ?? []).filter(
    (s): s is number => typeof s === "number" && Number.isFinite(s),
  );
  const lastScore = scores.length ? scores[scores.length - 1] : null;
  const anchoredThisSession = (input.recentModes ?? []).some(
    (m) => (m ?? "").toLowerCase() === "anchor",
  );
  const highStreak = trailingStreak(scores, t.immersionScoreAtLeast);

  let mode: Mode = "bridge";
  let reason = "default bridge";
  let distress = false;

  if (confusion) {
    mode = "anchor";
    distress = true;
    reason = "confusion/distress marker — L1 unlocked";
  } else if (words > 0 && words < t.anchorMinWords) {
    mode = "anchor";
    reason = `short response (${words} < ${t.anchorMinWords} words)`;
  } else if (lastScore !== null && lastScore < t.anchorScoreBelow) {
    mode = "anchor";
    reason = `previous turn_score ${lastScore} < ${t.anchorScoreBelow}`;
  } else if (highStreak >= t.immersionStreak && !anchoredThisSession) {
    mode = "immersion";
    reason = `${highStreak} consecutive turns ≥ ${t.immersionScoreAtLeast}, no anchor this session`;
  }

  // Distress override: L1 always available regardless of the level band.
  // Widen the upper bound to full L1 so Gemini may reassure / clarify in
  // the learner's language without breaking the ratio rule.
  const l1Ratio = distress ? { min: band.min, max: 1 } : band;

  const l1RatioGuidance = distress
    ? `The learner has signalled confusion or distress. L1 is always available here: use as much of their first language as you need to reassure and make the meaning clear — you may go above the usual ${pct(band.min)}–${pct(band.max)}% band this turn.`
    : `Aim for roughly ${pct(l1Ratio.min)}–${pct(l1Ratio.max)}% of this reply in the learner's first language (the rest in English), per their level.`;

  const modeDirective =
    mode === "anchor"
      ? "OPERATE IN ANCHOR MODE this turn: keep it short and slow, lead with the learner's first language, lower the demand, and recast errors gently rather than correcting them. Rebuild confidence before pushing."
      : mode === "immersion"
        ? "OPERATE IN IMMERSION MODE this turn: the learner is flowing — stay mostly in English, stretch them a little, and reserve the first language for a quick gloss only if something stalls."
        : "OPERATE IN BRIDGE MODE this turn: blend the first language and English at the level's ratio, recast meaning-affecting errors, and keep the conversation moving.";

  return {
    mode,
    l1Ratio,
    l1RatioGuidance,
    modeDirective,
    distress,
    reason,
  };
};

/**
 * Post-turn: take the more-supportive of the controller's directed mode
 * and the mode Gemini reported using. Support only ratchets DOWN when
 * both agree — if either says "anchor", the recorded mode is anchor.
 */
export const reconcileMode = (controller: Mode, ai: Mode): Mode =>
  SUPPORT_RANK[controller] <= SUPPORT_RANK[ai] ? controller : ai;
