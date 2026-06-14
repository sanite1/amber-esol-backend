import { parse } from "csv-parse";
import { Readable } from "stream";
import { Types } from "mongoose";

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AISession from "../models/AISession";
import AuditLog from "../models/AuditLog";
import ComplianceConfigService from "./ComplianceConfigService";
import {
  resolveLearnerMatch,
  findLearnerInOrg,
  LearnerMatchPlan,
} from "./learnerMatching";
import { ALL_ILR_CODES, IlrSkillCode } from "./esolSkills";
import logger from "../config/logger";

/**
 * POST /api/org-admin/import/sessions — brief Function 5.
 *
 * Imports historical pre-platform sessions as `AISession` documents
 * tagged `session_source: "pre_platform"`. These rows count towards
 * the org's GLH totals in the ILR export and the org admin dashboard,
 * but they produce NO turns, NO vocab evidence, and NO RARPA Stage 4
 * material — a learner's pre-platform hours are just a number, not a
 * pedagogical record.
 *
 * Matching uses the shared `learnerMatching` helper (same logic as
 * Function 4): ULN when `learner_ref` is 10 digits, otherwise the
 * optional firstname+lastname+date_of_birth fallback.
 *
 * Partial-success + error-reporting pattern mirrors Function 3:
 *   - Per-row failures populate `errors[]`
 *   - Valid rows commit immediately, no batch rollback
 *   - Summary carries {total, imported, failed, errors[], warnings[]}
 *
 * The CSV's `session_source` column is read but ignored — every row
 * lands as "pre_platform" regardless. This is per the brief; the
 * column exists so a vendor that exports session metadata can leave
 * its native value in place.
 *
 * No idempotency wrap: each row is a fresh AISession with its own
 * ObjectId. Re-uploading the same CSV creates duplicate session docs.
 * That's the trade-off — there's no natural unique key for a pre-
 * platform session (a learner could legitimately have two 60-minute
 * sessions on the same day). Org admins should treat these uploads as
 * append-only and avoid re-uploading the same window.
 */

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export interface SessionRowIssue {
  row: number;
  field: string;
  message: string;
}

export interface SessionsImportSummary {
  total: number;
  imported: number;
  failed: number;
  errors: SessionRowIssue[];
  warnings: SessionRowIssue[];
}

// ─────────────────────────────────────────────────────────────────────
// Reference data + raw row shape
// ─────────────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_DURATION_MINS = 1;
const MAX_DURATION_MINS = 24 * 60; // 24 hours — anything longer is a data-entry typo

const ILR_CODES_SET = new Set<string>(ALL_ILR_CODES);

interface RawSessionRow {
  learner_ref?: string;
  // Identity-fallback columns (used when learner_ref is not a ULN).
  firstname?: string;
  lastname?: string;
  date_of_birth?: string;

  session_date?: string;
  duration_minutes?: string;
  skill_codes?: string;
  session_source?: string; // read but ignored
}

interface ValidatedSessionRow {
  match: LearnerMatchPlan;
  session_date: string;
  duration_mins: number;
  skill_codes_covered: IlrSkillCode[];
}

// ─────────────────────────────────────────────────────────────────────
// Validators (named per Function 3 To-Do 3 convention)
// ─────────────────────────────────────────────────────────────────────

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

const mkError = (
  row: number,
  field: string,
  message: string,
): SessionRowIssue => ({
  row,
  field,
  message,
});

export const validateSessionDate = (
  raw: unknown,
  row: number,
): SessionRowIssue | null => {
  if (isBlank(raw)) {
    return mkError(row, "session_date", "session_date is required");
  }
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw.trim())) {
    return mkError(
      row,
      "session_date",
      "session_date must be in YYYY-MM-DD format",
    );
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return mkError(
      row,
      "session_date",
      "session_date is not a real calendar date",
    );
  }
  // Sessions in the future make no sense for a "historical" import.
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    return mkError(
      row,
      "session_date",
      "session_date is in the future — historical imports must use past dates",
    );
  }
  return null;
};

