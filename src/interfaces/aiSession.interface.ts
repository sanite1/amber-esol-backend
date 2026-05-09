import { Types, Document } from "mongoose";

export type AISessionMode = "BRIDGE" | "ANCHOR" | "IMMERSION";

export interface IAISessionTurn {
  turnIndex: number;
  originalInput: string;
  scrubbed: boolean;
  deepSeekResponse: string;
  claudeAssessment?: string;
  safeguardingScore?: number;
  timestamp: Date;
}

export interface IAISession extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  teacherId: Types.ObjectId;
  orgId: Types.ObjectId;
  bookingId?: Types.ObjectId;
  sessionMode: AISessionMode;
  esolLevel: string;
  topic?: string;
  turns: IAISessionTurn[];
  safeguardingFlagged: boolean;
  safeguardingAlertId?: Types.ObjectId;
  assessmentSummary?: string;
  vocabIntroduced?: string[];
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateAISessionRequest {
  learnerId: string;
  teacherId: string;
  orgId: string;
  bookingId?: string;
  sessionMode?: AISessionMode;
  esolLevel: string;
  topic?: string;
}

export interface ISubmitTurnRequest {
  input: string;
}
