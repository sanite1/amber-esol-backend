import { Schema, model } from "mongoose";
import { IDateOverride } from "../interfaces/availability.interface";

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

const dateOverrideSchema = new Schema<IDateOverride>(
  {
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: String,
      required: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"],
    },
    type: {
      type: String,
      enum: ["unavailable", "extra"],
      required: true,
    },
    reason: { type: String, trim: true },
    blocks: { type: [TimeBlockSchema], default: undefined },
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

// Compound index: one override per tutor per date
dateOverrideSchema.index({ tutorId: 1, date: 1 }, { unique: true });

const DateOverride = model<IDateOverride>("DateOverride", dateOverrideSchema);

export default DateOverride;
