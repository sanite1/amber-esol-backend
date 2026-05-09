import { Types, Document } from "mongoose";

export interface ISessionToken extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  sessionId: Types.ObjectId;
  bookingId?: Types.ObjectId | null;
  orgId: Types.ObjectId;
  token: string;
  usedAt?: Date;
  expiresAt: Date;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateSessionTokenRequest {
  learnerId: string;
  bookingId: string;
  orgId: string;
}
