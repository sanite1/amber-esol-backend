import {
  VertexAI,
  GenerativeModelPreview,
  ModelParams,
} from "@google-cloud/vertexai";
import logger from "../config/logger";

/**
 * Singleton Vertex AI Gemini client.
 *
 * One Vertex AI instance is constructed at server boot via initGeminiClient()
 * and shared by every request thereafter. Services import `geminiClient` and
 * use it directly. Per-request `new VertexAI()` calls are forbidden.
 *
 * IMPORTANT — responseMimeType:
 *   `responseMimeType: "application/json"` is intentionally NOT set at client
 *   level. It must be passed per-request inside `generationConfig` only on the
 *   calls that genuinely expect structured JSON (Phase 8 placement scorer,
 *   Phase 9 AI tutor turn). Setting it globally breaks plain-text generation
 *   (the model returns empty bodies because it tries to match the wrong shape).
 *
 * IMPORTANT — model string:
 *   Use `gemini-2.5-flash`. Versioned suffixes (e.g. `-001`, `-latest`,
 *   `-preview`) currently 404 in europe-west4.
 *
 * IMPORTANT — region:
 *   europe-west4 (Netherlands) is the only EU region currently hosting
 *   Gemini 2.5 Flash. europe-west2 (London) returns 404. EU data residency
 *   is part of the DPIA-2 commitment — do not change without legal review.
 *
 * Deprecation note:
 *   `@google-cloud/vertexai` SDK is deprecated as of June 24 2025 and will be
 *   removed June 24 2026. Migration to `@google/genai` is a separate task.
 *   The singleton boundary in this module makes that migration mechanical.
 */

export const MODEL_NAME = "gemini-2.5-flash";

// Accept brief-mandated names (GOOGLE_CLOUD_*) and pre-existing names (GCP_*)
// so existing dev .env files keep working while we migrate naming.
const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GCP_PROJECT_ID || "";
const REGION =
  process.env.GOOGLE_CLOUD_REGION ||
  process.env.GCP_LOCATION ||
  "europe-west4";

let _client: VertexAI | null = null;

/**
 * Initialise the Vertex AI client at server boot. Must be called from
 * src/index.ts BEFORE server.listen(). Throws on any configuration problem;
 * the caller (index.ts) is responsible for crashing the process on failure
 * so we never silently degrade to per-request errors.
 */
export const initGeminiClient = (): void => {
  if (_client) {
    logger.warn("initGeminiClient called twice — ignoring second call");
    return;
  }

  if (!PROJECT_ID) {
    throw new Error(
      "Vertex AI init failed: GOOGLE_CLOUD_PROJECT_ID (or legacy GCP_PROJECT_ID) is not set."
    );
  }
  if (REGION === "europe-west2") {
    throw new Error(
      "Vertex AI init failed: europe-west2 does not host Gemini 2.5 Flash. Use europe-west4."
    );
  }

  try {
    _client = new VertexAI({ project: PROJECT_ID, location: REGION });
  } catch (err) {
    throw new Error(
      `Vertex AI init failed during VertexAI construction: ${(err as Error).message}`
    );
  }

  // Match the exact log shape requested by the brief addendum.
  logger.info(
    `Vertex AI client initialised: project=${PROJECT_ID} region=${REGION} model=${MODEL_NAME}`
  );

  if (process.env.GCP_PROJECT_ID && !process.env.GOOGLE_CLOUD_PROJECT_ID) {
    logger.warn(
      "Using legacy GCP_PROJECT_ID env var. Migrate to GOOGLE_CLOUD_PROJECT_ID per Project Silk brief."
    );
  }
  if (process.env.GCP_LOCATION && !process.env.GOOGLE_CLOUD_REGION) {
    logger.warn(
      "Using legacy GCP_LOCATION env var. Migrate to GOOGLE_CLOUD_REGION per Project Silk brief."
    );
  }
};

/**
 * The shared Vertex AI client. Access only after initGeminiClient() has run
 * — Proxy throws a clear error otherwise instead of allowing the request to
 * silently fail with a cryptic SDK error mid-call.
 */
export const geminiClient: VertexAI = new Proxy({} as VertexAI, {
  get(_target, prop, receiver) {
    if (!_client) {
      throw new Error(
        "geminiClient accessed before initGeminiClient() ran. Add `initGeminiClient()` to src/index.ts before server.listen()."
      );
    }
    return Reflect.get(_client, prop, receiver);
  },
});

/**
 * Helper for services that just want a configured GenerativeModel handle.
 * Callers MAY pass generationConfig (including per-request responseMimeType)
 * — the client itself never sets responseMimeType at construction.
 */
export const getGeminiModel = (
  overrides: Partial<ModelParams> = {}
): GenerativeModelPreview => {
  if (!_client) {
    throw new Error(
      "getGeminiModel called before initGeminiClient(). See src/index.ts."
    );
  }
  // Use the .preview namespace to match what the existing service code uses
  // (systemInstruction support is only in the preview API on this SDK
  // version). The interface is identical in practice for gemini-2.5-flash.
  return _client.preview.getGenerativeModel({
    model: MODEL_NAME,
    ...overrides,
  });
};

/**
 * Minimal "is Gemini reachable" probe used by GET /api/health/gemini.
 * Issues a real (tiny) generation call so we exercise the full auth +
 * network + model path, not just SDK construction. Costs effectively zero.
 */
export const pingGemini = async (): Promise<{ latencyMs: number }> => {
  if (!_client) {
    throw new Error("pingGemini called before initGeminiClient().");
  }
  const model = _client.preview.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: { maxOutputTokens: 1, temperature: 0 },
  });

  const t0 = Date.now();
  await model.generateContent({
    contents: [{ role: "user", parts: [{ text: "ok" }] }],
  });
  return { latencyMs: Date.now() - t0 };
};
