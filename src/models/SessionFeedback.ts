import { Schema, model } from "mongoose";
import { ISessionFeedback } from "../interfaces/sessionFeedback.interface";

const sessionFeedbackSchema = new Schema<ISessionFeedback>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: "AISession", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    teacherId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    learnerRating: { type: Number, min: 1, max: 5 },
    emojiRating: {
      type: String,
      enum: ["struggling", "okay", "confident", null],
      default: null,
    },
    learnerComment: { type: String },
    teacherRating: { type: Number, min: 1, max: 5 },
    teacherComment: { type: String },
    topicsWorkedOn: { type: [String], default: [] },
    progressNotes: { type: String },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.__v;
      },
    },
  }
);

sessionFeedbackSchema.index({ sessionId: 1 });
sessionFeedbackSchema.index({ learnerId: 1, createdAt: -1 });
sessionFeedbackSchema.index({ orgId: 1 });

const SessionFeedback = model<ISessionFeedback>(
  "SessionFeedback",
  sessionFeedbackSchema
);

export default SessionFeedback;
