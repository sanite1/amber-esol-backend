import { Schema, model } from "mongoose";
import { IFavouriteTutor } from "../interfaces/myTutors.interface";

const favouriteTutorSchema = new Schema<IFavouriteTutor>(
  {
    studentId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    tutorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
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

// One favourite per student-tutor pair
favouriteTutorSchema.index({ studentId: 1, tutorId: 1 }, { unique: true });

// Fast lookup for listing a student's favourites
favouriteTutorSchema.index({ studentId: 1, createdAt: -1 });

const FavouriteTutor = model<IFavouriteTutor>(
  "FavouriteTutor",
  favouriteTutorSchema,
);

export default FavouriteTutor;
