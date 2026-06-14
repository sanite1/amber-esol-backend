import { SchemaType } from "@google-cloud/vertexai";
import ApiError from "../errors/apiError";
import logger from "../config/logger";
import { AISessionMode } from "../interfaces/aiSession.interface";
import { geminiClient, MODEL_NAME } from "../lib/gemini";

/**
 * Single-call Gemini 2.5 Flash on Vertex AI (EU region).
 * Replaces the previous Claude + DeepSeek + NER pipeline.
 *
 * The Vertex AI client is the singleton from src/lib/gemini.ts, initialised
 * once at server boot. Per-request `new VertexAI()` calls are forbidden —
 * every call routes through `geminiClient`.
 *
 * Data sovereignty: the singleton enforces europe-west4 by default; never
 * change it without legal review. This is the legal basis documented in
 * DPIA 2.
 */

/* ── The Amber tutor system prompt — six layers ── */

const LAYER_1_IDENTITY = `You are Amber, an AI English tutor for adult ESOL learners in the UK. You are a patient, warm friend who knows English very well — not a teacher marking work, not a corporate assistant. You teach using the Amber Bridge Method™: the learner's first language is a cognitive scaffold into English, used proportionally to their level and progressively reduced as confidence grows.`;

const LAYER_2_HARD_RULES = `HARD RULES (never violate):
1. Validate first, teach second. Begin every reply with brief acknowledgement of the learner's attempt.
2. Recast errors, never correct directly. Model the correct form naturally — never say "that is incorrect" or similar.
3. Never require personal disclosure. If a learner shares trauma or sensitive personal information, acknowledge warmly in one sentence and redirect to the scenario.
4. Honour silence. Never use these words: quickly, just, easy, simply, straightforward, obviously, as you know.
5. Specific praise only — never generic ("Great job!"). Name exactly what the learner did well.
6. Treat L1 (first language) as intelligence, not failure. Respond with warmth, confirm understanding, model the English equivalent.
7. Make progress visible at session end. Name one specific thing the learner did better at the end than the start.

SAFEGUARDING: If the learner expresses self-harm, domestic abuse, radicalisation concerns, child protection concerns, exploitation, or mental-health crisis, set safeguarding_flag=true and safeguarding_category accordingly, deliver a warm non-alarming reply that signposts NHS 111, Samaritans 116 123, and offers to talk about something else. Do not probe. Do not express shock. Do not reference it again on subsequent turns.`;

const buildLevelLayer = (level: string, l1Language: string): string => {
  const ratios: Record<string, string> = {
    "Entry 1":
      "60% L1 (the learner's first language) / 40% English. All explanations in L1 first, then English alongside. Maximum 5–8 words per sentence. One idea per message. Maximum 3 sentences per response (HARD LIMIT). No idioms or phrasal verbs. Yes/no questions only.",
    "Entry 2":
      "40% L1 / 60% English. L1 for new vocabulary, grammar explanations, and on confusion signal. Up to 12 words per sentence. Simple connectives (and, but, so, because). Maximum 4 sentences. Short-phrase responses expected.",
    "Entry 3":
      "20% L1 / 80% English. L1 available on confusion signal or explicit learner request only. Natural conversational pace. Past and future tense introduced. Sentence-length responses expected.",
    "Level 1":
      "5% L1 / 95% English. L1 only on explicit learner request for a specific concept. Peer-like tone. Idiomatic language introduced with explanation. Formal vs informal registers discussed.",
    "Level 2":
      "English only. L1 available on explicit request — confirm in L1 but respond in English. Complex scenarios. Challenger questions requiring argument or persuasion. Explicit preparation for formal assessment.",
  };
  const ratio = ratios[level] ?? ratios["Entry 2"];
  return `LEARNER LEVEL: ${level}.
L1 LANGUAGE: ${l1Language || "Unknown — assume English-only"}.
LANGUAGE RATIO + VOICE CALIBRATION: ${ratio}`;
};

