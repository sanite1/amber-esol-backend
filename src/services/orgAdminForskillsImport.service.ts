import { parse } from "csv-parse";
import { Readable } from "stream";
import { Types } from "mongoose";

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AuditLog from "../models/AuditLog";
import ComplianceConfigService from "./ComplianceConfigService";
import {
  DomainScores,
  EsolLevel,
  flagWeakSkills,
  mergeWeaknessFlags,
  normaliseEsolLevel,
} from "./esolSkills";
import {
  resolveLearnerMatch,
  findLearnerInOrg,
  LearnerMatchPlan,
} from "./learnerMatching";
import logger from "../config/logger";

/**
 * POST /api/org-admin/import/forskills — brief Function 4 Phase A.
 *
 * Ingests a ForSkills (NCFE) diagnostic-assessment CSV and updates
 * each matched learner's `esolLevel` and `skillWeaknessFlags`. Matching
 * is the load-bearing part: until NCFE publishes a sample export, we
 * accept two reconciliation paths per row.
 *
 *   1. ULN match — `learner_ref` is exactly 10 digits → match by uln
 *      within the requesting org.
 *
 *   2. Identity match — `learner_ref` is anything else → fall back to
 *      `firstname` + `lastname` + `date_of_birth`, scoped to the org.
 *      These three columns are optional in the schema but mandatory
 *      in practice for non-ULN rows; rows without them error out.
 *
 * Per-row failures don't abort the file (same partial-success pattern
 * as Function 3). The summary carries the same {total, imported, failed,
 * errors, warnings} shape so the frontend can render both pages with
 * one component.
 *
 * Idempotency: we don't wrap this in IdempotencyService. Re-applying a
 * ForSkills row IS a legitimate update — a learner might be re-assessed
 * after intervention and the org admin re-uploads. The AuditLog row is
 * how we trace history, not the idempotency store.
 *
 * Audit: one `forskills_imported` AuditLog row per matched learner,
 * before_state/after_state capture esolLevel + skillWeaknessFlags so the
 * compliance trail explains the change.
 */

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export interface ForskillsRowIssue {
  row: number;
  field: string;
  message: string;
}

export interface ForskillsImportSummary {
  total: number;
  imported: number;   // learners updated this run
  failed: number;     // rows we couldn't apply (match failures, validation, etc)
  errors: ForskillsRowIssue[];
  warnings: ForskillsRowIssue[];
}

// ─────────────────────────────────────────────────────────────────────
// Reference data (validators)
// ─────────────────────────────────────────────────────────────────────

