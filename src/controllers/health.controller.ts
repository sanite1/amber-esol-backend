import { Request, Response, NextFunction } from "express";
import { pingGemini } from "../lib/gemini";
import { pingRedis } from "../lib/redis";
import ApiResponse from "../errors/apiResponse";
import ApiError from "../errors/apiError";
import logger from "../config/logger";

/**
 * GET /api/health/gemini — admin-only Vertex AI reachability probe.
 *
 * Issues a 1-token generation call against gemini-2.5-flash via the
 * singleton client and reports round-trip latency. Returns 503 on failure
 * so external uptime monitors can distinguish "auth/network down" from
 * "server up but Gemini misconfigured".
 */
export const checkGeminiHealth = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { latencyMs } = await pingGemini();
    return res
      .status(200)
      .json(new ApiResponse(200, "Gemini OK", { ok: true, latency_ms: latencyMs }));
  } catch (err) {
    logger.error({ err }, "Gemini health probe failed");
    return next(
      new ApiError(
        503,
        `Gemini health probe failed: ${(err as Error).message}`
      )
    );
  }
};

/**
 * GET /api/health/redis — admin-only Redis reachability probe.
 *
 * Issues a PING against the singleton ioredis connection and reports
 * round-trip latency. Returns 503 on failure so monitors can distinguish
 * "server up but Redis unreachable" from a process crash.
 */
export const checkRedisHealth = async (
  _req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const { latencyMs } = await pingRedis();
    return res
      .status(200)
      .json(
        new ApiResponse(200, "Redis OK", {
          connected: true,
          latency_ms: latencyMs,
        })
      );
  } catch (err) {
    logger.error({ err }, "Redis health probe failed");
    return next(
      new ApiError(
        503,
        `Redis health probe failed: ${(err as Error).message}`
      )
    );
  }
};
