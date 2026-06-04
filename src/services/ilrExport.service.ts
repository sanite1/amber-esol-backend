/**
 * ILR field mapper — brief Function 13 To-Do 1.
 *
 * Builds the per-session ILR rows for one org × one academic year.
 * EVERY ILR code, valid-value list, transformation, and field rename
 * is read from ComplianceConfig (Phase 1.E). The brief is emphatic
 * that this service contains zero hardcoded ILR knowledge — when DfE
 * publish the 2026/27 spec, the config is the only thing that needs
 * editing.
 *
 * Pipeline:
 *
 *   1. Load the compliance config for (ilr, academic_year). Fail
 *      closed if missing — no rows produced, error logged. The
 *      orchestrator (Function 13 To-Do 2) reads the empty result
 *      and surfaces it to the org admin as "config missing".
 *
 *   2. Pull every learner in the org plus their AISession rows
 *      (both live `ai_tutor`/`teacher_consolidation` and imported
 *      `pre_platform`). One row per session per learner.
 *
 *   3. For each session, run buildRowForSession which composes:
 *        Learner fields (ULN, names, DOB, sex, ethnicity, LLDD,
 *        entry date, postcode, NI)
 *        Aim fields (LearnAimRef, AimType, AimSeqNumber,
 *        LearnStartDate, LearnPlanEndDate, LearnActEndDate,
 *        Outcome, CompStatus, FundModel, SOF, AddHours,
 *        EnglishProgType, LearnDelFAM)
 *
 *   4. Validate the LearnAimRef against FALACache.isValidAim. Rows
 *      whose aim isn't on the FALA whitelist are tagged
 *      `aim_invalid: true` so the orchestrator can hold them out of
 *      the upload — the brief calls this out as a hard failure
 *      mode for DfE submissions.
 *
 * What this service deliberately does NOT do:
 *   - Validate green-light rules (Function 14)
 *   - Serialise to the ILR CSV/XML format (Function 13 To-Do 2)
 *   - Push to MIS (Function 14)
 *   - Refuse rows on rule failure (the orchestrator decides)
 *
 * Its job is to produce the row objects with every field populated
 * from the right source, with config-driven naming, dates formatted
 * YYYY-MM-DD, and lookup-driven transformations applied.
 */

import { Types } from "mongoose";
import User from "../models/User";
import AISession from "../models/AISession";
import Organisation from "../models/Organisation";
import { createHash } from "crypto";
import ApiError from "../errors/apiError";
import ComplianceConfigService from "./ComplianceConfigService";
import FALACache from "./falaCache.service";
import IdempotencyService from "./idempotency.service";
import PostcodeRouter from "./postcodeRouter.service";
import IlrExportWarnings from "../models/IlrExportWarnings";
import { ILR_CODE_TO_DOMAIN, ForSkillsDomain } from "./esolSkills";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Public shape
// ─────────────────────────────────────────────────────────────────────

/**
 * ILR row shape — matches the 2025/26 schema field names. Field names
 * are subject to `field_name_overrides` in the config (e.g. legacy
 * `SOC2000` → `SOC`) which is applied AT SERIALISATION time, not on
 * this row. The mapper produces canonical names; the writer rewrites
 * them with the override map.
 */
export interface IlrRow {
  // ── Learner fields ─────────────────────────────────────────────
  ULN: string | null;
  FamilyName: string;
  GivenNames: string;
  DateOfBirth: string | null;        // YYYY-MM-DD
  Sex: number | null;                // 1 = M, 2 = F per ILR enum
  Ethnicity: string | null;
  LLDDHealthProb: number | null;     // remapped via llddt_remapping
  LearnerEntryDate: string | null;   // YYYY-MM-DD
  PostcodePrior: string | null;
  NINumber: string;                  // always blank for MVP per brief
  // ── Learning-aim fields ────────────────────────────────────────
  LearnAimRef: string | null;
  AimType: number;
  AimSeqNumber: number;
  LearnStartDate: string | null;     // YYYY-MM-DD
  LearnPlanEndDate: string | null;   // YYYY-MM-DD
  LearnActEndDate: string | null;    // YYYY-MM-DD — set only at terminal state
  Outcome: number | null;            // 1 achieved, 3 withdrawn
  CompStatus: number;                // 1 continuing, 2 completed
  FundModel: number;                 // from config.rules.fund_model
  SOF: string | null;                // validated against valid_sof_codes
  AddHours: number | null;           // null when suppressed
  EnglishProgType: string | null;    // per breaking-change rules — string because 2025/26 codes may be alphanumeric
  LearnDelFAM: Array<{ Type: string; Code: string }>;  // DAM list

  // ── Internal metadata (not serialised to ILR; carried for the
  //     orchestrator's green-light validation in Function 14) ──
  _session_id: string;
  _session_source: "ai_tutor" | "teacher_consolidation" | "pre_platform";
  _learner_id: string;
  _total_glh_hours: number;
  _skill_domains_covered: ForSkillsDomain[];
  _aim_invalid: boolean;
  _suppression_notes: string[];
  /**
   * Structured warnings from the 2025/26 breaking-change handlers
   * (brief Function 13 To-Do 2). The orchestrator's manual-review
   * pipeline (Function 14 To-Do 3) reads these to decide whether a
   * row goes to the auto-claim batch or to the org admin's manual
   * review queue.
   */
  _warnings: IlrRowWarning[];
  /**
   * Hard stop — when true, the orchestrator must hold this row
   * back from submission entirely (no value of `_warnings` resolves
   * it). Set today by the expired-LLDDT handler when there is no
   * remap target for the legacy code.
   */
  _skip_row: boolean;
}

/**
 * Structured warning shape. The `type` discriminator drives the
 * frontend's manual-review card rendering (each type has its own
 * remediation prompt) and the audit log row stays machine-parseable.
 */
export type IlrRowWarning =
  | { type: "sof_code_missing" }
  | { type: "sof_code_invalid"; code: string }
  | { type: "english_prog_type_defaulted"; defaulted_to: string }
  | { type: "llddt_remapped"; from: string; to: string }
  | { type: "llddt_blocked"; code: string };

// ─────────────────────────────────────────────────────────────────────
// Date + number formatters
// ─────────────────────────────────────────────────────────────────────

