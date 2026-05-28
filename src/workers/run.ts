/**
 * Entry point for `npm run workers`.
 *
 * Runs all BullMQ workers as a standalone Node process — the production
 * deployment shape. The HTTP server in src/index.ts does not need to be
 * running for workers to function, only the shared infra they depend on
 * (Mongo, Redis, Gemini).
 *
 * Workers share singletons with the HTTP server via process-level imports
 * inside this same process; they do NOT share runtime state with other
 * worker processes (e.g. a horizontally scaled deployment).
 */

import "dotenv/config";
import { connectDb } from "../config/db";
import { initRedis } from "../lib/redis";
import { initGeminiClient } from "../lib/gemini";
import { startWorkers, stopWorkers } from "./index";
import ComplianceConfigService from "../services/ComplianceConfigService";
import SafeguardingDetector from "../services/safeguardingDetector.service";
import logger from "../config/logger";

(async () => {
  try {
    await connectDb();
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, "Worker process: DB init failed");
    process.exit(1);
  }

  // Workers need compliance rules too — ILR export and RARPA evidence
  // processors both read from the same cache as the HTTP server.
  try {
    await ComplianceConfigService.loadAll();
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, "Worker process: ComplianceConfig load failed");
    process.exit(1);
  }

  try {
    await initRedis();
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, "Worker process: Redis init failed");
    process.exit(1);
  }

  try {
    initGeminiClient();
  } catch (err) {
    logger.fatal({ err: (err as Error).message }, "Worker process: Vertex AI init failed");
    process.exit(1);
  }

  // Workers don't need to enqueue postcode/FALA startup loads (the HTTP
  // server does that). They DO need the safeguarding detector cache for
  // the eventual esol-session processor.
  try {
    await SafeguardingDetector.loadAll();
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      "Worker process: SafeguardingDetector load failed (continuing)"
    );
  }

  const workers = startWorkers();

  // Graceful shutdown so in-flight jobs aren't dropped on deploy.
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Worker process shutting down");
    try {
      await stopWorkers(workers);
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Error during worker shutdown");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  logger.info("Worker process ready");
})();
