import { Schema, model } from "mongoose";
import { IAISession } from "../interfaces/aiSession.interface";

const turnSchema = new Schema(
  {
    turnIndex: { type: Number, required: true },
    originalInput: { type: String, required: true },
    scrubbed: { type: Boolean, default: false },
    deepSeekResponse: { type: String, required: true },
    claudeAssessment: { type: String },
    safeguardingScore: { type: Number, min: 0, max: 1 },
    timestamp: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const aiSessionSchema = new Schema<IAISession>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", default: null },
    sessionMode: {
      type: String,
      enum: ["BRIDGE", "ANCHOR", "IMMERSION"],
      default: "BRIDGE",
    },
    esolLevel: { type: String, required: true },
    topic: { type: String },
    turns: { type: [turnSchema], default: [] },
    safeguardingFlagged: { type: Boolean, default: false },
    safeguardingAlertId: {
      type: Schema.Types.ObjectId,
      ref: "SafeguardingAlert",
      default: null,
    },
    assessmentSummary: { type: String },
    vocabIntroduced: { type: [String], default: [] },
    completedAt: { type: Date, default: null },
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

aiSessionSchema.index({ learnerId: 1, createdAt: -1 });
aiSessionSchema.index({ orgId: 1, createdAt: -1 });
aiSessionSchema.index({ bookingId: 1 });

const AISession = model<IAISession>("AISession", aiSessionSchema);

export default AISession;
