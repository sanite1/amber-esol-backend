import { Types, Document } from "mongoose";

export interface IStage5Review extends Document {
  _id: Types.ObjectId;
  learner_id: Types.ObjectId;
  org_id: Types.ObjectId;
  level_completed: string;
  stage3_objectives: unknown[];
  learner_self_assessment: unknown;
  ai_tutor_summary: unknown;
  org_admin_confirmed_at: Date | null;
  /**
   * Function 17 — Amber admin who signed off. Captured at confirm
   * time so the audit trail surfaces who clicked the button without
   * needing to cross-reference the AuditLog row.
   */
  org_admin_confirmed_by: Types.ObjectId | null;
  next_steps: string | null;
  /**
   * Function 17 — optional org-admin override recorded at confirm
   * time. The level change itself already happened (Amber admin
   * confirmed it before the Stage 5 review opened); this field
   * captures the org admin's recorded final call (e.g. "advance to
   * E3" vs the system's "stay at E2"). Informational on the
   * Stage5Review; does NOT auto-create a new LevelChange row.
   */
  org_admin_advance_to_level: string | null;
  /**
   * Final Addendum §9, Todo 22.7 — teacher sign-off on the Stage 5
   * review. The teacher's pedagogical sign-off precedes the
   * org-admin's compliance confirmation; both must happen before the
   * review is fully closed.
   *
   * `teacher_id` carries the tutor who signed off (not the
   * impersonator, if any — impersonation breadcrumb lives on the
   * AuditLog `impersonated_by` field). Null until sign-off.
   */
  teacher_signed_off_at: Date | null;
  teacher_id: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}
