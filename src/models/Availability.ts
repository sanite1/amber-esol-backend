import { Schema, model } from "mongoose";
import { IAvailability } from "../interfaces/availability.interface";

const TimeBlockSchema = new Schema(
  {
    startTime: {
      type: String,
      required: true,
      match: [
        /^([01]\d|2[0-3]):([0-5]\d)$/,
        "Start time must be in HH:mm format",
      ],
    },
    endTime: {
      type: String,
      required: true,
      match: [
        /^([01]\d|2[0-3]):([0-5]\d)$/,
        "End time must be in HH:mm format",
      ],
    },
  },
  { _id: false },
);

const DayScheduleSchema = new Schema(
  {
    day: {
      type: String,
      required: true,
      enum: [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ],
    },
    enabled: { type: Boolean, default: false },
    blocks: { type: [TimeBlockSchema], default: [] },
  },
  { _id: false },
);

const availabilitySchema = new Schema<IAvailability>(
  {
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    weeklySchedule: {
      type: [DayScheduleSchema],
      default: [
        { day: "monday", enabled: false, blocks: [] },
        { day: "tuesday", enabled: false, blocks: [] },
        { day: "wednesday", enabled: false, blocks: [] },
        { day: "thursday", enabled: false, blocks: [] },
        { day: "friday", enabled: false, blocks: [] },
        { day: "saturday", enabled: false, blocks: [] },
        { day: "sunday", enabled: false, blocks: [] },
      ],
    },
    timezone: { type: String, default: "Europe/London" },
    bufferMinutes: { type: Number, default: 10, min: 0, max: 60 },
    minBookingNotice: { type: Number, default: 4, min: 0 }, // hours
    maxBookingAdvance: { type: Number, default: 30, min: 1 }, // days
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  },
);

const Availability = model<IAvailability>("Availability", availabilitySchema);

export default Availability;
