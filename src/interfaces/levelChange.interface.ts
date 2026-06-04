import { Types, Document } from "mongoose";

export type LevelChangeTriggerEvent =
  | "progression_criteria_met"
  | "teacher_override"
  | "manual_admin";

export interface ILevelChange extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  orgId: Types.ObjectId;
  fromLevel: string;
  toLevel: string;
  changedBy: Types.ObjectId;
  reason: string;
  evidenceSummary?: string;
  sessionId?: Types.ObjectId;
  effectiveDate: Date;
  triggerEvent?: LevelChangeTriggerEvent | null;
  createdAt: Date;
}

export interface ICreateLevelChangeRequest {
  learnerId: string;
  fromLevel: string;
  toLevel: string;
  reason: string;
  evidenceSummary?: string;
  sessionId?: string;
  effectiveDate?: string;
}
