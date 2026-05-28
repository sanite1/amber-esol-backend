import { Types, Document } from "mongoose";

export interface IReferralToken extends Document {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  token: string;
  email?: string;
  esolLevel?: string;
  usedBy?: Types.ObjectId | null;
  usedAt?: Date | null;
  expiresAt: Date;
  isActive: boolean;
  // Brief Function 1 fields
  created_by?: Types.ObjectId | null;
  usage_count?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateReferralTokenRequest {
  orgId: string;
  email?: string;
  esolLevel?: string;
  expiresInDays?: number;
}

export interface IUseReferralTokenRequest {
  token: string;
  firstname: string;
  lastname: string;
  email: string;
  phoneNumber: string;
  password: string;
  l1Language?: string;
  uln?: string;
}
