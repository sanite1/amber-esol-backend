import { Types, Document } from "mongoose";

export interface ITeacherPrepNote extends Document {
  _id: Types.ObjectId;
  teacherId: Types.ObjectId;
  learnerId: Types.ObjectId;
  orgId: Types.ObjectId;
  bookingId: Types.ObjectId;
  sessionId?: Types.ObjectId;
  content: string;
  viewedAt?: Date;
  viewedBy?: Types.ObjectId;
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
