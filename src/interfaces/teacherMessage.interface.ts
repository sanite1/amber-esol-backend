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
  message_text: string;
  language: string;
  sent_at: Date;
  read_at: Date | null;
  trigger: TeacherMessageTrigger;
}
