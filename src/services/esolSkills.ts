/**
 * ESOL Skills for Life — domain ↔ ILR sub-skill code mapping.
 *
 * The ILR / DfE Skills for Life framework breaks each language modality
 * into sub-skill codes. ForSkills (and most other diagnostic providers)
 * report at the domain level — one score for Reading, one for Writing,
 * etc. — so we need a fan-out from the four ForSkills domains to the
 * nine ILR codes.
 *
 * ILR codes:
 *   Reading:           Rt = Reading Text,      Rs = Reading Sentences,
 *                      Rw = Reading Words
 *   Writing:           Wt = Writing Text,      Ws = Writing Sentences,
 *                      Ww = Writing Words
 *   Listening:         Lr = Listening / Respond
 *   Speaking:          Sc = Speak to Communicate,
 *                      Sd = Discussion / Discourse
 *
 * Why a separate file (not inline in the service):
 *   - The same mapping is needed by Function 6 (placement assessment),
 *     Function 9 (RARPA stage 3 objective generation), and the ILR
 *     export (Function 12). Centralising stops them drifting.
 *   - The pass thresholds per level are a placeholder pending NCFE
 *     confirmation; when real numbers arrive only this file changes.
 *
 * NOT in scope for Phase A:
 *   - Reading the actual ForSkills sub-skill breakdown (Rt/Rs/Rw etc).
 *     ForSkills exports them as numeric sub-scores, but until we have
 *     a sample CSV we fan out the domain score onto all child codes.
 *     A future Phase B will let the importer consume per-code scores
 *     directly.
 */

import type { IUser } from "../interfaces/user.interface";

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type ForSkillsDomain = "reading" | "writing" | "listening" | "speaking";

export type IlrSkillCode =
  | "Rt"
  | "Rs"
  | "Rw"
  | "Wt"
  | "Ws"
  | "Ww"
  | "Lr"
  | "Sc"
  | "Sd";

export type EsolLevel = "e1" | "e2" | "e3" | "l1" | "l2";

export interface DomainScores {
  reading: number;
  writing: number;
  listening: number;
  speaking: number;
}

// ─────────────────────────────────────────────────────────────────────
// Domain → ILR code fan-out
// ─────────────────────────────────────────────────────────────────────

export const DOMAIN_TO_ILR_CODES: Record<ForSkillsDomain, IlrSkillCode[]> = {
  reading: ["Rt", "Rs", "Rw"],
  writing: ["Wt", "Ws", "Ww"],
  listening: ["Lr"],
  speaking: ["Sc", "Sd"],
};

export const ALL_ILR_CODES: IlrSkillCode[] = (
  Object.values(DOMAIN_TO_ILR_CODES) as IlrSkillCode[][]
).flat();

/** Reverse lookup — useful when reasoning about a single ILR code. */
export const ILR_CODE_TO_DOMAIN: Record<IlrSkillCode, ForSkillsDomain> =
  (() => {
    const out = {} as Record<IlrSkillCode, ForSkillsDomain>;
    for (const [dom, codes] of Object.entries(DOMAIN_TO_ILR_CODES) as [
      ForSkillsDomain,
      IlrSkillCode[],
    ][]) {
      for (const c of codes) out[c] = dom;
    }
    return out;
  })();

// ─────────────────────────────────────────────────────────────────────
// Pass thresholds — PLACEHOLDER pending NCFE / DfE confirmation
// ─────────────────────────────────────────────────────────────────────

/**
 * Score (0–100) below which a domain is considered weak at the given
 * level. Real thresholds depend on NCFE's published cut-offs per
 * Skills for Life level; these are educated placeholders.
 *
 * Threshold rationale (placeholder):
 *   - Lower levels (E1/E2) demand less — 40–50 is "competent at level"
 *   - Upper levels (L1/L2) demand more — 70–75 is "competent at level"
 *   - A score BELOW these is what marks the domain as a weakness
 *     warranting a placement intervention.
 */
export const LEVEL_PASS_THRESHOLD: Record<EsolLevel, number> = {
  e1: 40,
  e2: 50,
  e3: 60,
  l1: 70,
  l2: 75,
};

// ─────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────

const isValidEsolLevel = (v: unknown): v is EsolLevel =>
  typeof v === "string" &&
  ["e1", "e2", "e3", "l1", "l2"].includes(v.toLowerCase());

export const normaliseEsolLevel = (v: unknown): EsolLevel | null => {
  if (!isValidEsolLevel(v)) return null;
  return (v as string).toLowerCase() as EsolLevel;
};

/**
 * Map a single ILR skill code to its parent ForSkills domain.
 * Throws on unknown codes — they should never reach the runtime.
 */
export const ilrCodeToDomain = (code: IlrSkillCode): ForSkillsDomain => {
  const dom = ILR_CODE_TO_DOMAIN[code];
  if (!dom) {
    throw new Error(`Unknown ILR skill code: ${code}`);
  }
  return dom;
};

/**
 * Given a set of domain scores and a target level, return the ILR
 * sub-skill codes that are below the threshold for that level.
 *
 * Used by the ForSkills importer (Function 4) and will be reused by the
 * placement scoring service (Function 6).
 *
 * Returns an empty array when every domain meets or exceeds the
 * threshold — the learner has no weak skills at this level.
 */
export const flagWeakSkills = (
  scores: DomainScores,
  level: EsolLevel,
): IlrSkillCode[] => {
  const threshold = LEVEL_PASS_THRESHOLD[level];
  const flags: IlrSkillCode[] = [];
  if (scores.reading < threshold) flags.push(...DOMAIN_TO_ILR_CODES.reading);
  if (scores.writing < threshold) flags.push(...DOMAIN_TO_ILR_CODES.writing);
  if (scores.listening < threshold)
    flags.push(...DOMAIN_TO_ILR_CODES.listening);
  if (scores.speaking < threshold) flags.push(...DOMAIN_TO_ILR_CODES.speaking);
  return flags;
};

/**
 * Merge new weakness flags with whatever a learner already has,
 * de-duplicated, in a stable order (read the codes in `ALL_ILR_CODES`
 * order so downstream snapshot tests are deterministic).
 *
 * The merge is intentional — a ForSkills import shouldn't blow away
 * a previous diagnostic that flagged a different skill. If you want
 * to RESET, call `User.findOneAndUpdate({ skillWeaknessFlags: newFlags })`
 * directly.
 */
export const mergeWeaknessFlags = (
  existing: IUser["skillWeaknessFlags"] = [],
  incoming: IlrSkillCode[],
): IlrSkillCode[] => {
  const set = new Set<string>([...(existing ?? []), ...incoming]);
  return ALL_ILR_CODES.filter((c) => set.has(c));
};
