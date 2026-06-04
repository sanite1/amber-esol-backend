import { Types, Document } from "mongoose";

export type AuditActorType =
  | "learner"
  | "org_admin"
  | "teacher"
  | "amber_admin"
  | "system";

export type AuditAction =
  | "learner_registered"
  | "learner_bulk_imported"
  | "forskills_imported"
  | "historical_session_imported"
  | "eligibility_declared"
  | "uln_recorded"
  | "session_started"
  | "session_completed"
  | "rarpa_stage_advanced"
  | "ilr_record_generated"
  | "mis_push_completed"
  | "mis_push_held"
  | "green_light_passed"
  | "safeguarding_alert_raised"
  | "teacher_review_logged"
  | "teacher_message_sent"
  | "pathway_override_set"
  | "pathway_override_expired"
  | "level_change_confirmed"
  | "placement_completed"
  | "stage5_review_generated"
  // Function 17 — Stage 5 review opened on level-change confirmation
  | "stage5_review_initiated"
  // Function 17 — learner submitted their Stage 5 self-assessment form
  | "stage5_self_assessment_submitted"
  // Function 17 — org admin signed off the Stage 5 review
  | "stage5_review_confirmed"
  // Final Addendum §9, Todo 22.7 — teacher pedagogical sign-off on
  // the Stage 5 review. Precedes (and is required for) the org-
  // admin compliance confirmation above.
  | "rarpa_stage5_teacher_signed_off"
  // Final Addendum §10, Todo 23.3 — per-learner priority shift
  // detected during the daily recalc (only written when level
  // actually changes from previous, not on no-op re-runs).
  | "learner_priority_changed"
  // Final Addendum §10, Todo 23.3 — per-org summary row written
  // once at the end of every priority recalc job.
  | "priority_queue_recalculated"
  // Final Addendum §10, Todo 23.6 — daily cron dispatcher row,
  // one per cron firing. Carries the fan-out summary (eligible
  // org count, jobs enqueued, skipped reasons) so an auditor
  // can answer "did the daily recalc fire on date X, and how
  // many orgs did it cover?" without joining BullMQ history.
  | "priority_queue_cron_dispatched"
  // Final Addendum §11 — daily re-engagement cron summary row.
  // One per cron firing; carries dormant-cohort size, messages
  // sent, skipped reasons. Per-message rows reuse the existing
  // `teacher_message_sent` action with actor_type "system" + a
  // populated `acting_as_teacher_id` so the audit-log UI can
  // render "system, on behalf of Sarah" without inventing a
  // second event class.
  | "re_engagement_cron_dispatched"
  // Final Addendum §11 — learner explicitly acknowledged a
  // TeacherMessage. Single-shot — only written the first time
  // `read_at` flips from null; subsequent PATCH /read calls are
  // idempotent no-ops with no second audit row.
  | "teacher_message_read"
  // Final Addendum §7 — daily MIS delta-sync outcomes
  | "mis_delta_discrepancy"
  | "mis_delta_unknown_learner"
  | "safeguarding_ai_only_flag"
  // Function 11 — daily progression cron outcomes
  | "progression_ready_flagged"
  | "cohort_status_changed"
  // Function 11 To-Do 2 — Amber admin acts on a ready learner
  | "level_change_rejected"
  // Function 12 To-Do 4 — org admin nudge sent to a learner
  | "learner_nudge_sent"
  // Final Addendum §4 — teacher assignment management
  | "teacher_added_to_org"
  | "teacher_removed_from_org"
  | "learner_teacher_assigned"
  // Function 13 To-Do 4 — ILR export pipeline completion
  | "ilr_export_completed"
  // Function 14 To-Do 4 — consolidated RARPA evidence-report PDF generated
  | "evidence_report_generated"
  // Function 14 To-Do 5 — Amber admin cleared the evidence-report cache
  | "evidence_report_cache_cleared"
  // Function 15 — Amber admin impersonation events
  | "user_impersonation_started"
  | "user_impersonation_ended"
  // Final Addendum §3 — ComplianceConfig versions landed by an admin
  | "compliance_config_activated"
  // Final Addendum §7 — Amber admin updated an org's MIS connection
  | "mis_settings_updated"
  | "mis_test_connection_attempted"
  // Final Addendum §1 — failed-job review dashboard actions
  | "failed_job_retried"
  | "failed_job_dismissed";

export interface IAuditLog extends Document {
  _id: Types.ObjectId;
  timestamp: Date;
  actor_type: AuditActorType;
  actor_id: Types.ObjectId | null;
  org_id: Types.ObjectId | null;
  learner_id: Types.ObjectId | null;
  action: AuditAction;
  before_state: unknown;
  after_state: unknown;
  reason: string;
  compliance_config_version: number | null;
  /**
   * Function 15 — set on every audit row written under an admin
   * impersonation session. Carries the original Amber-admin's user id
   * even though `actor_id` reflects the impersonated user. Null on
   * normal (non-impersonated) actions.
   */
  impersonated_by: Types.ObjectId | null;
  /**
   * Final Addendum §11 — populated on system-driven actions that
   * masquerade as a teacher (e.g. the daily re-engagement cron
   * auto-sends messages on a teacher's behalf). `actor_type` stays
   * "system" so the audit-log UI's existing rules don't
   * mis-attribute the action to the teacher; this field carries
   * the teacher's user id so a row reads "system, acting as
   * Sarah Chen". Null on all non-acting-as-teacher rows.
   */
  acting_as_teacher_id: Types.ObjectId | null;
}
