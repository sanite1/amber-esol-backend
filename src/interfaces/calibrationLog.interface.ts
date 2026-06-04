import { Types, Document } from "mongoose";
import { EsolLevel } from "./placementQuestion.interface";

/**
 * Per-learner outcome bucket for a calibration run.
 *
 *   correct    — assigned exactly matches known
 *   one_below  — assigned is one NQF rung below known (acceptable)
 *   one_above  — assigned is one rung above (over-assignment, fail signal)
 *   over       — assigned is two+ rungs above (worst case)
 *   under      — assigned is two+ rungs below (recoverable but flagged)
 *
 * Computed once at log time from the (known, assigned) pair and frozen.
 * Re-derivation across schema changes is not supported — append-only.
 */
export type CalibrationOutcome =
  | "correct"
  | "one_below"
  | "one_above"
  | "over"
  | "under";

export interface ICalibrationLog extends Document {
  _id: Types.ObjectId;
  learner_id: Types.ObjectId;
  known_level: EsolLevel;
  assigned_level: EsolLevel;
  bank_version: number;
  outcome: CalibrationOutcome;
  practitioner: string;
  notes: string | null;
  logged_by: Types.ObjectId;
  created_at: Date;
}