const buildScenarioLayer = (scenario: ScenarioContext | undefined): string => {
  if (!scenario) {
    return `SCENARIO: General English conversation practice. The learner can ask about anything they need help with.`;
  }
  const vocabList = scenario.vocabulary
    .map(
      (v) =>
        `- ${v.word}: ${v.definition}${v.translations?.[scenario.l1Code] ? ` (${scenario.l1Code}: ${v.translations[scenario.l1Code]})` : ""}`,
    )
    .join("\n");
  return `SCENARIO: ${scenario.title} (id: ${scenario.scenarioId}).
ROLEPLAY SETUP: ${scenario.roleplayPrompt}
GRAMMAR TARGETS: ${scenario.grammarTargets.join(", ")}
CULTURAL NOTES (UK context the learner needs): ${scenario.culturalNotes}
VOCABULARY TO TEACH (weave naturally, do not drill):
${vocabList}
PASS THRESHOLD: turn_score average must reach ${scenario.passThreshold} for session_complete.`;
};

const buildLearnerProfileLayer = (profile: LearnerContext): string => {
  const vocab = profile.vocabularyToReinforce.length
    ? profile.vocabularyToReinforce.join(", ")
    : "(none yet)";
  const summaries = profile.recentSessionSummaries.length
    ? profile.recentSessionSummaries
        .slice(0, 3)
        .map((s, i) => `${i + 1}. ${s}`)
        .join("\n")
    : "First session.";
  return `LEARNER PROFILE:
- Recent session summaries:
${summaries}
- Skill weakness flags: ${profile.skillWeaknessFlags.join(", ") || "none"}
- Vocabulary to reinforce this session (weave naturally into dialogue): ${vocab}
- Current mode at session start: ${profile.currentMode}
- Advancement ceremony pending: ${profile.advancementCeremony ? `YES — celebrate the learner's promotion to ${profile.advancementCeremony.toLevel} in their L1 in your first reply, briefly and warmly.` : "no"}`;
};

const LAYER_6_OUTPUT_FORMAT = `OUTPUT FORMAT: Return strictly the JSON object specified by the response schema. No markdown fences, no commentary outside the JSON. The "reply" field is what the learner sees.

MODE SWITCHING:
- Switch to ANCHOR if: response < 5 words, only L1 with no English attempt, same error 3+ times, turn_score < 0.4, or "I don't understand" in any language.
- Default to BRIDGE.
- Switch to IMMERSION only after 3 consecutive turns at score >= 0.8 with no anchor triggers.

When session_complete=true, populate session_summary with a 2–3 sentence closing message in the learner's L1 + English.`;

/* ── Types ── */

export interface VocabularyItem {
  word: string;
  definition?: string;
  translations?: Record<string, string>;
}

export interface ScenarioContext {
  scenarioId: string;
  title: string;
  roleplayPrompt: string;
  grammarTargets: string[];
  culturalNotes: string;
  vocabulary: VocabularyItem[];
  passThreshold: number;
  l1Code: string;
}

export interface LearnerContext {
  esolLevel: string;
  l1Language: string;
  vocabularyToReinforce: string[];
  recentSessionSummaries: string[];
  skillWeaknessFlags: string[];
  currentMode: AISessionMode;
  advancementCeremony?: { fromLevel: string; toLevel: string };
}

export interface DialogueHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface TurnResponse {
  reply: string;
  mode: AISessionMode;
  skill_codes_used: string[];
  turn_score: number;
  vocabulary_items_used: string[];
  safeguarding_flag: boolean;
  safeguarding_category:
    | "self_harm"
    | "domestic_abuse"
    | "radicalisation"
    | "child_concern"
    | "exploitation"
    | "mental_health_crisis"
    | null;
  session_complete: boolean;
  session_summary: string | null;
  grammar_feedback?: string;
}

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    reply: { type: SchemaType.STRING },
    mode: {
      type: SchemaType.STRING,
      enum: ["ANCHOR", "BRIDGE", "IMMERSION"],
    },
    skill_codes_used: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    turn_score: { type: SchemaType.NUMBER },
    vocabulary_items_used: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    safeguarding_flag: { type: SchemaType.BOOLEAN },
    safeguarding_category: { type: SchemaType.STRING, nullable: true },
    session_complete: { type: SchemaType.BOOLEAN },
    session_summary: { type: SchemaType.STRING, nullable: true },
    grammar_feedback: { type: SchemaType.STRING, nullable: true },
  },
  required: [
    "reply",
    "mode",
    "skill_codes_used",
    "turn_score",
    "vocabulary_items_used",
    "safeguarding_flag",
    "session_complete",
  ],
} as const;

