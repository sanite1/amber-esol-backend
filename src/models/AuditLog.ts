import { Schema, model } from "mongoose";
import { IAuditLog } from "../interfaces/auditLog.interface";

/**
 * AuditLog — APPEND-ONLY system audit trail.
 *
 * Every compliance-relevant event lands here: session completions, RARPA
 * stage advancements, ILR record generation, MIS pushes (passed and
 * blocked), green-light validator runs, safeguarding alerts, teacher
 * actions, level changes, placement events.
 *
 * Why a separate collection (not just logs):
 *   - Queryable by org and learner for compliance evidence
 *   - Plain-English `reason` field is surfaced verbatim in the org admin
 *     UI's "what happened?" view — required for Ofsted conversations
 *   - `compliance_config_version` captures which rules were live at the
 *     time of the event, so historical audits explain themselves
 *   - `before_state` / `after_state` snapshots let us answer "what
 *     changed?" without joining other collections
 *
 * Immutability is enforced at three layers (matching LevelChange and
 * TeacherReview): query-level hooks block updates and deletes; pre-save
 * blocks re-save of existing docs.
 */

const auditLogSchema = new Schema<IAuditLog>(
  {
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
      index: true,
    },
    actor_type: {
      type: String,
      enum: ["learner", "org_admin", "teacher", "amber_admin", "system"],
      required: true,
    },
    actor_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null, // null for actor_type: "system"
    },
    org_id: {
      type: Schema.Types.ObjectId,
      ref: "Organisation",
      default: null,
      index: true,
    },
    learner_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    action: {
      type: String,
      enum: [
        "session_completed",
        "rarpa_stage_advanced",
        "ilr_record_generated",
        "mis_push_completed",
        "mis_push_held",
        "green_light_passed",
        "safeguarding_alert_raised",
        "teacher_review_logged",
        "teacher_message_sent",
        "pathway_override_set",
        "pathway_override_expired",
        "level_change_confirmed",
        "placement_completed",
        "stage5_review_generated",
        "safeguarding_ai_only_flag",
      ],
      required: true,
    },
    before_state: {
      type: Schema.Types.Mixed,
      default: null,
    },
    after_state: {
      type: Schema.Types.Mixed,
      default: null,
    },
    reason: {
      // Plain English — shown verbatim in the org admin "what happened?"
      // UI. Should be readable by a non-technical quality manager.
      type: String,
      required: true,
      trim: true,
    },
    compliance_config_version: {
      type: Number,
      default: null,
    },
  },
  {
    versionKey: false,
    timestamps: { createdAt: false, updatedAt: false },
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

// Compound indexes for the two dominant query shapes:
//   - "what happened in this org over time?"
//   - "what happened to this learner over time?"
auditLogSchema.index({ org_id: 1, timestamp: -1 });
auditLogSchema.index({ learner_id: 1, timestamp: -1 });

// ── Append-only enforcement ────────────────────────────────────────────
const blockMutation = function (next: (err?: Error) => void) {
  next(
    new Error(
      "AuditLog is append-only — updates and deletes are not permitted. " +
        "If a row is wrong, append a corrective row with `reason` explaining the correction."
    )
  );
};

auditLogSchema.pre(
  ["updateOne", "findOneAndUpdate", "updateMany"] as any,
  blockMutation
);
auditLogSchema.pre(
  ["deleteOne", "findOneAndDelete", "deleteMany"] as any,
  blockMutation
);
auditLogSchema.pre("save", function (next) {
  if (!this.isNew) {
    return next(
      new Error("AuditLog is append-only — re-saving an existing document is not permitted.")
    );
  }
  next();
});

const AuditLog = model<IAuditLog>("AuditLog", auditLogSchema);

export default AuditLog;
