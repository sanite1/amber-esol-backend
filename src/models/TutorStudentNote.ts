import { Schema, model } from "mongoose";

export interface ITutorStudentNote {
  tutorId: Schema.Types.ObjectId;
  studentId: Schema.Types.ObjectId;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

const tutorStudentNoteSchema = new Schema<ITutorStudentNote>(
  {
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    notes: {
      type: String,
      default: "",
      maxlength: 1000,
    },
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

// One note per tutor–student pair
tutorStudentNoteSchema.index({ tutorId: 1, studentId: 1 }, { unique: true });

const TutorStudentNote = model<ITutorStudentNote>(
  "TutorStudentNote",
  tutorStudentNoteSchema
);

export default TutorStudentNote;
