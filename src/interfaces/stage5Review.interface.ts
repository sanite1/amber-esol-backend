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
  next_steps: string | null;
  createdAt: Date;
  updatedAt: Date;
}
