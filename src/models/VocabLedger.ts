import { Schema, model } from "mongoose";
import { IVocabLedger } from "../interfaces/vocabLedger.interface";

const vocabLedgerSchema = new Schema<IVocabLedger>(
  {
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "AISession", required: true },
    word: { type: String, required: true, trim: true },
    definition: { type: String },
    contextSentence: { type: String },
    esolLevel: { type: String, required: true },
    topic: { type: String },
    introducedAt: { type: Date, required: true, default: Date.now },
    revisedAt: { type: Date },
    masteryScore: { type: Number, min: 0, max: 1 },
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

vocabLedgerSchema.index({ learnerId: 1, esolLevel: 1 });
vocabLedgerSchema.index({ learnerId: 1, word: 1 });
vocabLedgerSchema.index({ orgId: 1 });

const VocabLedger = model<IVocabLedger>("VocabLedger", vocabLedgerSchema);

export default VocabLedger;
