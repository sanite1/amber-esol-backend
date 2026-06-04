import mongoose from "mongoose";
import logger from "./logger";
import { IS_DEMO_MODE } from "./demoMode";

/**
 * Mongo connection.
 *
 * Demo-mode wiring (brief Function 16): when DEMO_MODE=true we read
 * the connection string from DEMO_MONGODB_URI instead of MONGODB_URI
 * so the demo Vercel project lands on an isolated cluster. The
 * production cluster is never touched by a demo deployment.
 *
 * Fail-closed: if DEMO_MODE is set but DEMO_MONGODB_URI is missing,
 * we throw at module load. Falling back to MONGODB_URI from a demo
 * deployment would be a serious correctness failure (demo writes
 * polluting prod).
 */
const PROD_URI = process.env.MONGODB_URI || "";
const DEMO_URI = process.env.DEMO_MONGODB_URI || "";

const MONGODB_URI = IS_DEMO_MODE ? DEMO_URI : PROD_URI;

if (!MONGODB_URI) {
  if (IS_DEMO_MODE) {
    throw new Error(
      "DEMO_MODE=true but DEMO_MONGODB_URI is missing. Refusing to fall " +
        "back to MONGODB_URI — that would let demo writes land in production.",
    );
  }
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

    logger.info(
      { host: conn.connection.host, demo_mode: IS_DEMO_MODE },
      IS_DEMO_MODE
        ? "Database connected (DEMO_MODE — isolated demo cluster)"
        : "Database connected",
    );
  } catch (error) {
    logger.error({ err: error }, "Error connecting to MongoDB");
    process.exit(1); // ✅ kill app if DB fails
  }
};
