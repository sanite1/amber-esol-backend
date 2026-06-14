/**
 * MIS record validation — Phase 21, Final Addendum §7 + §5.
 *
 * **Pure function** — given a `MISRecord` and the active
 * ComplianceConfig snapshot, return a structured pass/fail with
 * reasons. No I/O, no logging, no side effects. Both the
 * `mis-push` worker (inline pre-check) and the standalone
 * `compliance-validation` worker call this directly.
 *
 * Why the duplication of inline + standalone
 * ==========================================
 *
 * The standalone `compliance-validation` queue exists for the
 * broader "green-light" pattern (Phase 1.C) — ILR exports, RARPA
 * artefacts, and MIS pushes all share the surface. Other code
 * paths (e.g. a future "validate before generating an evidence
 * pack" feature) can enqueue against the same queue without
 * needing a push job.
 *
 * BUT — the mis-push worker MUST run validation itself, inline,
 * before calling the adapter. That's not redundant with the
 * standalone worker; it's defence-in-depth. A direct push (manual
 * admin trigger, internal cron, anything that bypasses the
 * standalone queue) still has to clear validation. Centralising
 * the rule set here means both paths can never drift.
 *
 * Rule sourcing
 * =============
 *
 * Real validation rules live in `ComplianceConfig` (Phase 1.E),
 * domain `"ilr"`, for the academic year of the push. The function
 * here reads the rule bag and applies it. **No rules are
 * hardcoded in this file** — that's the Phase-1.E architectural
 * commitment.
 *
 * Today's rule set (MVP scope) covers:
 *   - Mandatory-field presence
 *   - ULN shape (10 digits)
 *   - Date sanity (start ≤ planned end; act_end null OR ≥ start)
 *   - `outcome` and `comp_status` codes in the active valid-value
 *     lists from ComplianceConfig
 *   - `sof` / `english_prog_type` codes in the active valid-value
 *     lists
 *   - `total_glh ≥ 0`
 *   - `add_hours ≥ 0`
 *
 * Each rule produces a string reason on failure suitable for the
 * AuditLog row's `reason` field — an org admin reading the audit
 * log sees plain English, not a code.
 */

import ComplianceConfigService from "../ComplianceConfigService";
import type { MISRecord } from "./types";

// ─────────────────────────────────────────────────────────────────────
// Public result shape
// ─────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  /** Plain-English reasons. Empty array when valid. */
  reasons: string[];
  /** Snapshot of the ComplianceConfig version used (for AuditLog). */
  compliance_config_version: number | null;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers — pure
// ─────────────────────────────────────────────────────────────────────

const ULN_PATTERN = /^\d{10}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

