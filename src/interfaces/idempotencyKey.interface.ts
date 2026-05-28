import { Types, Document } from "mongoose";

export type IdempotencyOperation =
  | "ilr-export"
  | "rarpa-evidence"
  | "mis-push"
  | "delta-sync"
  | "session-write"
  | "placement-scoring"
  | "stage5-review"
  | "invoice-generation";

export type IdempotencyStatus = "processing" | "completed" | "failed";

export interface IIdempotencyKey extends Document {
  _id: Types.ObjectId;
  key: string;
  operation: IdempotencyOperation;
  status: IdempotencyStatus;
  result: unknown;
  error: string | null;
  org_id: Types.ObjectId | null;
  learner_id: Types.ObjectId | null;
  created_at: Date;
}
