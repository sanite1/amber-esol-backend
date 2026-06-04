import { Types, Document } from "mongoose";

export type TeacherMessageTrigger =
  | "manual"
  | "priority_queue"
  | "re_engagement_cron";

export interface ITeacherMessage extends Document {
  _id: Types.ObjectId;
  teacher_id: Types.ObjectId;
  learner_id: Types.ObjectId;
  org_id: Types.ObjectId;
  /**
   * The text the learner sees. When translation was requested
   * AND succeeded, this is the L1-translated version; otherwise
   * it's the teacher's original English. The matching `language`
   * field disambiguates which is the case.
   */
  message_text: string;
  /**
   * Final Addendum §11 — preserves the teacher's original input
   * when `message_text` carries an L1 translation. Null when the
   * message was sent untranslated (teacher's text === learner-
   * facing text). Kept for the audit trail so an org admin can
   * later verify "what did the teacher actually write?".
   */
  original_text: string | null;
  /** ISO-ish language code of `message_text` ("en", "ar", "so", …). */
  language: string;
  sent_at: Date;
  read_at: Date | null;
  trigger: TeacherMessageTrigger;
}
