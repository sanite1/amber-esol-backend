import { Types } from "mongoose";

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import CalibrationLog from "../models/CalibrationLog";
import User from "../models/User";
import { loadPlacementBank } from "./placement.service";
import { EsolLevel } from "../interfaces/placementQuestion.interface";
import { CalibrationOutcome } from "../interfaces/calibrationLog.interface";
import logger from "../config/logger";

/**
 * Placement calibration helpers (brief Function 6 To-Do 5).
 *
 * Not on the hot path — this is admin-only tooling run by Joey once
 * before launch, then occasionally when the question bank changes.
 *
 * Source of truth for outcome computation lives here, NOT on the
 * dashboard renderer: a future analytics surface that wants the same
 * roll-up calls `summariseCalibration()` rather than recomputing
 * client-side.
 */

const LEVELS_ASC: EsolLevel[] = ["e1", "e2", "e3", "l1", "l2"];

const ACCEPTABLE_BUCKETS: CalibrationOutcome[] = ["correct", "one_below"];
const OVER_ASSIGNMENT_BUCKETS: CalibrationOutcome[] = ["one_above", "over"];

const PASS_THRESHOLD_ACCEPTABLE = 18;
const COHORT_TARGET = 20;

// ─────────────────────────────────────────────────────────────────────
// Outcome computation (pure)
// ─────────────────────────────────────────────────────────────────────

/**
 * Map a (known, assigned) pair to its calibration outcome bucket.
 * Pure function — exported so tests and the dashboard can mirror the
 * exact bucket logic.
 *
 *   known = e2, assigned = e2  → correct
 *   known = e2, assigned = e1  → one_below
 *   known = e2, assigned = e3  → one_above
 *   known = e2, assigned = l1  → over
 *   known = l1, assigned = e1  → under
 */
export const computeOutcome = (
  known: EsolLevel,
  assigned: EsolLevel
): CalibrationOutcome => {
  const knownIdx = LEVELS_ASC.indexOf(known);
  const assignedIdx = LEVELS_ASC.indexOf(assigned);
  const delta = assignedIdx - knownIdx;
  if (delta === 0) return "correct";
  if (delta === -1) return "one_below";
  if (delta === 1) return "one_above";
  if (delta > 1) return "over";
  return "under"; // delta < -1
};

// ─────────────────────────────────────────────────────────────────────
// Log endpoint
// ─────────────────────────────────────────────────────────────────────

interface LogCalibrationBody {
  learner_id: string;
  known_level: EsolLevel;
  assigned_level: EsolLevel;
  practitioner: string;
  notes?: string | null;
}

const validateLevel = (v: unknown, field: string): EsolLevel => {
  if (typeof v !== "string" || !LEVELS_ASC.includes(v as EsolLevel)) {
    throw new ApiError(
      400,
      `${field} must be one of ${LEVELS_ASC.join(", ")}`
    );
  }
  return v as EsolLevel;
};

export const logCalibrationService = async (
  body: LogCalibrationBody,
  loggedBy: string
): Promise<ApiResponse> => {
  if (!body.learner_id || !Types.ObjectId.isValid(body.learner_id)) {
    throw new ApiError(400, "learner_id is required and must be a valid ObjectId");
  }
  if (!body.practitioner?.trim()) {
    throw new ApiError(400, "practitioner is required (the ESOL practitioner's name)");
  }

  const known = validateLevel(body.known_level, "known_level");
  const assigned = validateLevel(body.assigned_level, "assigned_level");

  const learner = await User.findById(body.learner_id).select("_id role");
  if (!learner) {
    throw new ApiError(404, `Learner ${body.learner_id} not found`);
  }
  if (learner.role !== "student") {
    throw new ApiError(
      403,
      `Calibration logs are only valid for learners (student role)`
    );
  }

  const bank = loadPlacementBank();
  const outcome = computeOutcome(known, assigned);

  const row = await CalibrationLog.create({
    learner_id: learner._id,
    known_level: known,
    assigned_level: assigned,
    bank_version: bank.version,
    outcome,
    practitioner: body.practitioner.trim(),
    notes: body.notes?.toString().trim() || null,
    logged_by: new Types.ObjectId(loggedBy),
  });

  logger.info(
    {
      calibrationId: row._id.toString(),
      learnerId: row.learner_id.toString(),
      bankVersion: row.bank_version,
      outcome,
    },
    "Calibration row logged"
  );

  return new ApiResponse(201, "Calibration row logged", {
    id: row._id.toString(),
    learner_id: row.learner_id.toString(),
    known_level: row.known_level,
    assigned_level: row.assigned_level,
    outcome: row.outcome,
    bank_version: row.bank_version,
    created_at: row.created_at,
  });
};

