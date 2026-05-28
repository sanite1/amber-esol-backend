import { Types, Document } from "mongoose";

export type AuditActorType =
  | "learner"
  | "org_admin"
  | "teacher"
  | "amber_admin"
  | "system";

export type AuditAction =
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
  | "safeguarding_ai_only_flag";

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
}
