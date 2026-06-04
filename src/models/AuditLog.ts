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
      // Keep in sync with AuditAction in interfaces/auditLog.interface.ts.
      // The interface is the source of truth — the enum mirrors it so
      // schema-level validation rejects typos.
      enum: [
        "learner_registered",
        "learner_bulk_imported",
        "forskills_imported",
        "historical_session_imported",
        "eligibility_declared",
        "uln_recorded",
        "session_started",
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
        // Function 17 — Stage 5 review opened on level-change confirmation
        "stage5_review_initiated",
        // Function 17 — learner submitted their Stage 5 self-assessment
        "stage5_self_assessment_submitted",
        // Function 17 — org admin signed off the Stage 5 review
        "stage5_review_confirmed",
        // Final Addendum §9, Todo 22.7 — teacher Stage 5 sign-off
        "rarpa_stage5_teacher_signed_off",
        // Final Addendum §10, Todo 23.3 — priority recalc audit rows
        "learner_priority_changed",
        "priority_queue_recalculated",
        // Final Addendum §10, Todo 23.6 — daily cron dispatcher row
        "priority_queue_cron_dispatched",
        // Final Addendum §11 — re-engagement cron summary row
        "re_engagement_cron_dispatched",
        // Final Addendum §11 — learner acknowledged a tutor message
        "teacher_message_read",
        // Final Addendum §7 — daily MIS delta-sync outcomes
        "mis_delta_discrepancy",
        "mis_delta_unknown_learner",
        "safeguarding_ai_only_flag",
        // Function 11 — daily progression cron outcomes
        "progression_ready_flagged",
        "cohort_status_changed",
        "level_change_rejected",
        "learner_nudge_sent",
        // Final Addendum §4 — teacher assignment management
        "teacher_added_to_org",
        "teacher_removed_from_org",
        "learner_teacher_assigned",
        // Function 13 To-Do 4 — ILR export pipeline completion
        "ilr_export_completed",
        // Function 14 — evidence-report PDF lifecycle
        "evidence_report_generated",
        "evidence_report_cache_cleared",
        // Function 15 — Amber-admin impersonation
        "user_impersonation_started",
        "user_impersonation_ended",
        // Final Addendum §3 — ComplianceConfig versions
        "compliance_config_activated",
        // Final Addendum §7 — MIS settings management
        "mis_settings_updated",
        "mis_test_connection_attempted",
        // Final Addendum §1 — failed-job review actions
        "failed_job_retried",
        "failed_job_dismissed",
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
    /**
     * Function 15 — populated on every audit row written while an admin
     * impersonation session is active. `actor_id` reflects the
     * impersonated user (so org-scoped audit views read naturally);
     * `impersonated_by` carries the original Amber admin's user id so
     * the trail of "who actually clicked this button" is preserved.
     *
     * Null on normal (non-impersonated) actions.
     */
    impersonated_by: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    /**
     * Final Addendum §11 — populated on system-driven actions
     * masquerading as a teacher (re-engagement cron). `actor_type`
     * stays "system"; this field attributes the action to the
     * teacher whose templated voice the message carries. Null on
     * all non-acting-as-teacher rows.
     */
    acting_as_teacher_id: {
      type: Schema.Types.ObjectId,
      ref: "User",
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