// ─────────────────────────────────────────────────────────────────────
// Delete endpoint (scrub a row recorded in error before sign-off)
// ─────────────────────────────────────────────────────────────────────

export const deleteCalibrationService = async (
  id: string
): Promise<ApiResponse> => {
  if (!Types.ObjectId.isValid(id)) {
    throw new ApiError(400, "id must be a valid ObjectId");
  }
  const deleted = await CalibrationLog.deleteOne({ _id: id });
  if (deleted.deletedCount === 0) {
    throw new ApiError(404, `Calibration row ${id} not found`);
  }
  return new ApiResponse(200, "Calibration row deleted", { id });
};

// ─────────────────────────────────────────────────────────────────────
// Summary endpoint (drives the dashboard)
// ─────────────────────────────────────────────────────────────────────

export interface CalibrationSummary {
  bank_version: number;
  cohort_target: number;
  rows: {
    id: string;
    learner_id: string;
    known_level: EsolLevel;
    assigned_level: EsolLevel;
    outcome: CalibrationOutcome;
    practitioner: string;
    notes: string | null;
    created_at: string;
  }[];
  counts: Record<CalibrationOutcome, number>;
  totals: {
    logged: number;
    acceptable: number;       // correct + one_below
    over_assignments: number; // one_above + over
  };
  pass: boolean;
  pass_reasons: string[];     // empty if pass, populated if fail
}

/**
 * Roll up calibration rows for a given bank version (default: the
 * version currently loaded). The dashboard always shows the current
 * bank; an explicit `?bank_version=N` query lets sign-off review prior
 * runs.
 */
export const summariseCalibrationService = async (
  bankVersion?: number
): Promise<ApiResponse> => {
  const version =
    typeof bankVersion === "number" && bankVersion > 0
      ? bankVersion
      : loadPlacementBank().version;

  const rows = await CalibrationLog.find({ bank_version: version })
    .sort({ created_at: 1 })
    .lean();

  const counts: Record<CalibrationOutcome, number> = {
    correct: 0,
    one_below: 0,
    one_above: 0,
    over: 0,
    under: 0,
  };
  for (const r of rows) counts[r.outcome] += 1;

  const acceptable =
    counts.correct + counts.one_below;
  const overAssignments = counts.one_above + counts.over;

  const passReasons: string[] = [];
  if (rows.length < COHORT_TARGET) {
    passReasons.push(
      `Cohort size ${rows.length} is below the ${COHORT_TARGET}-learner target`
    );
  }
  if (acceptable < PASS_THRESHOLD_ACCEPTABLE) {
    passReasons.push(
      `Only ${acceptable} learners landed in correct/one_below — need ≥ ${PASS_THRESHOLD_ACCEPTABLE}`
    );
  }
  if (overAssignments > 0) {
    passReasons.push(
      `${overAssignments} over-assignment(s) recorded — the protocol requires zero`
    );
  }
  const pass = passReasons.length === 0;

  const summary: CalibrationSummary = {
    bank_version: version,
    cohort_target: COHORT_TARGET,
    rows: rows.map((r) => ({
      id: r._id.toString(),
      learner_id: r.learner_id.toString(),
      known_level: r.known_level,
      assigned_level: r.assigned_level,
      outcome: r.outcome,
      practitioner: r.practitioner,
      notes: r.notes,
      created_at: r.created_at.toISOString(),
    })),
    counts,
    totals: {
      logged: rows.length,
      acceptable,
      over_assignments: overAssignments,
    },
    pass,
    pass_reasons: passReasons,
  };

  return new ApiResponse(
    200,
    pass
      ? "Calibration passes the protocol criteria"
      : "Calibration does not yet meet the protocol criteria",
    summary
  );
};

// Helper used by the buckets reference in the doc + dashboard chip.
export { ACCEPTABLE_BUCKETS, OVER_ASSIGNMENT_BUCKETS };
