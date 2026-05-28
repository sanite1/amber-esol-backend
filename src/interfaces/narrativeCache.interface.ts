import { Types, Document } from "mongoose";

export interface INarrativeCache extends Document {
  _id: Types.ObjectId;
  org_id: Types.ObjectId;
  narrative: string;
  metrics: Record<string, unknown>;
  generated_at: Date;
  expires_at: Date;
}