const parseIsoDate = (s: string | null | undefined): Date | null => {
  if (!s || !ISO_DATE_PATTERN.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Pull a typed valid-values list off the ComplianceConfig rule
 * bag. The shape inside `config.rules` is domain-specific and
 * intentionally untyped at the model layer; this helper narrows
 * defensively without crashing on a missing rule.
 */
const validValuesFor = (
  rules: unknown,
  ruleKey: string,
): ReadonlyArray<string | number> | null => {
  if (!rules || typeof rules !== "object") return null;
  const bag = rules as Record<string, unknown>;
  const list = bag[ruleKey];
  if (!Array.isArray(list)) return null;
  return list.filter(
    (v): v is string | number => typeof v === "string" || typeof v === "number",
  );
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry — validateMisRecord
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate one MISRecord against the active ComplianceConfig for
 * the given academic year.
 *
 * The academic year is derived from `learn_start_date` rather than
 * `now` — so historical pushes for a previous year's cohort use
 * the rules in force at the time of learning, not today's rules.
 * This matches the ILR exporter's behaviour (Function 13).
 *
 * @returns ValidationResult with `valid: false` and per-failure
 * reasons. NEVER throws.
 */
export const validateMisRecord = (record: MISRecord): ValidationResult => {
  const reasons: string[] = [];

  // ── 1. Mandatory fields ────────────────────────────────────────
  if (!isNonEmptyString(record.uln)) {
    reasons.push("ULN is missing.");
  } else if (!ULN_PATTERN.test(record.uln)) {
    reasons.push(
      `ULN "${record.uln}" is not 10 digits (every ESFA-issued ULN is 10 digits).`,
    );
  }
  if (!isNonEmptyString(record.firstname))
    reasons.push("First name is missing.");
  if (!isNonEmptyString(record.lastname)) reasons.push("Last name is missing.");
  if (!isNonEmptyString(record.date_of_birth)) {
    reasons.push("Date of birth is missing.");
  } else if (!parseIsoDate(record.date_of_birth)) {
    reasons.push(
      `Date of birth "${record.date_of_birth}" is not a valid YYYY-MM-DD date.`,
    );
  }
  if (!isNonEmptyString(record.esol_level))
    reasons.push("ESOL level is missing.");

  // ── 2. Date sanity ────────────────────────────────────────────
  const startDate = parseIsoDate(record.learn_start_date);
  const plannedEnd = parseIsoDate(record.learn_plan_end_date);
  const actualEnd = parseIsoDate(record.learn_act_end_date);

  if (!startDate) {
    reasons.push(
      `Learn start date "${record.learn_start_date}" is not a valid YYYY-MM-DD date.`,
    );
  }
  if (!plannedEnd) {
    reasons.push(
      `Learn planned end date "${record.learn_plan_end_date}" is not a valid YYYY-MM-DD date.`,
    );
  }
  if (startDate && plannedEnd && startDate > plannedEnd) {
    reasons.push(
      `Learn start date is after the planned end date — start must be ≤ planned end.`,
    );
  }
  if (record.learn_act_end_date !== null && actualEnd === null) {
    reasons.push(
      `Learn actual end date "${record.learn_act_end_date}" is not a valid YYYY-MM-DD date.`,
    );
  }
  if (startDate && actualEnd && startDate > actualEnd) {
    reasons.push(
      "Learn start date is after the actual end date — start must be ≤ actual end.",
    );
  }

  // ── 3. Numeric sanity ────────────────────────────────────────
  if (typeof record.total_glh !== "number" || record.total_glh < 0) {
    reasons.push(
      `Total GLH (${record.total_glh}) must be a non-negative number.`,
    );
  }
  if (typeof record.add_hours !== "number" || record.add_hours < 0) {
    reasons.push(
      `Additional hours (${record.add_hours}) must be a non-negative number.`,
    );
  }

  // ── 4. Code lists from ComplianceConfig ──────────────────────
  // Derive the academic year from learn_start_date so historical
  // pushes use the rules that were in force at the time of
  // learning. UK academic year boundary is 1 August.
  let academicYear: string | null = null;
  let configVersion: number | null = null;
  let validValues: {
    outcome?: ReadonlyArray<string | number> | null;
    comp_status?: ReadonlyArray<string | number> | null;
    sof?: ReadonlyArray<string | number> | null;
    english_prog_type?: ReadonlyArray<string | number> | null;
  } = {};

  if (startDate) {
    academicYear = ukAcademicYearFor(startDate);
    const config = ComplianceConfigService.getConfig("ilr", academicYear);
    if (!config) {
      // Fail-closed: the ILR pipeline already fails-closed when a
      // year's config is absent. Same posture here — we cannot
      // validate without rules, so the record is held.
      reasons.push(
        `No active ComplianceConfig for ilr / ${academicYear} — cannot validate. ` +
          "Have an Amber admin activate the config for this academic year via " +
          "/admin/compliance-config.",
      );
    } else {
      configVersion = config.version;
      validValues = {
        outcome: validValuesFor(config.rules, "valid_outcomes"),
        comp_status: validValuesFor(config.rules, "valid_comp_statuses"),
        sof: validValuesFor(config.rules, "valid_sof_codes"),
        english_prog_type: validValuesFor(
          config.rules,
          "valid_english_prog_types",
        ),
      };
    }
  }

  // Apply code-list checks only when we have a list to check
  // against (absent list → already reported as "no config" above).
  if (validValues.outcome) {
    if (!validValues.outcome.includes(record.outcome)) {
      reasons.push(
        `Outcome code "${record.outcome}" is not in the active valid-value list for ${academicYear}.`,
      );
    }
  }
  if (validValues.comp_status) {
    if (!validValues.comp_status.includes(record.comp_status)) {
      reasons.push(
        `Completion status code "${record.comp_status}" is not in the active valid-value list for ${academicYear}.`,
      );
    }
  }
  if (validValues.sof) {
    if (!validValues.sof.includes(record.sof)) {
      reasons.push(
        `Source-of-funding code "${record.sof}" is not in the active valid-value list for ${academicYear}.`,
      );
    }
  }
  if (validValues.english_prog_type) {
    if (!validValues.english_prog_type.includes(record.english_prog_type)) {
      reasons.push(
        `EnglishProgType "${record.english_prog_type}" is not in the active valid-value list for ${academicYear}.`,
      );
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    compliance_config_version: configVersion,
  };
};

// ─────────────────────────────────────────────────────────────────────
// UK academic-year helper
// ─────────────────────────────────────────────────────────────────────

/**
 * UK academic year code for a given date. Year flips on 1 August.
 *
 *   31 Jul 2026 → "2025/26"
 *   01 Aug 2026 → "2026/27"
 *
 * Mirrors `ComplianceConfigService.currentAcademicYear()` semantics
 * but takes the date as an arg so historical records use historical
 * rules.
 */
const ukAcademicYearFor = (date: Date): string => {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0 = Jan, 7 = Aug
  if (m >= 7) return `${y}/${String(y + 1).slice(-2)}`;
  return `${y - 1}/${String(y).slice(-2)}`;
};

// Re-export for tests
export const __internals__ = {
  ULN_PATTERN,
  ISO_DATE_PATTERN,
  parseIsoDate,
  validValuesFor,
  ukAcademicYearFor,
};
