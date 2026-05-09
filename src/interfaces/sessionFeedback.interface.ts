import { Types, Document } from "mongoose";

export interface ISessionFeedback extends Document {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  bookingId?: Types.ObjectId;
  learnerId: Types.ObjectId;
  teacherId?: Types.ObjectId;
  orgId: Types.ObjectId;
  learnerRating?: number;
  learnerComment?: string;
  teacherRating?: number;
  teacherComment?: string;
  topicsWorkedOn?: string[];
  progressNotes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISubmitLearnerFeedbackRequest {
  rating: number;
  comment?: string;
  topicsWorkedOn?: string[];
}

export interface ISubmitTeacherFeedbackRequest {
  rating?: number;
  comment?: string;
  progressNotes?: string;
  topicsWorkedOn?: string[];
}