/**
 * Format a Date / ISO string / null as YYYY-MM-DD (UTC-anchored).
 *
 * ILR dates are calendar dates without timezone — using UTC avoids
 * the off-by-one when the server runs in a non-UTC TZ. A learner
 * who enrolled at "12:00 BST" is recorded as the calendar date in
 * BST, but the underlying Date is stored UTC — toISOString().split
 * picks UTC midnight, which differs from BST by ≤ 1 hour and never
 * crosses the date boundary in practice (we're never that close).
 */
export const formatIlrDate = (v: Date | string | null | undefined): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
};

/** Round minutes → hours, 1dp. AddHours uses this for ILR. */
export const minutesToHours = (mins: number | null | undefined): number => {
  if (typeof mins !== "number" || !Number.isFinite(mins)) return 0;
  return Math.round((mins / 60) * 10) / 10;
};

/**
 * Sex code mapping. Source field is User.sex (already 1|2|null per the
 * Mongoose enum). No transformation needed — the config doesn't
 * expose a sex remapping (the codes are stable across ILR years).
 */
export const formatSex = (v: number | null | undefined): number | null =>
  v === 1 || v === 2 ? v : null;

/**
 * LLDDHealthProb remapping. The config carries:
 *
 *   expired_llddt_codes: ["legacy_code_x", …]
 *   llddt_remapping:    { "legacy_code_x": "modern_code_y", … }
 *
 * Rule:
 *   - If the source value is on the expired list AND has a remap
 *     entry, return the remap target.
 *   - If on the expired list with NO remap entry, return null
 *     (treat as missing — better than submitting an invalid code).
 *   - Otherwise return as-is.
 */
export const remapLlddt = (
  raw: number | string | null | undefined,
  expired: ReadonlyArray<string | number>,
  remap: Record<string, number | string>,
): number | null => {
  if (raw === null || raw === undefined) return null;
  const asStr = String(raw);
  const expiredSet = new Set(expired.map((c) => String(c)));
  if (expiredSet.has(asStr)) {
    const target = remap[asStr];
    if (target === undefined || target === null) return null;
    const asNum = Number(target);
    return Number.isFinite(asNum) ? asNum : null;
  }
  const asNum = Number(raw);
  return Number.isFinite(asNum) ? asNum : null;
};

/**
 * SOF code lookup. Returns the original value if it's on the
 * `valid_sof_codes` whitelist; otherwise null (rendered as blank in
 * ILR — better than submitting an unknown code that the upload would
 * reject).
 */
export const validateSofCode = (
  raw: string | null | undefined,
  validCodes: ReadonlyArray<string>,
): string | null => {
  if (!raw) return null;
  const validSet = new Set(validCodes.map((c) => String(c)));
  return validSet.has(String(raw)) ? String(raw) : null;
};

// ─────────────────────────────────────────────────────────────────────
// 2025/26 breaking-change handlers — brief Function 13 To-Do 2
//
// Each handler returns the resolved value plus a structured warning
// (or null when clean). The row builder funnels these into the row's
// `_warnings` array. The orchestrator's manual-review queue keys off
// the warning `type` discriminator.
//
// All four are config-driven — the rules table lives in
// ComplianceConfig.rules and these functions are pure given the
// rules they're handed. That keeps them snapshot-stable for tests
// and means a 2026/27 spec change is a config edit, not a code edit.
// ─────────────────────────────────────────────────────────────────────

/**
 * §1 SOF-code validation — ESFA 2025/26 introduced the SOF 19-route
 * mapping. PostcodeRouter writes `User.sof_code` at registration;
 * here we re-check at export time because:
 *   - Postcode routing rules can change between registration and
 *     export (DfE-published changes)
 *   - A bulk-imported learner may carry a stale code
 *
 * Three outcomes:
 *   - sof present + on whitelist → { value: sof, warning: null }
 *   - sof present + NOT on whitelist → { value: null, warning:
 *     { type: "sof_code_invalid", code } } — the value is nulled
 *     so the row doesn't ship an invalid code, and the warning
 *     pushes the row to manual review (no funding without a valid SOF)
 *   - sof missing → { value: null, warning: { type: "sof_code_missing" } }
 */
export const handleSofCode = (
  rawSofCode: string | null | undefined,
  validSofCodes: ReadonlyArray<string>,
): { value: string | null; warning: IlrRowWarning | null } => {
  if (!rawSofCode || rawSofCode.toString().trim() === "") {
    return { value: null, warning: { type: "sof_code_missing" } };
  }
  const code = String(rawSofCode);
  const validSet = new Set(validSofCodes.map((c) => String(c)));
  if (validSet.has(code)) {
    return { value: code, warning: null };
  }
  return {
    value: null,
    warning: { type: "sof_code_invalid", code },
  };
};

/**
 * §2 EnglishProgType — ESFA 2025/26 made this an explicit per-learner
 * field rather than something derivable from aim_type.
 *
 * Source priority:
 *   1. User.english_prog_type (set explicitly at import/registration)
 *   2. config.rules.english_prog_type_default (per-academic-year fallback)
 *   3. The brief's spec value "25" — hard-coded as the last-resort
 *      default so a misconfigured config doesn't silently emit null.
 *      A warning fires whenever we land on the default so the org
 *      admin sees that we filled in a value they didn't set.
 */
export const handleEnglishProgType = (
  rawValue: string | null | undefined,
  defaultFromConfig: string | undefined,
): { value: string; warning: IlrRowWarning | null } => {
  if (rawValue && rawValue.toString().trim().length > 0) {
    return { value: String(rawValue), warning: null };
  }
  const fallback = defaultFromConfig ?? "25";
  return {
    value: fallback,
    warning: { type: "english_prog_type_defaulted", defaulted_to: fallback },
  };
};

/**
 * §3 SOC2000 → SOC field rename. The 2025/26 spec renamed several
 * legacy field labels; `field_name_overrides` is the rule:
 *
 *   field_name_overrides: { "SOC2000": "SOC", ... }
 *
 * Apply at serialisation time, NOT on the row object — the canonical
 * names in `IlrRow` stay stable across years; only the emitted CSV/
 * XML labels change. Two reasons:
 *   - In-flight log lines and audit rows show canonical names so
 *     they're greppable regardless of the year.
 *   - Tests pin against canonical names without depending on which
 *     compliance year is loaded.
 *
 * `applyFieldNameOverrides(name, overrides)` is a pure function the
 * writer calls per emitted column header.
 */
