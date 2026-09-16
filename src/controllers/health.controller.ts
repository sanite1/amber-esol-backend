import { Request, Response, NextFunction } from "express";
import { readFileSync } from "fs";

import { pingGemini, MODEL_NAME } from "../lib/gemini";
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
  next: NextFunction,
) => {
  try {
    const { latencyMs } = await pingGemini();
    return res
      .status(200)
      .json(
        new ApiResponse(200, "Gemini OK", { ok: true, latency_ms: latencyMs }),
      );
  } catch (err) {
    logger.error({ err }, "Gemini health probe failed");
    // Credential DIAGNOSIS, not credential contents. A hosted deploy
    // authenticates via a service-account key file; when that is missing
    // the SDK's error ("Unable to authenticate your request") does not
    // say whether the env var is unset, points nowhere, or holds bad
    // JSON. Report exactly that, so the fix is obvious without shell
    // access to the box. Never logs or returns the key material.
    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null;
    let credentials: Record<string, unknown>;
    if (!credPath) {
      credentials = {
        env_var_set: false,
        hint: "GOOGLE_APPLICATION_CREDENTIALS is not set — hosted deploys need a service-account key file (local dev can use `gcloud auth application-default login` instead).",
      };
    } else {
      let fileExists = false;
      let parsableJson = false;
      let clientEmail: string | null = null;
      let keyProjectId: string | null = null;
      try {
        const raw = readFileSync(credPath, "utf8");
        fileExists = true;
        const parsed = JSON.parse(raw) as {
          client_email?: string;
          project_id?: string;
        };
        parsableJson = true;
        clientEmail = parsed.client_email ?? null;
        keyProjectId = parsed.project_id ?? null;
      } catch {
        // fileExists/parsableJson already carry the outcome.
      }
      credentials = {
        env_var_set: true,
        path: credPath,
        file_exists: fileExists,
        parsable_json: parsableJson,
        client_email: clientEmail,
        key_project_id: keyProjectId,
        configured_project_id:
          process.env.GOOGLE_CLOUD_PROJECT_ID ??
          process.env.GCP_PROJECT_ID ??
          null,
      };
    }
    return res.status(503).json({
      error: "ApiError",
      status: 503,
      message: `Gemini health probe failed: ${(err as Error).message}`,
      model: MODEL_NAME,
      credentials,
    });
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
  next: NextFunction,
) => {
  try {
    const { latencyMs } = await pingRedis();
    return res.status(200).json(
      new ApiResponse(200, "Redis OK", {
        connected: true,
        latency_ms: latencyMs,
      }),
    );
  } catch (err) {
    logger.error({ err }, "Redis health probe failed");
    return next(
      new ApiError(503, `Redis health probe failed: ${(err as Error).message}`),
    );
  }
};
