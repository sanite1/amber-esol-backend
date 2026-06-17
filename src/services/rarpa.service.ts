import { randomUUID } from "crypto";
import { Types } from "mongoose";

import ApiError from "../errors/apiError";
import AuditLog from "../models/AuditLog";
import User from "../models/User";
import { IUser, IStage3Objective } from "../interfaces/user.interface";
import {
  EsolLevel,
  IlrSkillCode,
  ILR_CODE_TO_DOMAIN,
  ForSkillsDomain,
} from "./esolSkills";
import CurriculumLevelService from "./curriculumLevel.service";
import logger from "../config/logger";

/**
 * RARPA Stage 3 helpers (brief Function 6 To-Do 4).
 *
 * Stage 3 of the RARPA cycle (Recognising and Recording Progress and
 * Achievement) is where the learner's *targets* live. The placement
 * assessment writes one objective per weak skill domain plus a single
 * general communication objective; teachers can later append their own
 * via the Stage 3 override flow.
 *
 * Why anchor on the four ForSkills domains rather than the nine ILR
 * sub-codes:
 *   - The brief's templates only cover four anchor codes (Sc / Lr / Rt
 *     / Wt). A learner flagged with Rt + Rs + Rw — three reading codes
 *     — should produce ONE reading objective, not three.
 *   - The objective's `skill_domain` field then stores the ANCHOR ILR
 *     code (Sc / Lr / Rt / Wt). When Stage 4 evidence (Function 9) is
 *     later collected, items tagged with any sub-code under the
 *     anchor's domain match the objective via ILR_CODE_TO_DOMAIN.
 */

// ─────────────────────────────────────────────────────────────────────
// Templates — brief Function 6 To-Do 4
// ─────────────────────────────────────────────────────────────────────

/**
 * Description templates by ANCHOR ILR code. Every weakness flag is
 * resolved to its parent ForSkills domain, then the domain's anchor
 * code is what we look up here.
 *
 *   reading   → Rt
 *   writing   → Wt
 *   listening → Lr
 *   speaking  → Sc
 *
 * Keep these phrases tight and consistent — learners read them on
 * their dashboard; teachers see them in the Stage 3 view; org admins
 * see them on the Ofsted-facing learner profile. One source of truth.
 */
const DOMAIN_TEMPLATES: Record<"Rt" | "Wt" | "Lr" | "Sc", string> = {
  Sc: "Develop spoken English for everyday situations at {level}",
  Lr: "Develop listening comprehension for everyday situations at {level}",
  Rt: "Develop reading skills for everyday texts at {level}",
  Wt: "Develop writing skills for everyday tasks at {level}",
};

/** Always added, regardless of weakness flags. The brief mandates it
 *  because every learner needs at least one objective even if their
 *  placement showed no weak domains. */
const GENERAL_TEMPLATE =
  "Develop functional English communication skills at {level}";

const GENERAL_DOMAIN_SENTINEL = "general";

/** Map each of the four ForSkills domains to its anchor ILR code. */
const DOMAIN_TO_ANCHOR: Record<ForSkillsDomain, "Rt" | "Wt" | "Lr" | "Sc"> = {
  reading: "Rt",
  writing: "Wt",
  listening: "Lr",
  speaking: "Sc",
};

// ─────────────────────────────────────────────────────────────────────
// Level pretty-printer
// ─────────────────────────────────────────────────────────────────────

/** "e1" → "Entry Level 1", "l2" → "Level 2". One place to change if
 *  brand voice ever wants different phrasing. */
const prettyLevel = (level: EsolLevel): string => {
  switch (level) {
    case "e1":
      return "Entry Level 1";
    case "e2":
      return "Entry Level 2";
    case "e3":
      return "Entry Level 3";
    case "l1":
      return "Level 1";
    case "l2":
      return "Level 2";
  }
};

const render = (template: string, level: EsolLevel): string =>
  template.replace("{level}", prettyLevel(level));

/**
 * Pull a level-appropriate can-do objective from the seeded curriculum
 * bank (F30) for the given anchor, instead of the generic template.
 *
 *   Rt → rarpaObjectives.reading
 *   Wt → rarpaObjectives.writing
 *   Sc / Lr → rarpaObjectives.speakingListening (the curriculum groups
 *             speaking + listening; we offset the index so a learner
 *             weak in BOTH gets two distinct statements rather than the
 *             same one twice)
 *
 * Returns null when the level isn't seeded or the relevant bank is
 * empty — the caller then falls back to DOMAIN_TEMPLATES so a missing
 * curriculum never blocks placement.
 */