/* ── Main turn processor — single Gemini call ── */

export const processTurn = async (params: {
  learnerInput: string;
  scenario?: ScenarioContext;
  learner: LearnerContext;
  history: DialogueHistoryEntry[];
}): Promise<TurnResponse> => {
  const systemInstruction = [
    LAYER_1_IDENTITY,
    LAYER_2_HARD_RULES,
    buildLevelLayer(params.learner.esolLevel, params.learner.l1Language),
    buildScenarioLayer(params.scenario),
    buildLearnerProfileLayer(params.learner),
    LAYER_6_OUTPUT_FORMAT,
  ].join("\n\n---\n\n");

  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: { role: "system", parts: [{ text: systemInstruction }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA as any,
      temperature: 0.7,
      // 2.5-flash thinking tokens count against this budget — see the
      // placement scorer note. 1024 risked mid-JSON truncation on the
      // core tutor turn.
      maxOutputTokens: 2048,
    },
    safetySettings: [
      // Lower thresholds — we WANT to receive flagged content so we can
      // log it as a safeguarding concern rather than have Gemini refuse
      // outright. We handle safety policy via our own safeguarding layer.
      {
        category: "HARM_CATEGORY_HARASSMENT" as any,
        threshold: "BLOCK_ONLY_HIGH" as any,
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH" as any,
        threshold: "BLOCK_ONLY_HIGH" as any,
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT" as any,
        threshold: "BLOCK_ONLY_HIGH" as any,
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT" as any,
        threshold: "BLOCK_ONLY_HIGH" as any,
      },
    ] as any,
  });

  const contents = [
    ...params.history.map((h) => ({
      role: h.role === "assistant" ? "model" : "user",
      parts: [{ text: h.content }],
    })),
    { role: "user", parts: [{ text: params.learnerInput }] },
  ];

  try {
    const result = await model.generateContent({ contents });
    const text =
      result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) {
      throw new Error("Empty response from Gemini");
    }
    const parsed = JSON.parse(text) as TurnResponse;

    // Normalise mode case
    const mode = (parsed.mode || "BRIDGE").toUpperCase() as AISessionMode;
    return {
      ...parsed,
      mode: ["ANCHOR", "BRIDGE", "IMMERSION"].includes(mode) ? mode : "BRIDGE",
      turn_score: Math.max(0, Math.min(1, Number(parsed.turn_score) || 0)),
      vocabulary_items_used: parsed.vocabulary_items_used || [],
      skill_codes_used: parsed.skill_codes_used || [],
      safeguarding_category: parsed.safeguarding_flag
        ? parsed.safeguarding_category
        : null,
    };
  } catch (err) {
    logger.error({ err }, "Gemini processTurn failed");
    throw new ApiError(
      503,
      "The AI tutor is temporarily unavailable. Please try again.",
    );
  }
};

/* ── Placement assessment scorer ── */

export interface AssessmentResponse {
  questionId: string;
  questionText: string;
  level: string;
  learnerAnswer: string;
  correctAnswer?: string;
}

export interface PlacementScore {
  nqfLevel: "Entry 1" | "Entry 2" | "Entry 3" | "Level 1" | "Level 2";
  confidence: number;
  skillWeaknessFlags: string[];
  rationale: string;
}

const PLACEMENT_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    nqfLevel: {
      type: SchemaType.STRING,
      enum: ["Entry 1", "Entry 2", "Entry 3", "Level 1", "Level 2"],
    },
    confidence: { type: SchemaType.NUMBER },
    skillWeaknessFlags: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    rationale: { type: SchemaType.STRING },
  },
  required: ["nqfLevel", "confidence", "skillWeaknessFlags", "rationale"],
} as const;

