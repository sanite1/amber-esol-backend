import { Types, Document } from "mongoose";

export interface IIlrExportWarnings extends Document {
  _id: Types.ObjectId;
  export_id: string;
  org_id: Types.ObjectId;
  warnings: unknown[];
  created_at: Date;
}