const curriculumObjective = (
  level: EsolLevel,
  anchor: "Rt" | "Wt" | "Lr" | "Sc",
): string | null => {
  const doc = CurriculumLevelService.getLevel(level);
  const bank = doc?.rarpaObjectives;
  if (!bank) return null;
  const arr =
    anchor === "Rt"
      ? bank.reading
      : anchor === "Wt"
        ? bank.writing
        : bank.speakingListening;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  // Sc → first statement; Lr → second if present, else first.
  const idx = anchor === "Lr" && arr.length > 1 ? 1 : 0;
  const text = arr[idx];
  return typeof text === "string" && text.trim().length > 0 ? text : null;
};

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

/**
 * Build (but don't persist) the Stage 3 objective list a placement
 * outcome implies. Pure; useful for tests and previews.
 *
 *   - Dedup `skill_weakness_flags` by parent domain — Rt/Rs/Rw → one
 *     reading objective.
 *   - One objective per unique domain in a stable order
 *     (reading → writing → listening → speaking) so the Stage 3
 *     dashboard reads consistently.
 *   - Plus exactly one general communication objective at the tail.
 *
 * Returns objects matching the `IStage3Objective` schema. The caller
 * decides whether to persist.
 */
export const buildStage3ObjectivesForPlacement = (
  esol_level: EsolLevel,
  skill_weakness_flags: IlrSkillCode[],
): IStage3Objective[] => {
  const now = new Date();

  // 1. Reduce flags to unique parent domains.
  const domainsSeen = new Set<ForSkillsDomain>();
  for (const flag of skill_weakness_flags) {
    const domain = ILR_CODE_TO_DOMAIN[flag];
    if (domain) domainsSeen.add(domain);
  }

  // 2. Emit per-domain objectives in a stable order.
  const objectives: IStage3Objective[] = [];
  const ORDER: ForSkillsDomain[] = [
    "reading",
    "writing",
    "listening",
    "speaking",
  ];
  for (const domain of ORDER) {
    if (!domainsSeen.has(domain)) continue;
    const anchor = DOMAIN_TO_ANCHOR[domain];
    objectives.push({
      id: randomUUID(),
      skill_domain: anchor,
      // Prefer the seeded curriculum can-do statement; fall back to the
      // generic template when the level isn't seeded (F30).
      description:
        curriculumObjective(esol_level, anchor) ??
        render(DOMAIN_TEMPLATES[anchor], esol_level),
      set_at: now,
      set_from: "placement_assessment",
      target_level: esol_level,
    });
  }

  // 3. Always-add general communication objective at the tail.
  objectives.push({
    id: randomUUID(),
    skill_domain: GENERAL_DOMAIN_SENTINEL,
    description: render(GENERAL_TEMPLATE, esol_level),
    set_at: now,
    set_from: "placement_assessment",
    target_level: esol_level,
  });

  return objectives;
};

/**
 * Persist the placement-derived Stage 3 objectives to the learner's
 * User document.
 *
 * Merge semantics:
 *   - Remove any existing objectives whose `set_from === "placement_assessment"`
 *     (re-placement overwrites prior placement output).
 *   - Preserve every other objective — teacher overrides, manual
 *     additions — untouched.
 *   - Append the freshly-built objectives at the tail.
 *
 * Returns the FULL post-merge objective list so callers can render it
 * verbatim (the placement scoring response surfaces this on the wizard
 * confirmation screen).
 */
export const createStage3ObjectivesFromPlacement = async (
  learner_id: string,
  esol_level: EsolLevel,
  skill_weakness_flags: IlrSkillCode[],
): Promise<IStage3Objective[]> => {
  const learner = await User.findById(learner_id);
  if (!learner) {
    throw new ApiError(404, `Learner ${learner_id} not found`);
  }
  if (learner.role !== "student") {
    throw new ApiError(
      403,
      `Cannot set Stage 3 objectives on a non-learner user (${learner_id})`,
    );
  }

  const fresh = buildStage3ObjectivesForPlacement(
    esol_level,
    skill_weakness_flags,
  );

  // Strip prior placement_assessment objectives; keep teacher overrides
  // and any other source.
  const existing: IStage3Objective[] = (learner.stage3_objectives ??
    []) as IUser["stage3_objectives"] extends infer T
    ? T extends Array<infer E>
      ? E[]
      : never
    : never;
  const preserved = existing.filter(
    (o) => o.set_from !== "placement_assessment",
  );

  learner.stage3_objectives = [...preserved, ...fresh];
  await learner.save();

  logger.info(
    {
      learnerId: learner_id,
      esol_level,
      addedCount: fresh.length,
      preservedCount: preserved.length,
      replacedCount: existing.length - preserved.length,
    },
    "Stage 3 objectives rewritten from placement",
  );

  // F30 — record the L1 negotiation of these objectives as immutable
  // RARPA Stage 3 evidence. Best-effort: a failure here must not fail
  // placement (the objectives are already saved + the placement_completed
  // audit row exists).
  await recordStage3Negotiation(learner, fresh).catch((err) =>
    logger.error(
      { err, learnerId: learner_id },
      "Stage 3 L1 negotiation evidence write failed (objectives still saved)",
    ),
  );

  return learner.stage3_objectives ?? [];
};

