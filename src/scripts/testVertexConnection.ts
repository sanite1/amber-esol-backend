/**
 * One-off connectivity test for the Vertex AI Gemini setup.
 *
 * What this proves:
 *   1. service-account.json loads correctly (via GOOGLE_APPLICATION_CREDENTIALS
 *      or gcloud Application Default Credentials).
 *   2. The configured GCP project + region are reachable.
 *   3. The service account has at minimum the "Vertex AI User" role.
 *   4. The Vertex AI API is enabled for the project.
 *   5. gemini-2.5-flash is published in the configured region.
 *
 * What this does NOT do:
 *   - Generate any Gemini content. No inference; no token cost. The model
 *     listing endpoint is free.
 *
 * Run:
 *   npx ts-node src/scripts/testVertexConnection.ts
 *
 * Or with explicit env overrides:
 *   GCP_PROJECT_ID=amber-training-project-silk-xxxxxx \
 *   GCP_LOCATION=europe-west4 \
 *   GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/service-account.json \
 *   npx ts-node src/scripts/testVertexConnection.ts
 */

import "dotenv/config";
import { GoogleAuth } from "google-auth-library";

const LOCATION = process.env.GCP_LOCATION || "europe-west4";
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const EXPECTED_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const c = {
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  err: "\x1b[31m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
};

const log = {
  step: (m: string) => console.log(`${c.dim}…${c.reset} ${m}`),
  ok: (m: string) => console.log(`${c.ok}✓${c.reset} ${m}`),
  warn: (m: string) => console.log(`${c.warn}!${c.reset} ${m}`),
  err: (m: string) => console.log(`${c.err}✗${c.reset} ${m}`),
};

const fail = (msg: string, hint?: string): never => {
  log.err(msg);
  if (hint) log.err(hint);
  process.exit(1);
};

const main = async () => {
  log.step(`Project: ${PROJECT_ID ?? "(not set — will try ADC)"}`);
  log.step(`Region:  ${LOCATION}`);
  log.step(`Model:   ${EXPECTED_MODEL}`);

  if (LOCATION === "europe-west2") {
    log.warn(
      "europe-west2 (London) does not host Gemini 2.5 Flash as of the brief (May 2026). Use europe-west4."
    );
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    log.warn(
      "GOOGLE_APPLICATION_CREDENTIALS not set — falling back to gcloud Application Default Credentials."
    );
  }

  // ── Step 1: build the auth client ──
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });

  // ── Step 2: resolve project ID ──
  let resolvedProject: string;
  try {
    resolvedProject = PROJECT_ID || (await auth.getProjectId());
    log.ok(`Resolved project: ${resolvedProject}`);
  } catch (err) {
    return fail(
      `Could not resolve a GCP project ID: ${(err as Error).message}`,
      "Set GCP_PROJECT_ID in .env, or ensure the credentials JSON contains a project_id field."
    );
  }

  // ── Step 3: mint an access token ──
  let token: string;
  try {
    const client = await auth.getClient();
    const t = await client.getAccessToken();
    if (!t.token) throw new Error("Empty access token returned");
    token = t.token;
    log.ok(`Auth: minted access token (${token.length} chars)`);
  } catch (err) {
    return fail(
      `Auth failed: ${(err as Error).message}`,
      "Check GOOGLE_APPLICATION_CREDENTIALS points to a real JSON file, the file is well-formed, and the service account is not disabled."
    );
  }

  // ── Step 4: call :countTokens on the model (free, no inference) ──
  // This is the canonical free smoke test for a Vertex AI generative model.
  // It tokenizes the input and returns a count — does not invoke the model,
  // does not generate content, costs $0. If this returns 200 we know:
  //   - billing is active on the project
  //   - the Vertex AI API is enabled and reachable
  //   - the service account can call generative endpoints
  //   - gemini-2.5-flash is published in this region for this project
  const countTokensUrl = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${resolvedProject}/locations/${LOCATION}/publishers/google/models/${EXPECTED_MODEL}:countTokens`;
  log.step(`POST ${countTokensUrl}`);

  const body = {
    contents: [{ role: "user", parts: [{ text: "ping" }] }],
  };

  let res: Response;
  try {
    res = await fetch(countTokensUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return fail(`Network error: ${(err as Error).message}`);
  }

  const rawBody = await res.text();
  const looksHtml = rawBody.trim().startsWith("<");

  if (!res.ok) {
    log.err(`HTTP ${res.status} ${res.statusText}`);
    console.error(rawBody.slice(0, 800));
    if (looksHtml && res.status === 404) {
      return fail(
        "Edge 404 (HTML response, not a Vertex AI JSON error).",
        "Almost always means billing isn't active on the project, or the API has not finished propagating after enablement. Activate billing at https://console.cloud.google.com/billing and wait ~1 minute."
      );
    }
    if (res.status === 403) {
      return fail(
        "Forbidden",
        "Service account is missing 'Vertex AI User' role, or the Vertex AI API is not enabled."
      );
    }
    if (res.status === 404) {
      return fail(
        `${EXPECTED_MODEL} not found in ${LOCATION} for ${resolvedProject}.`,
        "Model not yet published in this region, or you haven't accepted Gen AI terms. Open https://console.cloud.google.com/vertex-ai/studio once with this project selected to trigger the acceptance dialog."
      );
    }
    return fail("Unexpected HTTP error — see body above.");
  }

  let parsed: { totalTokens?: number; totalBillableCharacters?: number };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return fail("200 OK but body is not JSON. Unexpected.");
  }

  log.ok(`countTokens response: ${JSON.stringify(parsed)}`);
  log.ok(`${EXPECTED_MODEL} is wired up in ${LOCATION} for ${resolvedProject}.`);
  log.ok("Vertex AI connection confirmed.");
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
