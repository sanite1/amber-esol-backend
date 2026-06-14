import { HydratedDocument } from "mongoose";
import User from "../models/User";
import { IUser } from "../interfaces/user.interface";

/**
 * Shared learner-reconciliation logic for CSV importers.
 *
 * Used by Function 4 (ForSkills CSV) and Function 5 (historical
 * sessions CSV). Same rules either way:
 *
 *   1. If `learner_ref` is exactly 10 digits → match by ULN, org-scoped
 *   2. Else if firstname + lastname + date_of_birth all present →
 *      match on those three fields, org-scoped
 *   3. Else → return structured error rows naming the missing fields
 *
 * Returning a structured `errors` array (rather than throwing) lets
 * the caller fold them into its per-row error report alongside other
 * validation issues. The caller decides how to surface them.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ULN_RE = /^\d{10}$/;

const isBlank = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export interface LearnerMatchInput {
  learner_ref?: string;
  firstname?: string;
  lastname?: string;
  date_of_birth?: string;
}

export interface LearnerMatchIssue {
  field: string;
  message: string;
}

export interface LearnerMatchPlan {
  matchByUln: string | null;
  matchByIdentity: {
    firstname: string;
    lastname: string;
    date_of_birth: string;
  } | null;
  errors: LearnerMatchIssue[];
}

/**
 * Decide which reconciliation strategy applies to a given row's
 * identity fields. Pure — no DB I/O. Run inside the row validator so
 * a missing `learner_ref` lands in the importer's `errors[]` channel.
 */
export const resolveLearnerMatch = (
  raw: LearnerMatchInput,
): LearnerMatchPlan => {
  if (isBlank(raw.learner_ref)) {
    return {
      matchByUln: null,
      matchByIdentity: null,
      errors: [{ field: "learner_ref", message: "learner_ref is required" }],
    };
  }
  const ref = String(raw.learner_ref).trim();

  // Strategy 1 — ULN.
  if (ULN_RE.test(ref)) {
    return { matchByUln: ref, matchByIdentity: null, errors: [] };
  }

  // Strategy 2 — identity fallback (firstname + lastname + DOB).
  const missing: LearnerMatchIssue[] = [];
  if (isBlank(raw.firstname))
    missing.push({
      field: "firstname",
      message: "firstname is required when learner_ref is not a 10-digit ULN",
    });
  if (isBlank(raw.lastname))
    missing.push({
      field: "lastname",
      message: "lastname is required when learner_ref is not a 10-digit ULN",
    });
  if (
    isBlank(raw.date_of_birth) ||
    !ISO_DATE_RE.test(String(raw.date_of_birth))
  ) {
    missing.push({
      field: "date_of_birth",
      message:
        "date_of_birth (YYYY-MM-DD) is required when learner_ref is not a 10-digit ULN",
    });
  }
  if (missing.length > 0) {
    return { matchByUln: null, matchByIdentity: null, errors: missing };
  }

  return {
    matchByUln: null,
    matchByIdentity: {
      firstname: (raw.firstname as string).trim(),
      lastname: (raw.lastname as string).trim(),
      date_of_birth: (raw.date_of_birth as string).trim(),
    },
    errors: [],
  };
};

/**
 * Execute the matched plan against the User collection, scoped to
 * `orgId`. Returns null when no User matches — the caller turns this
 * into an error row.
 *
 * Identity match uses day-precision range on dateOfBirth to dodge
 * timezone-related off-by-one issues that `$eq` would produce.
 */
export const findLearnerInOrg = async (
  plan: LearnerMatchPlan,
  orgId: string,
): Promise<HydratedDocument<IUser> | null> => {
  if (plan.matchByUln) {
    return User.findOne({
      uln: plan.matchByUln,
      orgId,
      role: "student",
    });
  }
  if (plan.matchByIdentity) {
    const dob = new Date(plan.matchByIdentity.date_of_birth);
    const next = new Date(dob);
    next.setDate(next.getDate() + 1);
    return User.findOne({
      firstname: plan.matchByIdentity.firstname,
      lastname: plan.matchByIdentity.lastname,
      dateOfBirth: { $gte: dob, $lt: next },
      orgId,
      role: "student",
    });
  }
  return null;
};