// ─────────────────────────────────────────────────────────────────────
// F30 — Stage 3 L1 negotiation evidence
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the short, warm script (in the learner's L1) that presents the
 * Stage 3 objectives for agreement. The learner-facing negotiation UI
 * (Phase 6) renders this; the text is also captured in the audit row so
 * a RARPA reviewer can see exactly what the learner was shown and in
 * which language. Falls back to English for any non-MVP language.
 */
export const buildStage3NegotiationScript = (
  objectives: IStage3Objective[],
  l1Language: string,
): string => {
  const goals = objectives.map((o) => `• ${o.description}`).join("\n");
  const lc = (l1Language ?? "english").toLowerCase();
  switch (lc) {
    case "arabic":
    case "ar":
      return `هذه هي أهدافك التعليمية. هل توافق عليها، أم تريد تغيير شيء؟\n${goals}`;
    case "cantonese":
    case "yue":
    case "zh":
      return `呢啲係你嘅學習目標。你同意嗎，定係想改啲嘢?\n${goals}`;
    case "turkish":
    case "tr":
      return `Bunlar senin öğrenme hedeflerin. Kabul ediyor musun, yoksa bir şeyi değiştirmek ister misin?\n${goals}`;
    default:
      return `These are your learning goals. Do you agree with them, or would you like to change anything?\n${goals}`;
  }
};

/**
 * Write the immutable Stage 3 negotiation evidence row. The AuditLog IS
 * the evidence — append-only, queryable by learner + action, surfaced in
 * the org admin's "what happened?" view and the learner's RARPA folder.
 */
export const recordStage3Negotiation = async (
  learner: IUser,
  objectives: IStage3Objective[],
): Promise<void> => {
  const l1Language = (learner.l1Language as string) ?? "english";
  const script = buildStage3NegotiationScript(objectives, l1Language);
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "system",
    actor_id: null,
    org_id: (learner.orgId as Types.ObjectId | null) ?? null,
    learner_id: learner._id,
    action: "rarpa_stage3_negotiated",
    before_state: null,
    after_state: {
      l1_language: l1Language,
      negotiation_script: script,
      objective_ids: objectives.map((o) => o.id),
      objective_descriptions: objectives.map((o) => o.description),
      objective_count: objectives.length,
    },
    reason:
      "Stage 3 objectives presented to the learner in their first language for negotiation and agreement (RARPA Stage 3 evidence)",
  });
};

/**
 * Append fresh Stage 3 objectives at the new level when a learner is
 * promoted via the Function 11 To-Do 2 admin-confirm flow.
 *
 * Differs from `createStage3ObjectivesFromPlacement`:
 *
 *   - The brief requires preserving HISTORY — every prior objective
 *     stays on the learner record, including older placement-derived
 *     ones. The reviewer of a learner's RARPA folder needs to see
 *     "at E2 the learner was targeting X, at E3 they're targeting Y".
 *   - `set_from` is "level_change" so a later audit can tell which
 *     objectives were seeded by progression vs by placement vs by a
 *     teacher's manual addition.
 *
 * Reuses the same template builder under the hood so the wording
 * stays consistent between placement and level-change seeding.
 */
export const createStage3ObjectivesOnLevelChange = async (
  learner_id: string,
  new_level: EsolLevel,
  skill_weakness_flags: IlrSkillCode[],
): Promise<IStage3Objective[]> => {
  const learner = await User.findById(learner_id);
  if (!learner) {
    throw new ApiError(404, `Learner ${learner_id} not found`);
  }
  if (learner.role !== "student") {
    throw new ApiError(
      403,
      `Cannot set Stage 3 objectives on a non-learner user (${learner_id})`,
    );
  }

  const fresh = buildStage3ObjectivesForPlacement(
    new_level,
    skill_weakness_flags,
  ).map((o) => ({ ...o, set_from: "level_change" }));

  const existing: IStage3Objective[] = (learner.stage3_objectives ??
    []) as IUser["stage3_objectives"] extends infer T
    ? T extends Array<infer E>
      ? E[]
      : never
    : never;

  // Append-only — no strip, no replace. The history is the audit.
  learner.stage3_objectives = [...existing, ...fresh];
  await learner.save();

  logger.info(
    {
      learnerId: learner_id,
      new_level,
      addedCount: fresh.length,
      preservedCount: existing.length,
    },
    "Stage 3 objectives appended for level change",
  );

  return learner.stage3_objectives ?? [];
};

// Re-export the public types/templates so unit tests can introspect.
export { DOMAIN_TEMPLATES, GENERAL_TEMPLATE };
