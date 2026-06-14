import { createHash, randomBytes } from "crypto";
import { parse } from "csv-parse";
import bcrypt from "bcrypt";
import { Readable } from "stream";
import { Types } from "mongoose";
import { v4 as uuidv4 } from "uuid";

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import PostcodeRouter from "./postcodeRouter.service";
import ComplianceConfigService from "./ComplianceConfigService";
import IdempotencyService from "./idempotency.service";
import { createNotification } from "./notification.service";
import logger from "../config/logger";

const SALT_ROUNDS = 13;

/**
 * POST /api/org-admin/import/learners — brief Function 3 To-Dos 2 + 3.
 *
 * Streaming CSV → per-row validation → idempotent User creation.
 *
 * Row numbering (per brief To-Do 3): 1-indexed from the first DATA row.
 * The CSV header is row 0 in our model and never appears in errors.
 * So "row 1" in the response = the first learner in the file.
 *
 * Per-row failures DO NOT abort the file. Valid rows commit; invalid
 * rows surface in `errors`. Soft conditions (postcode not in dataset)
 * surface in `warnings` — the row still commits, but the learner lands
 * with `sof_code = null` and `funding_status = "manual_review"`.
 *
 * Idempotency key = sha256(org_id + email + date_of_birth). Re-uploading
 * the same CSV is a no-op.
 */

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export interface ImportRowIssue {
  row: number; // 1-indexed from first data row
  field: string; // CSV column name; "*" for whole-row errors
  message: string; // plain English — surfaced verbatim to org admin
}

export interface BulkImportSummary {
  total: number;
  imported: number;
  failed: number;
  duplicate: number;
  errors: ImportRowIssue[];
  warnings: ImportRowIssue[];
}

interface RawCsvRow {
  firstname?: string;
  lastname?: string;
  date_of_birth?: string;
  nationality?: string;
  l1_language?: string;
  postcode_prior?: string;
  uln?: string;
  esol_level_at_import?: string;
  enrolment_date?: string;
  employment_status?: string;
  lldd_health_prob?: string;
  aim_type?: string;
  email?: string;
}