const ESOL_LEVELS: EsolLevel[] = ["e1", "e2", "e3", "l1", "l2"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCORE_MIN = 0;
const SCORE_MAX = 100;

interface RawForskillsRow {
  learner_ref?: string;
  // Optional fallback columns — required when learner_ref is not a ULN.
  firstname?: string;
  lastname?: string;
  date_of_birth?: string;
  assessment_date?: string;
  entry_level?: string;
  reading_score?: string;
  writing_score?: string;
  listening_score?: string;
  speaking_score?: string;
  recommended_level?: string;
}

interface ValidatedForskillsRow {
  learner_ref: string;
  match: LearnerMatchPlan;
  assessment_date: string;
  entry_level: EsolLevel | null;
  scores: DomainScores;
  recommended_level: EsolLevel;
}

// ─────────────────────────────────────────────────────────────────────
// Validators (named per Function 3 To-Do 3 convention)
// ─────────────────────────────────────────────────────────────────────

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

const mkError = (row: number, field: string, message: string): ForskillsRowIssue => ({
  row,
  field,
  message,
});

const validateScore = (
  raw: unknown,
  field: string,
  row: number
): { value: number | null; error: ForskillsRowIssue | null } => {
  if (isBlank(raw)) {
    return {
      value: null,
      error: mkError(row, field, `${field} is required`),
    };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < SCORE_MIN || n > SCORE_MAX) {
    return {
      value: null,
      error: mkError(
        row,
        field,
        `${field} must be a number between ${SCORE_MIN} and ${SCORE_MAX}`
      ),
    };
  }
  return { value: n, error: null };
};

const validateLevel = (
  raw: unknown,
  field: string,
  row: number,
  required: boolean
): { value: EsolLevel | null; error: ForskillsRowIssue | null } => {
  if (isBlank(raw)) {
    return {
      value: null,
      error: required
        ? mkError(row, field, `${field} is required`)
        : null,
    };
  }
  const normalised = normaliseEsolLevel(raw);
  if (!normalised) {
    return {
      value: null,
      error: mkError(
        row,
        field,
        `${field} must be one of: ${ESOL_LEVELS.join(", ")}`
      ),
    };
  }
  return { value: normalised, error: null };
};

// Learner matching is shared with Function 5 (historical sessions import)
// — see src/services/learnerMatching.ts.

const validateRow = (
  raw: RawForskillsRow,
  row: number
): { value: ValidatedForskillsRow | null; errors: ForskillsRowIssue[] } => {
  const errors: ForskillsRowIssue[] = [];

  // Match strategy — delegated to the shared helper.
  const match = resolveLearnerMatch(raw);
  for (const e of match.errors) {
    errors.push(mkError(row, e.field, e.message));
  }

  // Required date
  if (isBlank(raw.assessment_date)) {
    errors.push(mkError(row, "assessment_date", "assessment_date is required"));
  } else if (!ISO_DATE_RE.test(String(raw.assessment_date).trim())) {
    errors.push(
      mkError(row, "assessment_date", "assessment_date must be in YYYY-MM-DD format")
    );
  }

  // Optional entry_level (kept around for the audit trail; not used to mutate)
  const entryLevel = validateLevel(raw.entry_level, "entry_level", row, false);
  if (entryLevel.error) errors.push(entryLevel.error);

  // Required scores
  const reading = validateScore(raw.reading_score, "reading_score", row);
  const writing = validateScore(raw.writing_score, "writing_score", row);
  const listening = validateScore(raw.listening_score, "listening_score", row);
  const speaking = validateScore(raw.speaking_score, "speaking_score", row);
  for (const r of [reading, writing, listening, speaking]) {
    if (r.error) errors.push(r.error);
  }

  // Required recommended_level
  const recommended = validateLevel(
    raw.recommended_level,
    "recommended_level",
    row,
    true
  );
  if (recommended.error) errors.push(recommended.error);

  if (errors.length > 0) return { value: null, errors };

  return {
    value: {
      learner_ref: (raw.learner_ref as string).trim(),
      match,
      assessment_date: (raw.assessment_date as string).trim(),
      entry_level: entryLevel.value,
      scores: {
        reading: reading.value!,
        writing: writing.value!,
        listening: listening.value!,
        speaking: speaking.value!,
      },
      recommended_level: recommended.value!,
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
  buf: Buffer
): AsyncGenerator<
  { row: number; value: ValidatedForskillsRow; errors: null } |
  { row: number; value: null; errors: ForskillsRowIssue[] }
> {
  const parser = bufferToStream(buf).pipe(
    parse({
      columns: true,
      trim: true,
      skip_empty_lines: true,
      relax_quotes: true,
      bom: true,
    })
  );

  let rowNumber = 0;
  for await (const raw of parser as AsyncIterable<RawForskillsRow>) {
    rowNumber += 1;
    const { value, errors } = validateRow(raw, rowNumber);
    if (value) {
      yield { row: rowNumber, value, errors: null };
    } else {
      yield { row: rowNumber, value: null, errors };
    }
  }
}

const applyToLearner = async (
  row: ValidatedForskillsRow,
  orgId: string,
  actorId: string
): Promise<{ learnerId: string; updated: boolean }> => {
  const learner = await findLearnerInOrg(row.match, orgId);
  if (!learner) {
    throw new ApiError(
      404,
      `No learner in this organisation matched learner_ref=${row.learner_ref}`
    );
  }

  // Capture before-state for the audit row BEFORE mutating.
  const beforeState = {
    esol_level: learner.esolLevel ?? null,
    skill_weakness_flags: [...(learner.skillWeaknessFlags ?? [])],
  };

  const incomingFlags = flagWeakSkills(row.scores, row.recommended_level);
  const mergedFlags = mergeWeaknessFlags(
    learner.skillWeaknessFlags,
    incomingFlags
  );

  learner.esolLevel = row.recommended_level;
  learner.skillWeaknessFlags = mergedFlags;
  await learner.save();

  const ilrConfig = ComplianceConfigService.getCurrent("ilr");
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "org_admin",
    actor_id: new Types.ObjectId(actorId),
    org_id: new Types.ObjectId(orgId),
    learner_id: learner._id,
    action: "forskills_imported",
    before_state: beforeState,
    after_state: {
      esol_level: row.recommended_level,
      skill_weakness_flags: mergedFlags,
      assessment_date: row.assessment_date,
      // The four ForSkills domain scores are captured verbatim so an
      // auditor can re-derive the flag set if pass thresholds change.
      reading_score: row.scores.reading,
      writing_score: row.scores.writing,
      listening_score: row.scores.listening,
      speaking_score: row.scores.speaking,
      entry_level: row.entry_level ?? null,
    },
    reason: "ForSkills assessment imported via CSV upload",
    compliance_config_version: ilrConfig?.version ?? null,
  }).catch((err) =>
    logger.error(
      { err, learnerId: learner._id, orgId },
      "AuditLog write failed for forskills_imported"
    )
  );

  return { learnerId: learner._id.toString(), updated: true };
};

// ─────────────────────────────────────────────────────────────────────
// Service entry point
// ─────────────────────────────────────────────────────────────────────

export const importForskillsService = async (
  file: Express.Multer.File | undefined,
  orgId: string,
  actorId: string
): Promise<ApiResponse> => {
  if (!file) {
    throw new ApiError(400, "CSV file is required (multipart field 'file')");
  }
  if (!file.buffer || file.buffer.length === 0) {
    throw new ApiError(400, "Uploaded file is empty");
  }

  const summary: ForskillsImportSummary = {
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
        await applyToLearner(out.value, orgId, actorId);
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
    logger.error({ err, orgId }, "CSV parse aborted during ForSkills import");
    throw new ApiError(
      400,
      `CSV parse failed: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  return new ApiResponse(200, "ForSkills import complete", summary);
};