export const validateDurationMinutes = (
  raw: unknown,
  row: number,
): { value: number | null; error: SessionRowIssue | null } => {
  if (isBlank(raw)) {
    return {
      value: null,
      error: mkError(row, "duration_minutes", "duration_minutes is required"),
    };
  }
  const asNum = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(asNum) || asNum <= 0) {
    return {
      value: null,
      error: mkError(
        row,
        "duration_minutes",
        "duration_minutes must be a positive number",
      ),
    };
  }
  const rounded = Math.round(asNum);
  if (rounded < MIN_DURATION_MINS || rounded > MAX_DURATION_MINS) {
    return {
      value: null,
      error: mkError(
        row,
        "duration_minutes",
        `duration_minutes must be between ${MIN_DURATION_MINS} and ${MAX_DURATION_MINS}`,
      ),
    };
  }
  return { value: rounded, error: null };
};

/**
 * Parse a comma-separated `skill_codes` cell into an array of ILR codes.
 * Empty cell is fine — sessions can be untagged at this layer. Unknown
 * codes (e.g. "Lr,Foo,Sc") fail the whole row so a typo doesn't end up
 * silently dropped from the audit trail.
 */
export const validateSkillCodes = (
  raw: unknown,
  row: number,
): { value: IlrSkillCode[]; error: SessionRowIssue | null } => {
  if (isBlank(raw)) return { value: [], error: null };
  if (typeof raw !== "string") {
    return {
      value: [],
      error: mkError(row, "skill_codes", "skill_codes must be a string"),
    };
  }
  const codes = raw
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  const unknown = codes.filter((c) => !ILR_CODES_SET.has(c));
  if (unknown.length > 0) {
    return {
      value: [],
      error: mkError(
        row,
        "skill_codes",
        `skill_codes contains unknown ILR code(s): ${unknown.join(", ")}. ` +
          `Valid codes: ${ALL_ILR_CODES.join(", ")}`,
      ),
    };
  }
  // De-dupe while preserving the canonical ALL_ILR_CODES order.
  const set = new Set(codes);
  return {
    value: ALL_ILR_CODES.filter((c) => set.has(c)),
    error: null,
  };
};

export const validateRow = (
  raw: RawSessionRow,
  row: number,
): { value: ValidatedSessionRow | null; errors: SessionRowIssue[] } => {
  const errors: SessionRowIssue[] = [];

  // Learner matching — shared with Function 4.
  const match = resolveLearnerMatch(raw);
  for (const e of match.errors) {
    errors.push(mkError(row, e.field, e.message));
  }

  const dateErr = validateSessionDate(raw.session_date, row);
  if (dateErr) errors.push(dateErr);

  const duration = validateDurationMinutes(raw.duration_minutes, row);
  if (duration.error) errors.push(duration.error);

  const skills = validateSkillCodes(raw.skill_codes, row);
  if (skills.error) errors.push(skills.error);

  if (errors.length > 0) return { value: null, errors };

  return {
    value: {
      match,
      session_date: (raw.session_date as string).trim(),
      duration_mins: duration.value!,
      skill_codes_covered: skills.value,
    },
    errors: [],
  };
};

// ─────────────────────────────────────────────────────────────────────
// CSV streaming + commit
// ─────────────────────────────────────────────────────────────────────

const bufferToStream = (buf: Buffer): Readable => {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
};

async function* streamRows(
  buf: Buffer,
): AsyncGenerator<
  | { row: number; value: ValidatedSessionRow; errors: null }
  | { row: number; value: null; errors: SessionRowIssue[] }
> {
  const parser = bufferToStream(buf).pipe(
    parse({
      columns: true,
      trim: true,
      skip_empty_lines: true,
      relax_quotes: true,
      bom: true,
    }),
  );

  let rowNumber = 0;
  for await (const raw of parser as AsyncIterable<RawSessionRow>) {
    rowNumber += 1;
    const { value, errors } = validateRow(raw, rowNumber);
    if (value) yield { row: rowNumber, value, errors: null };
    else yield { row: rowNumber, value: null, errors };
  }
}

