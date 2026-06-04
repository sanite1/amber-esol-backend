import { Schema, model } from "mongoose";
import { ICalibrationLog } from "../interfaces/calibrationLog.interface";

/**
 * CalibrationLog — one row per calibration-cohort learner per run.
 *
 * Append-only at the protocol level: the only way to remove a row is
 * the admin DELETE endpoint (hard-delete, never an update). The
 * recovery flow if a row was logged in error is delete + re-create,
 * not edit-in-place — preserves the audit story for the sign-off PDF.
 */

const calibrationLogSchema = new Schema<ICalibrationLog>(
  {
    learner_id: { type: Schema.Types.ObjectId, ref: "User", required: true },
    known_level: {
      type: String,
      enum: ["e1", "e2", "e3", "l1", "l2"],
      required: true,
    },
    assigned_level: {
      type: String,
      enum: ["e1", "e2", "e3", "l1", "l2"],
      required: true,
    },
    bank_version: { type: Number, required: true },
    outcome: {
      type: String,
      enum: ["correct", "one_below", "one_above", "over", "under"],
      required: true,
    },
    practitioner: { type: String, required: true, trim: true },
    notes: { type: String, default: null },
    logged_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
    created_at: { type: Date, required: true, default: Date.now },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: false },
  }
);

// "Show me the latest calibration run" — query by bank_version + time.
calibrationLogSchema.index({ bank_version: -1, created_at: -1 });

// Append-only: block edits at the schema layer. Delete-by-id is allowed
// (the admin endpoint scrubs erroneous rows) but `updateOne` / `save` on
// an existing doc is not. Mirrors the AuditLog approach.
const blockMutation = function (next: (err?: Error) => void) {
  next(
    new Error(
      "CalibrationLog is append-only — updates are not permitted. " +
        "If a row is wrong, DELETE it and append a corrected one."
    )
  );
};
calibrationLogSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany"] as any,
  blockMutation
);
calibrationLogSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(
      new Error(
        "CalibrationLog is append-only — re-saving an existing document is not permitted."
      )
    );
  }
  next();
});

const CalibrationLog = model<ICalibrationLog>(
  "CalibrationLog",
  calibrationLogSchema
);

export default CalibrationLog;
