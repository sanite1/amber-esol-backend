import { Types, Document } from "mongoose";

export type TeacherReviewType =
  | "async_review"
  | "contact_session"
  | "pathway_adjustment"
  | "rarpa_signoff";

export interface ITeacherReview extends Document {
  _id: Types.ObjectId;
  learner_id: Types.ObjectId;
  teacher_id: Types.ObjectId;
  org_id: Types.ObjectId;
  review_type: TeacherReviewType;
  duration_mins: number;
  notes: string;
  ai_recommendation_acted_on: boolean;
  created_at: Date;
}