export interface ValidatedRow {
  firstname: string;
  lastname: string;
  date_of_birth: string;
  nationality: string;
  l1_language:
    | "arabic"
    | "somali"
    | "dari"
    | "pashto"
    | "cantonese"
    | "english"
    | "other";
  postcode_prior: string;
  uln: string | null;
  esol_level_at_import: "e1" | "e2" | "e3" | "l1" | "l2";
  enrolment_date: string;
  employment_status:
    | "unemployed"
    | "employed"
    | "self_employed"
    | "not_in_labour_market";
  lldd_health_prob: 1 | 2 | 9;
  aim_type: "regulated" | "non_regulated";
  email: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Reference data (single source of truth for the validators below)
// ─────────────────────────────────────────────────────────────────────

const L1_LANGUAGES = [
  "arabic",
  "somali",
  "dari",
  "pashto",
  "cantonese",
  "english",
  "other",
] as const;
const ESOL_LEVELS = ["e1", "e2", "e3", "l1", "l2"] as const;
const EMPLOYMENT_STATUSES = [
  "unemployed",
  "employed",
  "self_employed",
  "not_in_labour_market",
] as const;
const AIM_TYPES = ["regulated", "non_regulated"] as const;
const LLDD_VALUES = [1, 2, 9] as const;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UK_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const ULN_RE = /^\d{10}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN_ENROLMENT_AGE_YEARS = 16;

// ─────────────────────────────────────────────────────────────────────
// Field-level validators
//
// Each validator returns either an ImportRowIssue (with row & field
// populated) or null when the value is fine. Validators don't mutate;
// validateRow() collects their outputs and composes the result.
//
// All validators tolerate `undefined` and treat blank strings as
// "missing" — CSVs from Excel reliably emit "" for empty cells.
// ─────────────────────────────────────────────────────────────────────

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

const mkError = (
  row: number,
  field: string,
  message: string,
): ImportRowIssue => ({
  row,
  field,
  message,
});

export const validateRequired = (
  raw: unknown,
  field: string,
  row: number,
): ImportRowIssue | null =>
  isBlank(raw) ? mkError(row, field, `${field} is required`) : null;

export const validateIsoDate = (
  raw: unknown,
  field: string,
  row: number,
): ImportRowIssue | null => {
  if (typeof raw !== "string" || !ISO_DATE_RE.test(raw)) {
    return mkError(row, field, `${field} must be in YYYY-MM-DD format`);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return mkError(row, field, `${field} is not a real calendar date`);
  }
  return null;
};

export const validateEnum = <T extends string>(
  raw: unknown,
  field: string,
  allowed: readonly T[],
  row: number,
): ImportRowIssue | null => {
  if (typeof raw !== "string") {
    return mkError(row, field, `${field} is required`);
  }
  if (!allowed.includes(raw.trim().toLowerCase() as T)) {
    return mkError(
      row,
      field,
      `${field} must be one of: ${allowed.join(", ")}`,
    );
  }
  return null;
};

export const validateUkPostcode = (
  raw: unknown,
  row: number,
): ImportRowIssue | null => {
  if (typeof raw !== "string" || !UK_POSTCODE_RE.test(raw.trim())) {
    return mkError(
      row,
      "postcode_prior",
      "postcode_prior must be a valid UK postcode (e.g. M1 1AE)",
    );
  }
  return null;
};

export const validateUln = (
  raw: unknown,
  row: number,
): ImportRowIssue | null => {
  // ULN is optional. Blank/missing → fine. If present, must be 10 digits.
  if (isBlank(raw)) return null;
  if (typeof raw !== "string" || !ULN_RE.test(raw.trim())) {
    return mkError(row, "uln", "uln must be exactly 10 digits when provided");
  }
  return null;
};

/**
 * `lldd_health_prob` is the most compliance-sensitive field in the file.
 * The brief is explicit: NEVER default it. Blank, "0", "yes", "no", or
 * anything outside {1, 2, 9} fails the row.
 */
export const validateLlddHealthProb = (
  raw: unknown,
  row: number,
): ImportRowIssue | null => {
  if (isBlank(raw)) {
    return mkError(
      row,
      "lldd_health_prob",
      "lldd_health_prob is required — must be sourced from the learner, never defaulted",
    );
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || !LLDD_VALUES.includes(n as 1 | 2 | 9)) {
    return mkError(
      row,
      "lldd_health_prob",
      "lldd_health_prob must be 1 (yes), 2 (no), or 9 (prefer not to say)",
    );
  }
  return null;
};

export const validateEmail = (
  raw: unknown,
  row: number,
): ImportRowIssue | null => {
  // Email is optional. Blank = use placeholder downstream.
  if (isBlank(raw)) return null;
  if (typeof raw !== "string" || !EMAIL_RE.test(raw.trim())) {
    return mkError(row, "email", "email must be a valid email address");
  }
  return null;
};

/**
 * Cross-field rule: learner must be ≥ 16 on enrolment_date.
 *
 * Returns null if either date is malformed — the per-field validators
 * already produced an error for that; piling on here just creates noise.
 */
export const validateAgeAtEnrolment = (
  dob: string | undefined,
  enrolDate: string | undefined,
  row: number,
): ImportRowIssue | null => {
  if (!dob || !enrolDate) return null;
  const dobD = new Date(dob);
  const enrolD = new Date(enrolDate);
  if (Number.isNaN(dobD.getTime()) || Number.isNaN(enrolD.getTime())) {
    return null;
  }
  const minDob = new Date(enrolD);
  minDob.setFullYear(minDob.getFullYear() - MIN_ENROLMENT_AGE_YEARS);
  if (dobD > minDob) {
    return mkError(
      row,
      "date_of_birth",
      `learner must be at least ${MIN_ENROLMENT_AGE_YEARS} years old on enrolment_date`,
    );
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────
// Row composer
// ─────────────────────────────────────────────────────────────────────

export interface RowValidationResult {
  value: ValidatedRow | null;
  errors: ImportRowIssue[];
}

/**
 * Run every validator over a raw row. Returns the normalised value plus
 * an error list (empty = row is valid). One pass per row, errors do not
 * short-circuit each other — the org admin sees ALL issues at once and
 * can fix the row in one edit.
 */
export const validateRow = (
  raw: RawCsvRow,
  row: number,
): RowValidationResult => {
  const errors: ImportRowIssue[] = [];

  // Required string fields (firstname, lastname, nationality have no
  // format beyond non-empty).
  for (const field of ["firstname", "lastname", "nationality"] as const) {
    const err = validateRequired(raw[field], field, row);
    if (err) errors.push(err);
  }

  // Required dates.
  const dobErr =
    validateRequired(raw.date_of_birth, "date_of_birth", row) ||
    validateIsoDate(raw.date_of_birth, "date_of_birth", row);
  if (dobErr) errors.push(dobErr);

  const enrolErr =
    validateRequired(raw.enrolment_date, "enrolment_date", row) ||
    validateIsoDate(raw.enrolment_date, "enrolment_date", row);
  if (enrolErr) errors.push(enrolErr);

  // Age check — only runs if both dates parsed.
  if (!dobErr && !enrolErr) {
    const ageErr = validateAgeAtEnrolment(
      raw.date_of_birth,
      raw.enrolment_date,
      row,
    );
    if (ageErr) errors.push(ageErr);
  }

  // Required enums.
  const l1Err =
    validateRequired(raw.l1_language, "l1_language", row) ||
    validateEnum(raw.l1_language, "l1_language", L1_LANGUAGES, row);
  if (l1Err) errors.push(l1Err);

  const levelErr =
    validateRequired(raw.esol_level_at_import, "esol_level_at_import", row) ||
    validateEnum(
      raw.esol_level_at_import,
      "esol_level_at_import",
      ESOL_LEVELS,
      row,
    );
  if (levelErr) errors.push(levelErr);

  const empErr =
    validateRequired(raw.employment_status, "employment_status", row) ||
    validateEnum(
      raw.employment_status,
      "employment_status",
      EMPLOYMENT_STATUSES,
      row,
    );
  if (empErr) errors.push(empErr);

  const aimErr =
    validateRequired(raw.aim_type, "aim_type", row) ||
    validateEnum(raw.aim_type, "aim_type", AIM_TYPES, row);
  if (aimErr) errors.push(aimErr);

  // Required + format: lldd_health_prob (own validator because it's
  // numeric and compliance-critical).
  const llddErr = validateLlddHealthProb(raw.lldd_health_prob, row);
  if (llddErr) errors.push(llddErr);

  // Required + format: postcode.
  const pcErr =
    validateRequired(raw.postcode_prior, "postcode_prior", row) ||
    validateUkPostcode(raw.postcode_prior, row);
  if (pcErr) errors.push(pcErr);

  // Optional fields.
  const ulnErr = validateUln(raw.uln, row);
  if (ulnErr) errors.push(ulnErr);
  const emailErr = validateEmail(raw.email, row);
  if (emailErr) errors.push(emailErr);

  if (errors.length > 0) {
    return { value: null, errors };
  }

  // All validators passed — assemble the normalised row.
  const value: ValidatedRow = {
    firstname: (raw.firstname as string).trim(),
    lastname: (raw.lastname as string).trim(),
    date_of_birth: (raw.date_of_birth as string).trim(),
    nationality: (raw.nationality as string).trim(),
    l1_language: (raw.l1_language as string)
      .trim()
      .toLowerCase() as ValidatedRow["l1_language"],
    postcode_prior: (raw.postcode_prior as string).trim().toUpperCase(),
    uln: isBlank(raw.uln) ? null : (raw.uln as string).trim(),
    esol_level_at_import: (raw.esol_level_at_import as string)
      .trim()
      .toLowerCase() as ValidatedRow["esol_level_at_import"],
    enrolment_date: (raw.enrolment_date as string).trim(),
    employment_status: (raw.employment_status as string)
      .trim()
      .toLowerCase() as ValidatedRow["employment_status"],
    lldd_health_prob: Number(raw.lldd_health_prob) as 1 | 2 | 9,
    aim_type: (raw.aim_type as string)
      .trim()
      .toLowerCase() as ValidatedRow["aim_type"],
    email: isBlank(raw.email)
      ? null
      : (raw.email as string).trim().toLowerCase(),
  };

  return { value, errors: [] };
};

// ─────────────────────────────────────────────────────────────────────
// CSV streaming + commit
// ─────────────────────────────────────────────────────────────────────

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

const idempotencyKey = (orgId: string, email: string, dob: string): string =>
  sha256(`${orgId}|${email.toLowerCase()}|${dob}`);

const placeholderEmail = (): string =>
  `csv-${uuidv4().replace(/-/g, "").slice(0, 20)}@no-login.local`;

const bufferToStream = (buf: Buffer): Readable => {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
};

/**
 * Soft-warning SOF lookup. Returns:
 *   - { sofCode: "108", warning: null }     — postcode in dataset
 *   - { sofCode: null, warning: <issue> }   — postcode parsed OK but
 *                                              not in dataset; row STILL
 *                                              imports as manual_review.
 *
 * Never throws — a transient Redis hiccup falls through as a warning,
 * not a hard failure. The brief is explicit that postcode lookup is a
 * soft check.
 */
const lookupSofWithWarning = async (
  postcode: string,
  row: number,
): Promise<{ sofCode: string | null; warning: ImportRowIssue | null }> => {
  try {
    const routing = await PostcodeRouter.lookup(postcode);
    if (routing?.sof) return { sofCode: routing.sof, warning: null };
    return {
      sofCode: null,
      warning: mkError(
        row,
        "postcode_prior",
        "postcode not found — manual SOF review required",
      ),
    };
  } catch (err) {
    logger.warn(
      { err, postcode, row },
      "Postcode lookup threw during bulk import — treating as soft warning",
    );
    return {
      sofCode: null,
      warning: mkError(
        row,
        "postcode_prior",
        "postcode lookup failed — manual SOF review required",
      ),
    };
  }
};

/**
 * Materialise one validated row as a User. Wrapped in IdempotencyService
 * so re-uploading the same CSV doesn't create duplicates.
 */
const importOneLearner = async (
  row: ValidatedRow,
  sofCode: string | null,
  orgId: string,
  actorId: string,
): Promise<{ learnerId: string; replayed: boolean; manualReview: boolean }> => {
  const hasEmail = !!row.email;
  const resolvedEmail = hasEmail ? (row.email as string) : placeholderEmail();
  const key = idempotencyKey(orgId, resolvedEmail, row.date_of_birth);

  const outcome = await IdempotencyService.check(
    key,
    "learner-bulk-import",
    async () => {
      if (hasEmail) {
        const existing = await User.findOne({
          email: resolvedEmail.toLowerCase(),
        }).lean();
        if (existing) {
          throw new ApiError(
            409,
            `A learner with email ${resolvedEmail} already exists`,
          );
        }
      }

      const fundingStatus: "fundable" | "manual_review" = sofCode
        ? "fundable"
        : "manual_review";

      const randomPassword = randomBytes(32).toString("hex");
      const hashedPassword = await bcrypt.hash(randomPassword, SALT_ROUNDS);

      const learner = await User.create({
        firstname: row.firstname,
        lastname: row.lastname,
        email: resolvedEmail.toLowerCase(),
        // schema requires phoneNumber; bulk imports never have one
        phoneNumber: `csv-placeholder-${uuidv4().replace(/-/g, "").slice(0, 12)}`,
        password: hashedPassword,
        role: "student",
        status: "active",
        verified: hasEmail ? false : true,
        isActive: true,
        orgId: new Types.ObjectId(orgId),

        dateOfBirth: new Date(row.date_of_birth),
        nationality: row.nationality,
        l1Language: row.l1_language,
        uln: row.uln,
        ulnStatus: row.uln ? "confirmed" : "pending",
        esolLevel: row.esol_level_at_import,
        employment_status: row.employment_status,
        lldd_health_prob: row.lldd_health_prob,

        postcode_prior: row.postcode_prior,
        sof_code: sofCode,
        fundingStatus,
        esol_aim_type: row.aim_type,

        esolOnboardedAt: new Date(row.enrolment_date),
        cohort_status: "new",
      });

      const ilrConfig = ComplianceConfigService.getCurrent("ilr");
      await AuditLog.create({
        timestamp: new Date(),
        actor_type: "org_admin",
        actor_id: new Types.ObjectId(actorId),
        org_id: new Types.ObjectId(orgId),
        learner_id: learner._id,
        action: "learner_bulk_imported",
        before_state: {},
        after_state: {
          org_id: orgId,
          esol_level: row.esol_level_at_import,
          l1_language: row.l1_language,
          funding_status: fundingStatus,
          sof_code: sofCode,
          aim_type: row.aim_type,
          enrolment_date: row.enrolment_date,
        },
        reason: "Bulk import via CSV upload",
        compliance_config_version: ilrConfig?.version ?? null,
      }).catch((err) =>
        logger.error(
          { err, learnerId: learner._id, orgId },
          "AuditLog write failed for learner_bulk_imported",
        ),
      );

      return {
        learnerId: learner._id.toString(),
        manualReview: fundingStatus === "manual_review",
      };
    },
    { org_id: orgId },
  );

  return {
    learnerId: outcome.result.learnerId,
    replayed: outcome.hit,
    manualReview: outcome.result.manualReview,
  };
};

const notifyManualReviewBatch = async (
  orgId: string,
  count: number,
  jobSummary: BulkImportSummary,
) => {
  if (count === 0) return;
  const admins = await User.find({
    orgId,
    role: "org_admin",
    isActive: true,
  })
    .select("_id")
    .lean();

  await Promise.all(
    admins.map((a) =>
      createNotification({
        userId: a._id,
        type: "system",
        title: `${count} bulk-imported learners need funding review`,
        message: `Of ${jobSummary.imported} learners imported, ${count} have postcodes not in the ASF dataset. Set funding routing manually before the next ILR submission.`,
        data: {
          org_id: orgId,
          reason: "postcode_not_in_dataset",
          source: "bulk_import",
          manual_review_count: count,
          imported: jobSummary.imported,
          failed: jobSummary.failed,
        },
      }),
    ),
  );
};

/**
 * Async generator: parse CSV, validate each row, yield a tagged tuple.
 *
 * Row numbering: header line is row 0 internally; first data row is
 * yielded as row 1 — matches the brief's "1-indexed from data row".
 */
async function* streamRows(
  buf: Buffer,
): AsyncGenerator<
  | { row: number; value: ValidatedRow; errors: null }
  | { row: number; value: null; errors: ImportRowIssue[] }
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

  let rowNumber = 0; // header occupies the slot before the first data row
  for await (const raw of parser as AsyncIterable<RawCsvRow>) {
    rowNumber += 1;
    const { value, errors } = validateRow(raw, rowNumber);
    if (value) {
      yield { row: rowNumber, value, errors: null };
    } else {
      yield { row: rowNumber, value: null, errors };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Service entry point
// ─────────────────────────────────────────────────────────────────────

export const importLearnersService = async (
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

  const summary: BulkImportSummary = {
    total: 0,
    imported: 0,
    failed: 0,
    duplicate: 0,
    errors: [],
    warnings: [],
  };

  let manualReviewCount = 0;

  try {
    for await (const out of streamRows(file.buffer)) {
      summary.total += 1;

      // Hard validation errors → row does NOT import.
      if (out.errors) {
        summary.failed += 1;
        summary.errors.push(...out.errors);
        continue;
      }

      // Soft postcode lookup → may produce a warning. Row still imports.
      const { sofCode, warning } = await lookupSofWithWarning(
        out.value.postcode_prior,
        out.row,
      );
      if (warning) summary.warnings.push(warning);

      try {
        const result = await importOneLearner(
          out.value,
          sofCode,
          orgId,
          actorId,
        );
        if (result.replayed) {
          summary.duplicate += 1;
        } else {
          summary.imported += 1;
          if (result.manualReview) manualReviewCount += 1;
        }
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
    logger.error({ err, orgId }, "CSV parse aborted during bulk import");
    throw new ApiError(
      400,
      `CSV parse failed: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }

  await notifyManualReviewBatch(orgId, manualReviewCount, summary).catch(
    (err) =>
      logger.error(
        { err, orgId, manualReviewCount },
        "Manual-review batch notification failed",
      ),
  );

  return new ApiResponse(200, "Bulk import complete", summary);
};
