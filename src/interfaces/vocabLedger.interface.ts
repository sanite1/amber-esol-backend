import { Types, Document } from "mongoose";

export interface IVocabLedger extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  orgId?: Types.ObjectId | null;
  sessionId?: Types.ObjectId | null;
  word: string;
  definition?: string;
  contextSentence?: string;
  esolLevel?: string | null;
  topic?: string;
  introducedAt: Date;
  revisedAt?: Date;
  masteryScore?: number;

  // ── Brief Function 9 To-Do 1 fields ────────────────────────────
  times_encountered?: number;
  retained?: boolean;
  scenario_first_seen?: string | null;
  stage3_objective_id?: string | null;
  last_seen_at?: Date | null;
  definition_en?: string | null;

  createdAt: Date;
  updatedAt: Date;
}
