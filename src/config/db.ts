import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI || "";

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI in environment variables");
}

let isConnected = false;

export const connectDb = async () => {
  if (isConnected) {
    return; // ✅ prevents reconnection spam
  }

  try {
    mongoose.set("bufferCommands", false); // ✅ DISABLE BUFFERING

    const conn = await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000, // ✅ fail fast
    });

    isConnected = true;

    console.log(`✅ MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("❌ ERROR connecting to MongoDB:", error);
    process.exit(1); // ✅ kill app if DB fails
  }
};
