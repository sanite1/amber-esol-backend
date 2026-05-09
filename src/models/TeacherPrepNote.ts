import { Schema, model } from "mongoose";
import { ITeacherPrepNote } from "../interfaces/teacherPrepNote.interface";

const teacherPrepNoteSchema = new Schema<ITeacherPrepNote>(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    learnerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orgId: { type: Schema.Types.ObjectId, ref: "Organisation", required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "Booking", required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: "AISession", default: null },
    content: { type: String, required: true },
    viewedAt: { type: Date, default: null },
    viewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    generatedAt: { type: Date, required: true, default: Date.now },
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

teacherPrepNoteSchema.index({ bookingId: 1 });
teacherPrepNoteSchema.index({ teacherId: 1, createdAt: -1 });
teacherPrepNoteSchema.index({ orgId: 1 });

const TeacherPrepNote = model<ITeacherPrepNote>(
  "TeacherPrepNote",
  teacherPrepNoteSchema
);

export default TeacherPrepNote;
