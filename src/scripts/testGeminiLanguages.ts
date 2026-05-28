/**
 * Phase 0 / Section 1 Task 3 smoke test — Gemini 2.5 Flash language coverage.
 *
 * Sends 10 short ESOL-style conversational prompts in each MVP language to
 * gemini-2.5-flash via Vertex AI in europe-west4. Records response,
 * response time, token usage, finish reason, and a heuristic check on
 * whether the response came back in the right script.
 *
 * Outputs:
 *   /tmp/gemini-language-test.csv — one row per (language, message)
 *   stdout — per-message progress + per-language summary
 *
 * Languages tested (the brief bundles Dari/Pashto as one bucket; this script
 * tests them separately to surface single-language regressions):
 *   - Arabic   (Arabic script)
 *   - Somali   (Latin script)
 *   - Dari     (Persian-Arabic script)
 *   - Pashto   (Persian-Arabic script)
 *   - Cantonese (Traditional Chinese / CJK)
 *   - English   (Latin / ASCII)
 *
 * Tigrinya is explicitly EXCLUDED per the brief — MVP does not support it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HUMAN-REVIEW STEP — DO NOT SKIP BEFORE GOING LIVE:
 *
 *   Engage a Somali-speaking ESOL professional via NATECLA
 *   (https://natecla.org.uk, info@natecla.org.uk) to read the Somali output
 *   in the CSV and confirm: (a) it is recognisable Somali, (b) it is
 *   appropriate for an Entry Level adult learner, (c) it is culturally and
 *   linguistically acceptable. No real Somali learner uses this platform
 *   until that review is complete and documented.
 *
 *   Apply equivalent native-speaker review for Dari, Pashto, Cantonese,
 *   and Arabic before each goes live with real learners. The brief calls
 *   out Somali by name because Gemini's Somali support is least well
 *   evidenced in public benchmarks.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Run:
 *   npx ts-node src/scripts/testGeminiLanguages.ts
 *
 * Requires the same env as testVertexConnection.ts:
 *   GCP_PROJECT_ID, GCP_LOCATION (europe-west4),
 *   GOOGLE_APPLICATION_CREDENTIALS, GEMINI_MODEL (defaults to gemini-2.5-flash)
 */

import "dotenv/config";
import { writeFileSync } from "fs";
// Uses the same singleton the running server uses — keeps the smoke test
// honest by exercising the exact code path real requests go through.
import { initGeminiClient, geminiClient } from "../lib/gemini";

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const LOCATION = process.env.GCP_LOCATION || "europe-west4";
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const OUTPUT_CSV = "/tmp/gemini-language-test.csv";

if (!PROJECT_ID) {
  console.error("GCP_PROJECT_ID is not set in .env");
  process.exit(1);
}

