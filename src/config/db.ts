import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "";
export const connectDb = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");
  } catch (error) {
    if (error instanceof Error) {
      console.log("ERROR connecting to db", error.message);
    }
  }
};