/**
 * Insert one historical session against a matched learner. The
 * `createdAt` field is set to `session_date` rather than `Date.now()`
 * — this is what makes GLH aggregations over an academic year work
 * correctly. Mongoose's `timestamps: true` would otherwise overwrite
 * createdAt with the import time; we pass it explicitly and let
 * Mongoose persist our value.
 */
const insertSession = async (
  row: ValidatedSessionRow,
  orgId: string,
  actorId: string,
): Promise<{ sessionId: string; learnerId: string }> => {
  const learner = await findLearnerInOrg(row.match, orgId);
  if (!learner) {
    throw new ApiError(
      404,
      `No learner in this organisation matched the row's identity fields`,
    );
  }

  const sessionDate = new Date(row.session_date);

  // Build the document then set timestamps explicitly. Mongoose's
  // timestamps middleware honours an explicit createdAt only when the
  // document is constructed via `new Model()`, not via `Model.create()`.
  const doc = new AISession({
    learnerId: learner._id,
    teacherId: null,
    orgId: new Types.ObjectId(orgId),
    bookingId: null,
    sessionMode: "BRIDGE",
    // Snapshot the learner's CURRENT level — better than null for any
    // downstream level-aware aggregator. Historical level data isn't
    // in the CSV per the brief.
    esolLevel: learner.esolLevel ?? null,
    topic: undefined,
    turns: [],
    safeguardingFlagged: false,
    assessmentSummary: undefined,
    // Critical: brief Function 5 says NO vocab ledger entries for
    // pre-platform sessions. vocabIntroduced stays empty.
    vocabIntroduced: [],
    completedAt: sessionDate,

    // Function 5 fields
    session_source: "pre_platform",
    duration_mins: row.duration_mins,
    skill_codes_covered: row.skill_codes_covered,
    scenario_id: null,
    final_score: null,
    passed: null,
  });
  doc.set("createdAt", sessionDate);
  doc.set("updatedAt", sessionDate);
  await doc.save({ timestamps: false });

  const ilrConfig = ComplianceConfigService.getCurrent("ilr");
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "org_admin",
    actor_id: new Types.ObjectId(actorId),
    org_id: new Types.ObjectId(orgId),
    learner_id: learner._id,
    action: "historical_session_imported",
    before_state: {},
    after_state: {
      session_id: doc._id.toString(),
      session_source: "pre_platform",
      session_date: row.session_date,
      duration_mins: row.duration_mins,
      skill_codes_covered: row.skill_codes_covered,
    },
    reason:
      "Historical pre-platform session imported — counts towards GLH, " +
      "produces no RARPA evidence",
    compliance_config_version: ilrConfig?.version ?? null,
  }).catch((err) =>
    logger.error(
      { err, sessionId: doc._id, learnerId: learner._id, orgId },
      "AuditLog write failed for historical_session_imported",
    ),
  );

  return {
    sessionId: doc._id.toString(),
    learnerId: learner._id.toString(),
  };
};

// ─────────────────────────────────────────────────────────────────────
// Service entry point
// ─────────────────────────────────────────────────────────────────────

export const importSessionsService = async (
  file: Express.Multer.File | undefined,
  orgId: string,
  actorId: string,
): Promise<ApiResponse> => {
  if (!file) {
    throw new ApiError(400, "CSV file is required (multipart field 'file')");
  }
  if (!file.buffer || file.buffer.length === 0) {
    throw new ApiError(400, "Uploaded file is empty");
  }

  const summary: SessionsImportSummary = {
    total: 0,
    imported: 0,
    failed: 0,
    errors: [],
    warnings: [],
  };

  try {
    for await (const out of streamRows(file.buffer)) {
      summary.total += 1;

      if (out.errors) {
        summary.failed += 1;
        summary.errors.push(...out.errors);
        continue;
      }

      try {
        await insertSession(out.value, orgId, actorId);
        summary.imported += 1;
      } catch (err) {
        summary.failed += 1;
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Unknown error";
        summary.errors.push(mkError(out.row, "*", msg));
      }
    }
  } catch (err) {
    logger.error({ err, orgId }, "CSV parse aborted during sessions import");
    throw new ApiError(
      400,
      `CSV parse failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  return new ApiResponse(200, "Historical sessions import complete", summary);
};