const c = {
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  err: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

// ── Languages under test ────────────────────────────────────────────────
type LanguageCode = "en" | "ar" | "so" | "fa-AF" | "ps" | "zh-HK";

interface Language {
  code: LanguageCode;
  displayName: string;
  expectedScript: "latin" | "arabic" | "cjk";
}

const LANGUAGES: Language[] = [
  { code: "en", displayName: "English", expectedScript: "latin" },
  { code: "ar", displayName: "Arabic", expectedScript: "arabic" },
  { code: "so", displayName: "Somali", expectedScript: "latin" },
  { code: "fa-AF", displayName: "Dari (Afghan Persian)", expectedScript: "arabic" },
  { code: "ps", displayName: "Pashto", expectedScript: "arabic" },
  { code: "zh-HK", displayName: "Cantonese (Traditional Chinese)", expectedScript: "cjk" },
];

// ── 10 ESOL-relevant seed prompts (English) ─────────────────────────────
// These cover the three MVP scenarios (GP, payslip, housing) plus other
// common UK-life situations an ESOL learner navigates.
const SEED_PROMPTS_EN: string[] = [
  "I am learning English. Can you help me practise booking a doctor appointment?",
  "I do not understand my payslip. Can you explain what 'gross pay' and 'deductions' mean?",
  "My landlord has not fixed the broken heater. What can I do?",
  "I need to register my child for primary school. What do I need to bring?",
  "Can you help me practise asking for directions to the train station?",
  "I am nervous about a job interview next week. Can we practise some questions?",
  "How do I open a UK bank account?",
  "I want to call 111 about my child's cough. What should I say?",
  "Can you teach me three polite phrases to use in a shop?",
  "I have a parents' evening at school. What questions should I ask the teacher?",
];

// ── Vertex AI client (shared singleton) ─────────────────────────────────
// Scripts must initialise the singleton themselves since they don't go
// through src/index.ts. This is the one place outside index.ts that's
// allowed to call initGeminiClient().
initGeminiClient();

const model = geminiClient.getGenerativeModel({
  model: MODEL_NAME,
  generationConfig: {
    temperature: 0.7,
    // Bilingual Bridge Method replies (L1 + English) routinely exceed 400
    // tokens. 1024 leaves headroom while keeping a clear "way too long" cap.
    maxOutputTokens: 1024,
  },
});

// ── Script detection (heuristic, not a full language ID) ────────────────
const ARABIC_RX = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
const CJK_RX = /[　-〿㐀-䶿一-鿿豈-﫿]/;
const LATIN_RX = /[A-Za-z]/;

const detectScript = (text: string): "latin" | "arabic" | "cjk" | "mixed" | "unknown" => {
  const hasArabic = ARABIC_RX.test(text);
  const hasCjk = CJK_RX.test(text);
  const hasLatin = LATIN_RX.test(text);
  const flags = [hasArabic, hasCjk, hasLatin].filter(Boolean).length;
  if (flags === 0) return "unknown";
  if (flags > 1) return "mixed";
  if (hasArabic) return "arabic";
  if (hasCjk) return "cjk";
  return "latin";
};

// ── Translate the 10 seed prompts into a target language ────────────────
// Single Gemini call per language, returns a JSON array of 10 strings.
const translatePrompts = async (target: Language): Promise<string[]> => {
  if (target.code === "en") return [...SEED_PROMPTS_EN];

  const prompt = `Translate each of these 10 short English sentences into ${target.displayName}. Return ONLY a JSON array of 10 strings, no commentary, no markdown fences. Maintain the conversational tone — these are spoken by an adult ESOL learner asking an AI tutor for help.

INPUT:
${SEED_PROMPTS_EN.map((p, i) => `${i + 1}. ${p}`).join("\n")}`;

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      // 10 sentences × ~150 tokens each + JSON overhead. Languages with
      // verbose orthography (Somali compounds, Pashto particles) bust 2048.
      maxOutputTokens: 6144,
      responseMimeType: "application/json",
    },
  });

  const raw = result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse translation JSON for ${target.displayName}: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 10 || parsed.some((p) => typeof p !== "string")) {
    throw new Error(`Translation for ${target.displayName} did not return 10 strings — got ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return parsed as string[];
};

// ── Per-message turn against Gemini ─────────────────────────────────────
interface TurnResult {
  language: string;
  messageIndex: number;
  promptEn: string;
  promptInLang: string;
  response: string;
  responseTimeMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishReason: string;
  detectedScript: string;
  scriptMatchesExpected: boolean;
  suspectedTruncation: boolean;
  error: string;
}

const SYSTEM_INSTRUCTION = `You are Amber, an AI English tutor for adult ESOL learners in the UK. The learner will address you in their first language. You must reply in the SAME language they used (with English equivalents woven in where helpful). Keep replies short — 2 to 4 sentences. Warm, patient, never corrective in tone.`;

const sendTurn = async (
  lang: Language,
  index: number,
  promptInLang: string,
  promptEn: string
): Promise<TurnResult> => {
  const result: TurnResult = {
    language: lang.displayName,
    messageIndex: index + 1,
    promptEn,
    promptInLang,
    response: "",
    responseTimeMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    finishReason: "",
    detectedScript: "",
    scriptMatchesExpected: false,
    suspectedTruncation: false,
    error: "",
  };

  const t0 = Date.now();
  try {
    const resp = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: promptInLang }] }],
      systemInstruction: { role: "system", parts: [{ text: SYSTEM_INSTRUCTION }] },
    });
    result.responseTimeMs = Date.now() - t0;

    const candidate = resp.response?.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text ?? "";
    result.response = text.trim();
    result.finishReason = candidate?.finishReason ?? "UNKNOWN";

    const usage = resp.response?.usageMetadata;
    result.inputTokens = usage?.promptTokenCount ?? 0;
    result.outputTokens = usage?.candidatesTokenCount ?? 0;
    result.totalTokens = usage?.totalTokenCount ?? 0;

    const script = detectScript(result.response);
    result.detectedScript = script;
    // Bridge Method explicitly mixes L1 + English. Treat the response as
    // matching expected language if ANY of the expected script is present.
    // The only failure case worth flagging is "expected non-Latin but the
    // response is entirely Latin" (or entirely the wrong non-Latin script).
    // Somali/English share Latin script; this heuristic cannot distinguish
    // them. NATECLA review is the only reliable check for Somali quality.
    if (lang.expectedScript === "arabic") {
      result.scriptMatchesExpected = ARABIC_RX.test(result.response);
    } else if (lang.expectedScript === "cjk") {
      result.scriptMatchesExpected = CJK_RX.test(result.response);
    } else {
      // Latin (English, Somali): must contain Latin characters
      result.scriptMatchesExpected = LATIN_RX.test(result.response);
    }

    // Only flag genuine truncation. `MAX_TOKENS` is authoritative from the
    // API; an empty response is also obviously bad. Drop the punctuation
    // heuristic — it produced false positives on natural sentence endings.
    result.suspectedTruncation =
      result.finishReason === "MAX_TOKENS" || result.response.length === 0;
  } catch (err) {
    result.responseTimeMs = Date.now() - t0;
    result.error = (err as Error).message;
  }

  return result;
};

// ── CSV serialisation ───────────────────────────────────────────────────
const csvEscape = (v: string | number | boolean): string => {
  const s = String(v);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
};

const toCsvRow = (r: TurnResult): string =>
  [
    r.language,
    r.messageIndex,
    r.promptEn,
    r.promptInLang,
    r.response,
    r.responseTimeMs,
    r.inputTokens,
    r.outputTokens,
    r.totalTokens,
    r.finishReason,
    r.detectedScript,
    r.scriptMatchesExpected,
    r.suspectedTruncation,
    r.error,
  ]
    .map(csvEscape)
    .join(",");

const CSV_HEADER =
  "language,message_index,prompt_en,prompt_in_lang,response,response_time_ms,input_tokens,output_tokens,total_tokens,finish_reason,detected_script,script_matches_expected,suspected_truncation,error";

// ── Main ────────────────────────────────────────────────────────────────
const main = async () => {
  console.log(`${c.bold}Gemini language smoke test${c.reset}`);
  console.log(`${c.dim}Project: ${PROJECT_ID} | Region: ${LOCATION} | Model: ${MODEL_NAME}${c.reset}`);
  console.log(`${c.dim}Output:  ${OUTPUT_CSV}${c.reset}\n`);

  const rows: TurnResult[] = [];

  for (const lang of LANGUAGES) {
    console.log(`${c.bold}── ${lang.displayName} (${lang.code}) ──${c.reset}`);

    // Translate prompts (or use English seeds directly).
    let prompts: string[];
    try {
      prompts = await translatePrompts(lang);
      if (lang.code !== "en") {
        console.log(`${c.ok}✓${c.reset} translated 10 prompts`);
      }
    } catch (err) {
      console.log(`${c.err}✗${c.reset} translation prep failed: ${(err as Error).message}`);
      // Record a synthetic failure row per prompt so the CSV still shows the gap.
      for (let i = 0; i < SEED_PROMPTS_EN.length; i++) {
        rows.push({
          language: lang.displayName,
          messageIndex: i + 1,
          promptEn: SEED_PROMPTS_EN[i],
          promptInLang: "",
          response: "",
          responseTimeMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          finishReason: "TRANSLATION_PREP_FAILED",
          detectedScript: "",
          scriptMatchesExpected: false,
          suspectedTruncation: false,
          error: (err as Error).message,
        });
      }
      continue;
    }

    // Send each prompt and record result.
    for (let i = 0; i < prompts.length; i++) {
      const result = await sendTurn(lang, i, prompts[i], SEED_PROMPTS_EN[i]);
      rows.push(result);

      const mark = result.error
        ? `${c.err}✗${c.reset}`
        : result.scriptMatchesExpected && !result.suspectedTruncation
        ? `${c.ok}✓${c.reset}`
        : `${c.warn}!${c.reset}`;

      const flags: string[] = [];
      if (!result.scriptMatchesExpected) flags.push(`script=${result.detectedScript}`);
      if (result.suspectedTruncation) flags.push("truncated?");
      if (result.error) flags.push(`error: ${result.error.slice(0, 80)}`);

      console.log(
        `${mark} ${String(i + 1).padStart(2)}/10 ${String(result.responseTimeMs).padStart(5)}ms` +
          ` ${String(result.totalTokens).padStart(4)} tok` +
          (flags.length ? `  ${c.warn}[${flags.join(", ")}]${c.reset}` : "")
      );
    }
    console.log("");
  }

  // ── Write CSV ────────────────────────────────────────────────────────
  const csv = [CSV_HEADER, ...rows.map(toCsvRow)].join("\n") + "\n";
  writeFileSync(OUTPUT_CSV, csv, "utf-8");
  console.log(`${c.ok}✓${c.reset} wrote ${rows.length} rows to ${OUTPUT_CSV}`);

  // ── Summary ─────────────────────────────────────────────────────────
  console.log(`\n${c.bold}Summary${c.reset}`);
  for (const lang of LANGUAGES) {
    const langRows = rows.filter((r) => r.language === lang.displayName);
    const errors = langRows.filter((r) => r.error).length;
    const scriptOk = langRows.filter((r) => r.scriptMatchesExpected && !r.error).length;
    const truncated = langRows.filter((r) => r.suspectedTruncation && !r.error).length;
    const avgMs = Math.round(
      langRows.filter((r) => !r.error).reduce((s, r) => s + r.responseTimeMs, 0) /
        Math.max(1, langRows.filter((r) => !r.error).length)
    );
    const avgTok = Math.round(
      langRows.filter((r) => !r.error).reduce((s, r) => s + r.totalTokens, 0) /
        Math.max(1, langRows.filter((r) => !r.error).length)
    );

    const verdict =
      errors === 0 && scriptOk === langRows.length && truncated === 0
        ? `${c.ok}PASS${c.reset}`
        : `${c.warn}REVIEW${c.reset}`;

    console.log(
      `  ${verdict}  ${lang.displayName.padEnd(32)} ` +
        `script_ok=${scriptOk}/10 errors=${errors} truncated=${truncated} ` +
        `avg_ms=${avgMs} avg_tok=${avgTok}`
    );
  }

  console.log(
    `\n${c.bold}Next step:${c.reset} open ${OUTPUT_CSV} in a spreadsheet and read the Somali responses.` +
      ` Engage NATECLA (info@natecla.org.uk) for a native-speaker review before any real Somali learner uses the platform.`
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