export const applyFieldNameOverrides = (
  canonicalName: string,
  overrides: Record<string, string> | undefined,
): string => {
  if (!overrides) return canonicalName;
  return overrides[canonicalName] ?? canonicalName;
};

/**
 * §4 Expired LLDDT codes. The 2025/26 spec retired code "15" (and
 * others). The handler:
 *
 *   - Code in `expired_llddt_codes` AND has remap → return remap target
 *     + warning { llddt_remapped, from, to }
 *   - Code in `expired_llddt_codes` AND no remap → null value +
 *     warning { llddt_blocked } + skipRow: true (no safe fallback)
 *   - Code not expired → pass through, no warning
 *
 * `skipRow` is the hard-stop signal. The row builder propagates it
 * to `_skip_row` and the orchestrator drops the row from the
 * submission batch entirely.
 */
export const handleExpiredLlddt = (
  rawValue: number | string | null | undefined,
  expiredCodes: ReadonlyArray<string | number>,
  remap: Record<string, number | string>,
): {
  value: number | null;
  warning: IlrRowWarning | null;
  skipRow: boolean;
} => {
  if (rawValue === null || rawValue === undefined) {
    return { value: null, warning: null, skipRow: false };
  }
  const asStr = String(rawValue);
  const expiredSet = new Set(expiredCodes.map((c) => String(c)));

  if (!expiredSet.has(asStr)) {
    const asNum = Number(rawValue);
    return {
      value: Number.isFinite(asNum) ? asNum : null,
      warning: null,
      skipRow: false,
    };
  }

  // Expired — look for a remap target
  const target = remap[asStr];
  if (target === null || target === undefined) {
    return {
      value: null,
      warning: { type: "llddt_blocked", code: asStr },
      skipRow: true,
    };
  }
  const asNum = Number(target);
  if (!Number.isFinite(asNum)) {
    return {
      value: null,
      warning: { type: "llddt_blocked", code: asStr },
      skipRow: true,
    };
  }
  return {
    value: asNum,
    warning: { type: "llddt_remapped", from: asStr, to: String(asNum) },
    skipRow: false,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Config-driven lookups
// ─────────────────────────────────────────────────────────────────────

/**
 * Map a learner's `esolLevel` (e1/e2/e3/l1/l2) to the LearnAimRef
 * configured for that level in this academic year. The config holds:
 *
 *   esol_level_to_aim_ref: { "e1": "60139560", "e2": "60139572", … }
 *
 * Why a mapping rather than a per-learner field: the FALA codes
 * representing "ESOL Entry 1" change between awarding bodies. Joey
 * picks one for the org's preferred awarding body at config time;
 * every E1 learner inherits the same code. Per-learner override
 * happens at session creation (a future enhancement); for MVP the
 * level-derived ref is the source of truth.
 */
const resolveLearnAimRefForLevel = (
  esolLevel: string | null | undefined,
  mapping: Record<string, string> | undefined,
): string | null => {
  if (!esolLevel || !mapping) return null;
  return mapping[esolLevel.toLowerCase()] ?? null;
};

/**
 * EnglishProgType — config-driven because the brief Function 14 §2
 * (breaking change rules) expects this value to flip per academic
 * year. Source rule:
 *
 *   english_prog_type: { "regulated": 25, "non_regulated": null }
 *
 * Learner aim type drives the choice; a learner whose `esol_aim_type`
 * is unset gets null (the row will be held by the orchestrator's
 * green-light step).
 */
const resolveEnglishProgType = (
  esolAimType: string | null | undefined,
  rules: Record<string, number | null> | undefined,
): number | null => {
  if (!esolAimType || !rules) return null;
  const v = rules[esolAimType];
  return v ?? null;
};

/**
 * AddHours suppression rule. The config carries:
 *
 *   add_hours_suppression_rule: { "regulated": "claim",
 *                                  "non_regulated": "suppress",
 *                                  "missing": "suppress" }
 *
 * When the rule says "suppress", AddHours is null on the row AND a
 * suppression note is added so the orchestrator can show "AddHours
 * suppressed — non-regulated aim".
 */
const decideAddHours = (
  esolAimType: string | null | undefined,
  glhHours: number,
  suppressionRule: Record<string, "claim" | "suppress"> | undefined,
): { addHours: number | null; note: string | null } => {
  const key = esolAimType ?? "missing";
  const rule = suppressionRule?.[key] ?? "suppress";
  if (rule === "suppress") {
    return {
      addHours: null,
      note: `AddHours suppressed: esol_aim_type=${esolAimType ?? "<missing>"}`,
    };
  }
  return { addHours: glhHours, note: null };
};

// ─────────────────────────────────────────────────────────────────────
// Per-session row builder
// ─────────────────────────────────────────────────────────────────────

interface BuildRowArgs {
  learner: any;
  session: any;
  config: any;
  academicYear: string;
  aimSeqNumber: number;
  teacherContactHours: number;
}

/**
 * Compose one IlrRow from one (learner, session) pair.
 *
 * Field-level config sources (every line documented):
 *
 *   AimType         = config.rules.aim_type_default
 *   FundModel       = config.rules.fund_model
 *   SOF             = validateSofCode(User.sof_code, config.rules.valid_sof_codes)
 *   LLDDHealthProb  = remapLlddt(User.lldd_health_prob,
 *                                config.rules.expired_llddt_codes,
 *                                config.rules.llddt_remapping)
 *   AddHours        = decideAddHours(User.esol_aim_type, glh,
 *                                    config.rules.add_hours_suppression_rule)
 *   EnglishProgType = resolveEnglishProgType(User.esol_aim_type,
 *                                            config.rules.english_prog_type)
 *   LearnAimRef     = resolveLearnAimRefForLevel(User.esolLevel,
 *                                                config.rules.esol_level_to_aim_ref)
 *
 * Terminal state for the aim:
 *   - LearnActEndDate set when the learner is at L2 (completed the
 *     ladder) OR session.session_source is the legacy withdrawal
 *     marker. CompStatus 2 (completed), Outcome 1 (achieved) for
 *     L2; CompStatus 1 (continuing), Outcome null below L2.
 *   - Withdrawal (CompStatus 3, Outcome 3) is set when the learner's
 *     User.isActive is false. We don't carry a separate withdrawal
 *     date on the User; for MVP we use session.completedAt as the
 *     proxy and document the choice.
 */
const buildRowForSession = (args: BuildRowArgs): IlrRow => {
  const { learner, session, config, aimSeqNumber, teacherContactHours } = args;
  const rules = config.rules ?? {};

  // ── Per-row warnings + skip signal (Function 13 To-Do 2) ───────
  const rowWarnings: IlrRowWarning[] = [];
  let skipRow = false;

  // ── Learner fields ─────────────────────────────────────────────
  const dob = formatIlrDate(learner.dateOfBirth);
  const entryDate =
    formatIlrDate(learner.esolOnboardedAt) ??
    formatIlrDate(learner.createdAt) ??
    null;

  // §4 Breaking change — LLDDT-15 expired (and any other codes the
  // 2025/26 spec retired). Either remaps, or skipRow when no remap
  // target exists.
  const llddtResult = handleExpiredLlddt(
    learner.lldd_health_prob,
    (rules.expired_llddt_codes ?? []) as Array<string | number>,
    (rules.llddt_remapping ?? {}) as Record<string, number | string>,
  );
  const llddt = llddtResult.value;
  if (llddtResult.warning) rowWarnings.push(llddtResult.warning);
  if (llddtResult.skipRow) skipRow = true;

  // ── Aim-level fields ───────────────────────────────────────────
  const learnAimRef = resolveLearnAimRefForLevel(
    learner.esolLevel,
    rules.esol_level_to_aim_ref as Record<string, string> | undefined,
  );

  // §1 Breaking change — SOF 19-route validation. Already written
  // at registration by PostcodeRouter; re-checked at export time
  // because routing rules can shift between registration and export.
  const sofResult = handleSofCode(
    learner.sof_code,
    (rules.valid_sof_codes ?? []) as Array<string>,
  );
  const sof = sofResult.value;
  if (sofResult.warning) rowWarnings.push(sofResult.warning);

  // GLH for AddHours — the session's duration + the learner's
  // accumulated teacher-contact hours. Imported sessions count too
  // because they're prior platform learning that the org wants to
  // claim against this academic year's record.
  const sessionHours = minutesToHours(session.duration_mins);
  const glhForRow = Math.round((sessionHours + teacherContactHours) * 10) / 10;

  const { addHours, note: addHoursNote } = decideAddHours(
    learner.esol_aim_type,
    glhForRow,
    rules.add_hours_suppression_rule as
      | Record<string, "claim" | "suppress">
      | undefined,
  );

  // §2 Breaking change — EnglishProgType is now per-learner explicit.
  // Source priority: User.english_prog_type → config default → "25".
  const englishProgTypeResult = handleEnglishProgType(
    learner.english_prog_type,
    rules.english_prog_type_default as string | undefined,
  );
  const englishProgType = englishProgTypeResult.value;
  if (englishProgTypeResult.warning) rowWarnings.push(englishProgTypeResult.warning);

  // ── Lifecycle fields ───────────────────────────────────────────
  const startDate =
    formatIlrDate(session.start_time) ??
    formatIlrDate(session.createdAt) ??
    null;
  const planEndDate = formatIlrDate(learner.esol_planned_end_date) ?? null;

  // Terminal state — three cases:
  //   1. Learner deactivated → withdrawn (CompStatus 3, Outcome 3)
  //   2. Learner at L2 with session.passed → achieved
  //      (CompStatus 2, Outcome 1, LearnActEndDate set)
  //   3. Otherwise continuing (CompStatus 1, Outcome null,
  //      LearnActEndDate null)
  let compStatus = 1;
  let outcome: number | null = null;
  let actEndDate: string | null = null;
  const suppressionNotes: string[] = [];

  if (learner.isActive === false) {
    compStatus = 3;
    outcome = 3;
    actEndDate = formatIlrDate(session.completedAt) ?? null;
    suppressionNotes.push("Withdrawal inferred from learner.isActive=false");
  } else if (
    (learner.esolLevel ?? "").toLowerCase() === "l2" &&
    session.passed === true
  ) {
    compStatus = 2;
    outcome = 1;
    actEndDate = formatIlrDate(session.completedAt) ?? null;
  }

  if (addHoursNote) suppressionNotes.push(addHoursNote);

  // ── Skill-domain rollup ───────────────────────────────────────
  // Translate the session's ILR sub-skill codes into ForSkills
  // domains. The orchestrator uses this for the row-level skill
  // coverage check (Function 14 green light).
  const skillDomains = new Set<ForSkillsDomain>();
  for (const code of (session.skill_codes_covered ?? []) as string[]) {
    const domain = ILR_CODE_TO_DOMAIN[code as keyof typeof ILR_CODE_TO_DOMAIN];
    if (domain) skillDomains.add(domain);
  }

  // ── DAM codes ─────────────────────────────────────────────────
  // The brief lists LearnDelFAM as a list of { Type, Code } pairs.
  // For MVP we emit one entry: { Type: "SOF", Code: sof } when SOF
  // is known. Further DAM entries (DAM, ACT, RES, etc.) land per
  // the future per-learner DAM-recording flow.
  const learnDelFAM: Array<{ Type: string; Code: string }> = [];
  if (sof) learnDelFAM.push({ Type: "SOF", Code: sof });

  return {
    // Learner
    ULN: learner.uln ?? null,
    FamilyName: (learner.lastname ?? "").trim(),
    GivenNames: (learner.firstname ?? "").trim(),
    DateOfBirth: dob,
    Sex: formatSex(learner.sex),
    Ethnicity: learner.ethnicity ?? null,
    LLDDHealthProb: llddt,
    LearnerEntryDate: entryDate,
    PostcodePrior: learner.postcode_prior ?? null,
    NINumber: "", // Brief: always blank for MVP

    // Aim
    LearnAimRef: learnAimRef,
    AimType: (rules.aim_type_default as number | undefined) ?? 4,
    AimSeqNumber: aimSeqNumber,
    LearnStartDate: startDate,
    LearnPlanEndDate: planEndDate,
    LearnActEndDate: actEndDate,
    Outcome: outcome,
    CompStatus: compStatus,
    FundModel: (rules.fund_model as number | undefined) ?? 38,
    SOF: sof,
    AddHours: addHours,
    EnglishProgType: englishProgType,
    LearnDelFAM: learnDelFAM,

    // Internal metadata for the orchestrator
    _session_id: (session._id as Types.ObjectId).toString(),
    _session_source: session.session_source as IlrRow["_session_source"],
    _learner_id: (learner._id as Types.ObjectId).toString(),
    _total_glh_hours: glhForRow,
    _skill_domains_covered: Array.from(skillDomains),
    _aim_invalid: false, // populated after FALA validation below
    _suppression_notes: suppressionNotes,
    _warnings: rowWarnings,
    _skip_row: skipRow,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Public service entry — buildIlrRows
// ─────────────────────────────────────────────────────────────────────

export interface BuildIlrRowsResult {
  rows: IlrRow[];
  config_version: number | null;
  config_missing: boolean;
  /** Rows whose LearnAimRef failed FALA validation — separated out
   *  so the orchestrator can hold them rather than submitting bad refs. */
  aim_invalid_rows: IlrRow[];
}

/**
 * Build every ILR row for an org × academic year.
 *
 * Returns a result envelope rather than a bare array so the
 * orchestrator can distinguish "no rows" (no sessions) from
 * "config missing" (no rules loaded) — those need different
 * downstream handling.
 */
export const buildIlrRows = async (
  orgId: string,
  academicYear: string,
): Promise<BuildIlrRowsResult> => {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new Error(`buildIlrRows: invalid orgId ${orgId}`);
  }
  if (!academicYear || !/^\d{4}\/\d{2}$/.test(academicYear)) {
    throw new Error(
      `buildIlrRows: academic_year must be YYYY/YY (e.g. "2025/26"); got ${academicYear}`,
    );
  }

  // ── 0. Demo-org guard — brief Function 13 ─────────────────────────
  //
  // Defense-in-depth: the trigger route (triggerIlrExportService) also
  // refuses demo orgs with 403, but the brief is emphatic that
  // fictional orgs must never produce real ILR data. Putting the guard
  // here too means EVERY call path into buildIlrRows is gated —
  // including internal callers like Function 14's green-light
  // re-validation, a future CLI export script, or a misconfigured
  // route that forgot the trigger-service hop.
  //
  // The guard runs BEFORE any compliance-config / user / session
  // reads so a demo org never costs Mongo round-trips on this path.
  const org = await Organisation.findById(orgId).select("is_demo name").lean();
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }
  if (org.is_demo === true) {
    logger.warn(
      { orgId, orgName: org.name },
      "buildIlrRows: refused demo org — ILR generation skipped",
    );
    throw new ApiError(
      403,
      "ILR export is disabled for demo organisations. Demo data must never be submitted to ESFA.",
    );
  }

  // ── 1. Compliance config (fail closed if missing) ────────────────
  const config = ComplianceConfigService.getConfig("ilr", academicYear);
  if (!config) {
    logger.error(
      { orgId, academicYear },
      "buildIlrRows: no active ILR compliance config — refusing to produce rows",
    );
    return { rows: [], config_version: null, config_missing: true, aim_invalid_rows: [] };
  }

  // ── 2. Pull learners + their sessions ─────────────────────────────
  // Learners in this org with role "student" — including isActive=false
  // because withdrawn learners still appear on the ILR until their
  // LearnActEndDate falls outside the reporting window. The session
  // join below brings in their pre-platform + live sessions.
  const learners = await User.find({
    orgId: new Types.ObjectId(orgId),
    role: "student",
  })
    .select(
      "_id firstname lastname dateOfBirth sex ethnicity lldd_health_prob " +
        "esolOnboardedAt postcode_prior uln sof_code esol_aim_type esolLevel " +
        "glh_teacher_contact isActive createdAt esol_planned_end_date " +
        "english_prog_type",
    )
    .lean();
  if (learners.length === 0) {
    return { rows: [], config_version: config.version, config_missing: false, aim_invalid_rows: [] };
  }

  const learnerIds = learners.map((l) => l._id as Types.ObjectId);
  const sessions = await AISession.find({
    learnerId: { $in: learnerIds },
    orgId: new Types.ObjectId(orgId),
  })
    .select(
      "_id learnerId orgId session_source duration_mins skill_codes_covered " +
        "start_time end_time completedAt createdAt passed final_score scenario_id",
    )
    .sort({ learnerId: 1, createdAt: 1 })
    .lean();

  const sessionsByLearner = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const key = (s.learnerId as Types.ObjectId).toString();
    if (!sessionsByLearner.has(key)) sessionsByLearner.set(key, []);
    sessionsByLearner.get(key)!.push(s);
  }

  // ── 3. Compose rows ──────────────────────────────────────────────
  const rows: IlrRow[] = [];
  for (const learner of learners) {
    const learnerSessions = sessionsByLearner.get((learner._id as Types.ObjectId).toString()) ?? [];
    // AimSeqNumber resets per learner — the brief requires it to be
    // monotonically increasing across each learner's aim records.
    let seq = 1;
    const teacherContactHours = learner.glh_teacher_contact ?? 0;
    for (const session of learnerSessions) {
      const row = buildRowForSession({
        learner,
        session,
        config,
        academicYear,
        aimSeqNumber: seq,
        teacherContactHours,
      });
      rows.push(row);
      seq += 1;
    }
  }

  // ── 4. FALA validation ───────────────────────────────────────────
  // One FALA round-trip per distinct aim_ref (not per row) — many
  // learners share the same ref so a Set dedup keeps the Redis hits
  // bounded by level count, not by learner count.
  const uniqueRefs = new Set<string>(
    rows.map((r) => r.LearnAimRef ?? "").filter((r) => r.length > 0),
  );
  const refValidity = new Map<string, boolean>();
  for (const ref of uniqueRefs) {
    refValidity.set(ref, await FALACache.isValidAim(ref, academicYear));
  }
  for (const row of rows) {
    const ref = row.LearnAimRef;
    if (!ref) {
      row._aim_invalid = true;
      row._suppression_notes.push(
        `LearnAimRef missing — no esol_level_to_aim_ref mapping for esolLevel=${
          // Defensive — _learner_id lookup would require a second pass; the
          // suppression note is enough for the orchestrator to surface.
          "(see learner record)"
        }`,
      );
      continue;
    }
    if (refValidity.get(ref) === false) {
      row._aim_invalid = true;
      row._suppression_notes.push(
        `LearnAimRef ${ref} not on FALA whitelist for ${academicYear}`,
      );
    }
  }

  const aimInvalidRows = rows.filter((r) => r._aim_invalid);

  logger.info(
    {
      orgId,
      academicYear,
      config_version: config.version,
      learners: learners.length,
      sessions: sessions.length,
      rows: rows.length,
      aim_invalid_count: aimInvalidRows.length,
    },
    "buildIlrRows: complete",
  );

  return {
    rows,
    config_version: config.version,
    config_missing: false,
    aim_invalid_rows: aimInvalidRows,
  };
};

// ═════════════════════════════════════════════════════════════════════
// Validation — brief Function 13 To-Do 3
// ═════════════════════════════════════════════════════════════════════
//
// Six rules, three severities:
//
//   ERROR    Blocks the row from export. Org admin must fix data
//            before resubmitting.
//   WARNING  Row still exports but the issue is surfaced to the org
//            admin via the IlrExportWarnings cache.
//   INFO     Auto-correction applied; recorded for the audit trail.
//
// Rules:
//   E1  ULN missing or invalid (not 10 digits)       → ERROR
//   E2  sof_code not on whitelist                     → ERROR
//   E3  lldd_health_prob null or not in {1, 2, 9}    → ERROR
//   W1  non_regulated aim but AddHours > 0           → WARNING + autofix
//   W2  Postcode not in DfE dataset                   → WARNING
//   W3  Zero sessions + enrolled > 30 days            → WARNING
//
// The validator also inherits the `_skip_row` flag from the
// breaking-change handlers (Function 13 To-Do 2). Skip-row rows are
// shunted into `blocked_rows` regardless of their other validity.
//
// ─────────────────────────────────────────────────────────────────────

/** Severity tag for the manual-review queue. */
export type ValidationSeverity = "error" | "warning";

/** One issue against one row. */
export interface ValidationIssue {
  rule:
    | "uln_invalid"
    | "sof_code_invalid"
    | "lldd_invalid"
    | "add_hours_on_non_regulated"
    | "postcode_not_in_dfe_dataset"
    | "no_sessions_stale_learner"
    | "breaking_change_skip_row";
  severity: ValidationSeverity;
  message: string;
  field?: string;
  value?: unknown;
}

/** Blocked-row envelope returned alongside the still-valid rows. */
export interface BlockedRow {
  row: IlrRow;
  errors: ValidationIssue[];
}

/** Warning carried to the IlrExportWarnings cache. */
export interface ValidationWarning {
  session_id: string;
  learner_id: string;
  issue: ValidationIssue;
}

export interface ValidateRowsResult {
  valid_rows: IlrRow[];
  blocked_rows: BlockedRow[];
  warnings: ValidationWarning[];
}

/** Shape we expect when the caller wants to surface zero-session learners (W3). */
export interface LearnerStubForValidation {
  learner_id: string;
  enrolled_at: Date | null;
  /** Whether the learner has ANY session at all (live or imported). */
  has_any_session: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// ULN validation (E1) — pure
// ─────────────────────────────────────────────────────────────────────

/**
 * UK ULN is a 10-digit numeric string. Pure-digit check; the official
 * ESFA modulo-11 check digit lands in a follow-up (the brief lists it
 * as a stretch goal). For MVP, "10 numeric digits" rejects every form
 * of obvious garbage.
 */
export const validateUln = (raw: string | null | undefined): boolean => {
  if (!raw) return false;
  return /^\d{10}$/.test(String(raw).trim());
};

// ─────────────────────────────────────────────────────────────────────
// LLDD validation (E3) — pure
// ─────────────────────────────────────────────────────────────────────

/**
 * Final post-breaking-change check. The brief restricts the
 * acceptable values to {1, 2, 9}; anything else (including null) is
 * an ERROR. Note this can fire AFTER the §4 breaking-change handler
 * has nulled a code with no remap target — in that case the row
 * already carries `_skip_row: true`, and the validator surfaces the
 * skip as `breaking_change_skip_row` rather than `lldd_invalid` (the
 * org admin's remediation is different — wait for a config update
 * rather than re-record the data).
 */
const VALID_LLDD_CODES: ReadonlySet<number> = new Set([1, 2, 9]);

export const validateLlddCode = (
  raw: number | null | undefined,
): boolean => {
  if (raw === null || raw === undefined) return false;
  return VALID_LLDD_CODES.has(raw);
};

// ─────────────────────────────────────────────────────────────────────
// validateRows — the public entry
// ─────────────────────────────────────────────────────────────────────

/**
 * Run all six validation rules + the breaking-change skip-row check
 * against the row set. Pure-ish: hits Redis once for the postcode
 * lookups (deduped) but performs no Mongo writes.
 *
 * Rule 6 (W3 — zero-session stale learners) requires the caller to
 * supply `learner_stubs` because the row builder produces one row
 * per session; a zero-session learner produces zero rows and the
 * validator wouldn't otherwise see them. The orchestrator
 * (runIlrExport below) supplies the stubs.
 */
export const validateRows = async (
  rows: IlrRow[],
  academicYear: string,
  options: { learner_stubs?: LearnerStubForValidation[] } = {},
): Promise<ValidateRowsResult> => {
  const config = ComplianceConfigService.getConfig("ilr", academicYear);
  // Service rule: the validator runs over rows the mapper already
  // produced under THIS config. If config is missing now, the
  // upstream mapper would have produced zero rows; we still validate
  // the empty set without crashing.
  const validSofCodes = (config?.rules
    ? (config.rules as Record<string, unknown>).valid_sof_codes
    : []) as ReadonlyArray<string>;

  // ── Postcode deduplication — one lookup per distinct postcode ──
  // The row carries `PostcodePrior` (canonical name). Postcode router
  // hits Redis; a Set + Map keeps the calls bounded by distinct
  // postcodes in the export, not by row count.
  const distinctPostcodes = new Set<string>(
    rows.map((r) => r.PostcodePrior ?? "").filter((p) => p.length > 0),
  );
  const postcodeValidity = new Map<string, boolean>();
  for (const pc of distinctPostcodes) {
    try {
      const entry = await PostcodeRouter.lookup(pc);
      postcodeValidity.set(pc, entry !== null);
    } catch (err) {
      logger.warn(
        { postcode: pc, err: (err as Error).message },
        "validateRows: PostcodeRouter.lookup failed — treating as not-in-dataset",
      );
      postcodeValidity.set(pc, false);
    }
  }

  const valid_rows: IlrRow[] = [];
  const blocked_rows: BlockedRow[] = [];
  const warnings: ValidationWarning[] = [];

  for (const row of rows) {
    const errors: ValidationIssue[] = [];
    const rowWarnings: ValidationIssue[] = [];

    // Breaking-change skip-row (LLDDT-15-with-no-remap path):
    // surfaced as its own rule so the manual-review UI can render
    // the specialised remediation card.
    if (row._skip_row) {
      errors.push({
        rule: "breaking_change_skip_row",
        severity: "error",
        message:
          "Row blocked by 2025/26 breaking-change handler — see row._warnings for the specific code",
      });
    }

    // ── E1: ULN ─────────────────────────────────────────────────
    if (!validateUln(row.ULN)) {
      errors.push({
        rule: "uln_invalid",
        severity: "error",
        message: row.ULN
          ? `ULN "${row.ULN}" is not 10 numeric digits`
          : "ULN is missing",
        field: "ULN",
        value: row.ULN,
      });
    }

    // ── E2: SOF code ────────────────────────────────────────────
    // The breaking-change handler already nulled an invalid code +
    // pushed `sof_code_invalid` / `sof_code_missing` to row._warnings.
    // Here we mirror that as a validator ERROR so the orchestrator
    // can route it to manual review.
    if (!row.SOF) {
      const fromBreakingChange = row._warnings.some(
        (w) =>
          w.type === "sof_code_invalid" || w.type === "sof_code_missing",
      );
      const detail = fromBreakingChange
        ? row._warnings.find(
            (w) =>
              w.type === "sof_code_invalid" || w.type === "sof_code_missing",
          )
        : null;
      errors.push({
        rule: "sof_code_invalid",
        severity: "error",
        message:
          detail?.type === "sof_code_invalid"
            ? `SOF code "${(detail as { code: string }).code}" not on the ${academicYear} whitelist (${validSofCodes.length} valid codes)`
            : "SOF code is missing — postcode routing may not have run",
        field: "SOF",
      });
    }

    // ── E3: LLDD code in {1, 2, 9} ─────────────────────────────
    // Skip when the row is already blocked via breaking-change —
    // duplicating the error would clutter the manual-review UI.
    if (!row._skip_row && !validateLlddCode(row.LLDDHealthProb)) {
      errors.push({
        rule: "lldd_invalid",
        severity: "error",
        message:
          row.LLDDHealthProb === null
            ? "LLDDHealthProb is missing — must be 1, 2, or 9"
            : `LLDDHealthProb "${row.LLDDHealthProb}" not in valid set {1, 2, 9}`,
        field: "LLDDHealthProb",
        value: row.LLDDHealthProb,
      });
    }

    // ── W1: AddHours on non_regulated aim ──────────────────────
    // The breaking-change layer already suppresses AddHours when the
    // aim_type is non_regulated. This rule is belt-and-braces against
    // a misconfigured `add_hours_suppression_rule`: if a
    // non_regulated row reaches the validator with AddHours > 0,
    // we null it AND emit a warning so the misconfiguration surfaces.
    if (
      row.AddHours !== null &&
      row.AddHours > 0 &&
      // The row's aim type isn't on the IlrRow shape directly; infer
      // from the EnglishProgType + suppression note instead. The
      // mapper's decideAddHours already nulls regulated/non_regulated
      // correctly when the config rule is present, so this only fires
      // on misconfig.
      row._suppression_notes.some(
        (n) => n.includes("non_regulated") || n.includes("missing"),
      )
    ) {
      rowWarnings.push({
        rule: "add_hours_on_non_regulated",
        severity: "warning",
        message: `Auto-corrected AddHours from ${row.AddHours} to 0 — aim_type is not 'regulated'`,
        field: "AddHours",
        value: row.AddHours,
      });
      row.AddHours = 0;
    }

    // ── W2: postcode not in DfE dataset ─────────────────────────
    if (row.PostcodePrior && postcodeValidity.get(row.PostcodePrior) === false) {
      rowWarnings.push({
        rule: "postcode_not_in_dfe_dataset",
        severity: "warning",
        message: `Postcode "${row.PostcodePrior}" not found in the DfE ${academicYear} dataset — SOF may also be missing`,
        field: "PostcodePrior",
        value: row.PostcodePrior,
      });
    }

    // Build the per-row warnings payload regardless of error state
    // — the cache is a record of EVERYTHING the validator noticed,
    // not only fixable issues.
    for (const issue of rowWarnings) {
      warnings.push({
        session_id: row._session_id,
        learner_id: row._learner_id,
        issue,
      });
    }

    if (errors.length > 0) {
      blocked_rows.push({ row, errors });
      // Errors also feed the warnings cache so the org admin sees
      // them in the IlrExportWarnings dashboard alongside the
      // soft warnings.
      for (const issue of errors) {
        warnings.push({
          session_id: row._session_id,
          learner_id: row._learner_id,
          issue,
        });
      }
    } else {
      valid_rows.push(row);
    }
  }

  // ── W3: zero-session stale learners ───────────────────────────
  // Surfaced per-learner because by definition they don't appear in
  // `rows`. The orchestrator (runIlrExport below) gathers the stubs.
  if (options.learner_stubs) {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const stub of options.learner_stubs) {
      if (stub.has_any_session) continue;
      if (!stub.enrolled_at) continue;
      if (stub.enrolled_at.getTime() > thirtyDaysAgo) continue;
      const daysSinceEnrolment = Math.floor(
        (Date.now() - stub.enrolled_at.getTime()) / (24 * 60 * 60 * 1000),
      );
      warnings.push({
        session_id: "(no session)",
        learner_id: stub.learner_id,
        issue: {
          rule: "no_sessions_stale_learner",
          severity: "warning",
          message: `Learner enrolled ${daysSinceEnrolment} days ago has no sessions — possible data quality issue`,
        },
      });
    }
  }

  return { valid_rows, blocked_rows, warnings };
};

// ═════════════════════════════════════════════════════════════════════
// runIlrExport — the brief's addendum-wrapped export operation
// ═════════════════════════════════════════════════════════════════════
//
// Brief addendum: wrap the whole export operation in
// IdempotencyService.check() keyed by sha256(org_id + academic_year +
// period_start + period_end). A second call within the idempotency
// window (90 days, per the IdempotencyKey TTL) returns the cached
// result rather than re-running buildIlrRows + validateRows.
//
// Why idempotency matters here:
//   - Org admins commonly click "Generate export" twice in a session.
//   - The CSV is a snapshot of the data at run time; the second click
//     should return the same snapshot, not regenerate from current
//     state (which may have moved on by minutes).
//   - The MIS push downstream (Function 14) uses the export_id as
//     its idempotency key — duplicate uploads are a real funding
//     risk.
//
// Side effects of a fresh (non-cached) run:
//   - Writes the warnings list to IlrExportWarnings (TTL 7 days).
//   - Returns export_id so the frontend can poll the warnings cache.
// ─────────────────────────────────────────────────────────────────────

export interface RunIlrExportInput {
  org_id: string;
  academic_year: string;
  /** ISO YYYY-MM-DD — start of the funding period this submission covers. */
  period_start: string;
  /** ISO YYYY-MM-DD — end of the funding period. */
  period_end: string;
}

export interface RunIlrExportResult {
  export_id: string;
  org_id: string;
  academic_year: string;
  period_start: string;
  period_end: string;
  config_version: number | null;
  config_missing: boolean;
  valid_rows: IlrRow[];
  blocked_rows: BlockedRow[];
  warnings: ValidationWarning[];
  /** Whether this run was served from the idempotency cache. */
  cache_hit: boolean;
}

/**
 * Compute the idempotency key. Exported for tests + so the route
 * layer (Function 13 To-Do 4) can show a stable export_id before
 * the work runs.
 */
export const computeExportIdempotencyKey = (
  input: RunIlrExportInput,
): string => {
  const payload = [
    input.org_id,
    input.academic_year,
    input.period_start,
    input.period_end,
  ].join("|");
  return createHash("sha256").update(payload).digest("hex");
};

/**
 * The full export pipeline: build rows → validate → persist warnings.
 * Wrapped in IdempotencyService.check so a duplicate (org, year,
 * period_start, period_end) tuple returns the cached result.
 */
export const runIlrExport = async (
  input: RunIlrExportInput,
): Promise<RunIlrExportResult> => {
  if (!input.org_id) throw new Error("runIlrExport: org_id is required");
  if (!/^\d{4}\/\d{2}$/.test(input.academic_year)) {
    throw new Error(
      `runIlrExport: academic_year must be YYYY/YY; got ${input.academic_year}`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_start)) {
    throw new Error(
      `runIlrExport: period_start must be YYYY-MM-DD; got ${input.period_start}`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_end)) {
    throw new Error(
      `runIlrExport: period_end must be YYYY-MM-DD; got ${input.period_end}`,
    );
  }

  const exportId = computeExportIdempotencyKey(input);

  const { hit, result } = await IdempotencyService.check<RunIlrExportResult>(
    exportId,
    "ilr-export",
    async () => {
      // ── 1. Build rows + the learner stubs for W3 ───────────────
      const built = await buildIlrRows(input.org_id, input.academic_year);

      // Pull every active learner in the org so the W3 zero-session
      // rule can fire. Cheap: only the fields the validator needs.
      const learnerDocs = await User.find({
        orgId: new Types.ObjectId(input.org_id),
        role: "student",
      })
        .select("_id esolOnboardedAt createdAt")
        .lean();

      const learnersWithSessions = new Set(
        built.rows.map((r) => r._learner_id),
      );
      const learnerStubs: LearnerStubForValidation[] = learnerDocs.map((l) => ({
        learner_id: (l._id as Types.ObjectId).toString(),
        enrolled_at:
          (l.esolOnboardedAt as Date | null) ??
          (l.createdAt as Date | null) ??
          null,
        has_any_session: learnersWithSessions.has(
          (l._id as Types.ObjectId).toString(),
        ),
      }));

      // ── 2. Validate ────────────────────────────────────────────
      const validation = await validateRows(built.rows, input.academic_year, {
        learner_stubs: learnerStubs,
      });

      // ── 3. Cache warnings in IlrExportWarnings (7d TTL) ────────
      // Best-effort — a cache write failure doesn't sink the export;
      // the warnings are still returned in the response.
      if (validation.warnings.length > 0) {
        await IlrExportWarnings.create({
          export_id: exportId,
          org_id: new Types.ObjectId(input.org_id),
          warnings: validation.warnings,
        }).catch((err) =>
          logger.error(
            { err: (err as Error).message, exportId },
            "runIlrExport: IlrExportWarnings cache write failed",
          ),
        );
      }

      const out: RunIlrExportResult = {
        export_id: exportId,
        org_id: input.org_id,
        academic_year: input.academic_year,
        period_start: input.period_start,
        period_end: input.period_end,
        config_version: built.config_version,
        config_missing: built.config_missing,
        valid_rows: validation.valid_rows,
        blocked_rows: validation.blocked_rows,
        warnings: validation.warnings,
        cache_hit: false,
      };

      logger.info(
        {
          exportId,
          org_id: input.org_id,
          academic_year: input.academic_year,
          rows: built.rows.length,
          valid: validation.valid_rows.length,
          blocked: validation.blocked_rows.length,
          warnings: validation.warnings.length,
        },
        "runIlrExport: fresh export complete",
      );

      return out;
    },
    { org_id: input.org_id },
  );

  return { ...result, cache_hit: hit };
};

// Re-exports for tests
export const __internals__ = {
  buildRowForSession,
  resolveLearnAimRefForLevel,
  resolveEnglishProgType,
  decideAddHours,
  computeExportIdempotencyKey,
  validateUln,
  validateLlddCode,
};

// Public handler exports — the orchestrator's manual-review pipeline
// (Function 14 To-Do 3) can call these directly when re-validating
// edits in the org admin's correction UI.
export {
  handleSofCode as breakingChangeHandleSofCode,
  handleEnglishProgType as breakingChangeHandleEnglishProgType,
  applyFieldNameOverrides as breakingChangeApplyFieldNameOverrides,
  handleExpiredLlddt as breakingChangeHandleExpiredLlddt,
};
