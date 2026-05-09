import { Types, Document } from "mongoose";

export interface IVocabLedger extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  orgId: Types.ObjectId;
  sessionId: Types.ObjectId;
  word: string;
  definition?: string;
  contextSentence?: string;
  esolLevel: string;
  topic?: string;
  introducedAt: Date;
  revisedAt?: Date;
  masteryScore?: number;
  createdAt: Date;
  updatedAt: Date;
}