/* Mechanics duplicated from the PROVEN-WORKING post-account placement
   flow (placement.service.ts — Function 6): 4096-token budget, a
   retry loop (one transient hiccup no longer dumps the learner into
   the Entry 1 fallback), strict parse + validation, and raw-body
   logging on failure so the true cause is always in the logs. */

const ONBOARDING_SCORING_MAX_TOKENS = 4096; // mirrors SCORING_MAX_TOKENS
const VALID_NQF_LEVELS = new Set([
  "Entry 1",
  "Entry 2",
  "Entry 3",
  "Level 1",
  "Level 2",
]);

/** Strict parse + validate — mirrors placement.service.ts
 *  parseScoringResponse so malformed output is caught loudly rather
 *  than leaking a half-formed object into the learner record. */
const parsePlacementScore = (text: string): PlacementScore => {
  const p = JSON.parse(text) as Partial<PlacementScore>;
  if (typeof p.nqfLevel !== "string" || !VALID_NQF_LEVELS.has(p.nqfLevel)) {
    throw new Error(`Invalid nqfLevel: ${p.nqfLevel}`);
  }
  if (
    typeof p.confidence !== "number" ||
    p.confidence < 0 ||
    p.confidence > 1
  ) {
    throw new Error(`Invalid confidence: ${p.confidence}`);
  }
  if (!Array.isArray(p.skillWeaknessFlags)) {
    throw new Error("skillWeaknessFlags must be an array");
  }
  if (typeof p.rationale !== "string" || p.rationale.trim() === "") {
    throw new Error("rationale must be a non-empty string");
  }
  return p as PlacementScore;
};

const scorePlacementOnce = async (
  userText: string,
): Promise<PlacementScore> => {
  const systemInstruction = `You are an experienced ESOL placement assessor working with the UK Adult ESOL Core Curriculum (DfES 2001) and the NQF level descriptors (Entry 1 through Level 2).

Score the learner's responses to the placement assessment below. Apply this rule strictly: NEVER over-assign a level. Always assign the correct level OR ONE LEVEL BELOW. Never assign a level the learner has not clearly demonstrated.

Use these descriptors:
- Entry 1 (A1): basic phrases, can introduce self, answer simple personal questions
- Entry 2 (A2): simple routine tasks, frequently used sentences
- Entry 3 (B1 lower): describe experiences, main points of clear standard input
- Level 1 (B1 upper): interact with fluency, complex text on familiar topics
- Level 2 (B2): complex text, clear detail on wide range, GCSE equivalent

Return JSON: nqfLevel, confidence (0-1), skillWeaknessFlags (array of skill codes from {Sc, Sd, Lr, Rt, Rs, Rw, Wt, Ws, Ww} where the learner showed weakness), rationale (2-3 sentence explanation).`;

  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: { role: "system", parts: [{ text: systemInstruction }] },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: PLACEMENT_SCHEMA as any,
      temperature: 0.2,
      // gemini-2.5-flash is a THINKING model — internal reasoning
      // tokens are billed against maxOutputTokens. 4096 matches the
      // proven post-account placement scorer; typical real usage is
      // a few hundred tokens, so this is a wide safety margin.
      maxOutputTokens: ONBOARDING_SCORING_MAX_TOKENS,
    },
  });

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: userText }] }],
  });
  const candidate = result.response?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text ?? "";

  if (candidate?.finishReason === "MAX_TOKENS") {
    logger.error(
      { finishReason: candidate.finishReason, textLength: text.length },
      "Onboarding placement scoring TRUNCATED — maxOutputTokens too small for gemini-2.5-flash thinking budget. Raise it.",
    );
  }
  if (!text) {
    throw new Error(
      `Empty response from Gemini (finishReason: ${candidate?.finishReason ?? "unknown"})`,
    );
  }

  try {
    return parsePlacementScore(text);
  } catch (err) {
    // Raw-body snippet in the log — mirrors placement.service.ts so
    // schema drift is diagnosable without re-running the request.
    logger.error(
      { rawSnippet: text.slice(0, 500), parseErr: (err as Error).message },
      "Onboarding placement scoring — parse/validate failed",
    );
    throw err;
  }
};

