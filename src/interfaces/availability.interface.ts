import { Types, Document } from "mongoose";

/* ── Subdocument interfaces ── */

export type DayOfWeek =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

export interface ITimeBlock {
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
}

export interface IDaySchedule {
  day: DayOfWeek;
  enabled: boolean;
  blocks: ITimeBlock[];
}

/* ── Main Availability document ── */

export interface IAvailability extends Document {
  _id: Types.ObjectId;
  tutorId: Types.ObjectId;
  weeklySchedule: IDaySchedule[];
  timezone: string;
  bufferMinutes: number;
  minBookingNotice: number; // hours
  maxBookingAdvance: number; // days
  createdAt: Date;
  updatedAt: Date;
}

/* ── Date Override document ── */

export type OverrideType = "unavailable" | "extra";

export interface IDateOverride extends Document {
  _id: Types.ObjectId;
  tutorId: Types.ObjectId;
  date: string; // "YYYY-MM-DD"
  type: OverrideType;
  reason?: string;
  blocks?: ITimeBlock[]; // only for "extra" type
  createdAt: Date;
  updatedAt: Date;
}

/* ── Request body interfaces ── */

export interface ISetScheduleRequest {
  weeklySchedule: IDaySchedule[];
  timezone?: string;
}

export interface IUpdateSettingsRequest {
  timezone?: string;
  bufferMinutes?: number;
  minBookingNotice?: number;
  maxBookingAdvance?: number;
}

export interface ICreateOverrideRequest {
  date: string;
  type: OverrideType;
  reason?: string;
  blocks?: ITimeBlock[];
}

/* ── Query interfaces ── */

export interface IAvailableSlotsQuery {
  date: string; // "YYYY-MM-DD"
  duration?: string; // lesson duration in minutes, default "60"
}