export const scorePlacementAssessment = async (
  responses: AssessmentResponse[],
): Promise<PlacementScore> => {
  const userText = responses
    .map(
      (r, i) =>
        `Q${i + 1} (level ${r.level}): ${r.questionText}\nLearner answer: ${r.learnerAnswer}${r.correctAnswer ? `\nCorrect: ${r.correctAnswer}` : ""}`,
    )
    .join("\n\n");

  // Retry once on ANY failure — mirrors the working placement flow.
  // A single transient hiccup (parse failure, 429, network blip)
  // previously sent every affected learner straight to the Entry 1
  // fallback.
  let lastError: Error | null = null;
  for (const attemptNum of [1, 2]) {
    try {
      return await scorePlacementOnce(userText);
    } catch (err) {
      lastError = err as Error;
      logger.warn(
        { err, attemptNum },
        "Onboarding placement scoring call failed — will retry",
      );
    }
  }

  logger.error(
    { err: lastError },
    "Onboarding placement scoring failed after retries",
  );
  throw new ApiError(503, "Assessment scoring is temporarily unavailable.");
};

/* ── Teacher prep note generator ── */

export const generateTeacherPrepNote = async (input: {
  esolLevel: string;
  l1Language: string;
  topic?: string;
  recentSessionSummaries: string[];
}): Promise<string> => {
  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: {
      role: "system",
      parts: [
        {
          text: `You are an ESOL teaching assistant. Generate a concise pre-session briefing for a human ESOL teacher. Use British English. Keep under 300 words. Markdown sections: **Learner Snapshot**, **Recent Progress**, **Areas to Focus**, **Suggested Activities**, **Watch For**.`,
        },
      ],
    },
    // Thinking budget shares maxOutputTokens on 2.5-flash — 1024 could
    // truncate the ~300-word note after thinking.
    generationConfig: { temperature: 0.5, maxOutputTokens: 2048 },
  });

  const userText = [
    `Learner level: ${input.esolLevel}`,
    `L1: ${input.l1Language || "unknown"}`,
    `Topic: ${input.topic || "general consolidation"}`,
    "",
    "Recent AI session summaries:",
    input.recentSessionSummaries.length
      ? input.recentSessionSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "None — first session.",
  ].join("\n");

  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: userText }] }],
    });
    return result.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  } catch (err) {
    logger.error({ err }, "Teacher prep note generation failed");
    throw new ApiError(500, "Could not generate teacher prep note.");
  }
};

/* ── Final session summary ── */

export const generateSessionSummary = async (
  transcript: string,
): Promise<string> => {
  const model = geminiClient.preview.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: {
      role: "system",
      parts: [
        {
          text: `You are an ESOL teacher producing a final session summary (3-5 sentences) covering: overall engagement, vocabulary introduced, recommended focus next session. British English, constructive tone.`,
        },
      ],
    },
    // Thinking budget shares maxOutputTokens on 2.5-flash — 512 left
    // no room for the 3-5 sentence summary after thinking.
    generationConfig: { temperature: 0.4, maxOutputTokens: 1536 },
  });
  try {
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: transcript }] }],
    });
    return (
      result.response?.candidates?.[0]?.content?.parts?.[0]?.text ??
      "Session summary could not be generated automatically."
    );
  } catch (err) {
    logger.error({ err }, "Session summary failed");
    return "Session summary could not be generated automatically.";
  }
};

/* ── Pre-cached safeguarding messages (used when AI is unavailable) ── */

export const PRECACHED_SAFEGUARDING_REPLY = (l1Language?: string): string => {
  // Single English response — frontend can localise via i18n in the future.
  return `Thank you for sharing that with me. Help is available — please consider:
• NHS 111 (free, 24/7) for urgent medical or mental health support
• Samaritans 116 123 (free, 24/7) — anyone, any concern
• Your local council can help with housing, benefits, and safety

If you would like to keep practising your English, I am here. We can talk about something else when you feel ready.`;
};
