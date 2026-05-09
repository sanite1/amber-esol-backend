import Anthropic from "@anthropic-ai/sdk";
import ApiError from "../errors/apiError";
import logger from "../config/logger";
import { AISessionMode } from "../interfaces/aiSession.interface";

const MODEL = "claude-sonnet-4-5-20250929";

let client: Anthropic | null = null;

const getClient = (): Anthropic => {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ApiError(500, "Anthropic API key is not configured");
  }
  client = new Anthropic({ apiKey });
  return client;
};

const extractText = (content: Anthropic.ContentBlock[]): string => {
  for (const block of content) {
    if (block.type === "text") return block.text;
  }
  return "";
};

const parseJsonFromResponse = <T>(raw: string): T => {
  // Claude sometimes wraps JSON in markdown fences — strip them
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    logger.error({ raw }, "Failed to parse Claude JSON response");
    throw new ApiError(500, "AI response was not valid JSON");
  }
};

/* ── Safeguarding screen ── */

export type SafeguardingLevel = "low" | "medium" | "high" | "critical";

export interface SafeguardingResult {
  score: number;
  flagged: boolean;
  reasoning: string;
  level: SafeguardingLevel;
}

const SAFEGUARDING_SYSTEM_PROMPT = `You are a safeguarding officer for an ESOL (English for Speakers of Other Languages) learning platform serving vulnerable adults in the UK. Your role is to identify welfare concerns in learner messages.

You will receive a single message from a learner. Respond ONLY with valid JSON in this exact format, with no other text or markdown fences:

{
  "score": <number between 0.0 and 1.0>,
  "flagged": <true if score >= 0.7, otherwise false>,
  "reasoning": "<one-sentence explanation>",
  "level": "<low | medium | high | critical>"
}

Scoring guide:
- 0.0–0.3 (low): Normal learning content, language errors, mild frustration with study
- 0.3–0.6 (medium): Some emotional content, monitor but no immediate concern
- 0.6–0.8 (high): Distress, isolation, or concerning circumstances
- 0.8–1.0 (critical): Immediate welfare risk — domestic abuse, self-harm, exploitation, modern slavery, or mental health crisis

Focus only on welfare concerns. The learner is studying English; difficulty with the language itself is NOT a safeguarding concern. Personal information may have been redacted as [EMAIL], [PHONE], [POSTCODE] etc. — assess the underlying intent, not the redactions.`;

export const safeguardScreen = async (
  learnerInput: string
): Promise<SafeguardingResult> => {
  const anthropic = getClient();

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: [
        {
          type: "text",
          text: SAFEGUARDING_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: learnerInput }],
    });

    const text = extractText(response.content);
    const parsed = parseJsonFromResponse<SafeguardingResult>(text);

    // Defensive: clamp score and re-derive flagged
    const score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
    const flagged = score >= 0.7;
    const level: SafeguardingLevel =
      score >= 0.9
        ? "critical"
        : score >= 0.6
          ? "high"
          : score >= 0.3
            ? "medium"
            : "low";

    return {
      score,
      flagged,
      reasoning: String(parsed.reasoning || ""),
      level,
    };
  } catch (err) {
    // Fail-closed: re-throw so the caller can reject the turn rather
    // than silently let unscreened content through. Compliance-critical.
    logger.error({ err }, "Safeguarding screen failed");
    throw err;
  }
};

/* ── Turn assessment ── */

export interface AssessmentResult {
  assessment: string;
  vocabWords: string[];
  grammarFeedback: string;
  comprehensionScore: number;
}

const ASSESSMENT_SYSTEM_PROMPT = `You are an experienced ESOL teacher assessing a learner's English language performance.

The learner is at {level} level (UK ESOL framework: Entry 1, Entry 2, Entry 3, Level 1, Level 2).

You will receive the learner's input and the AI tutor's response. Assess the learner's language use and identify vocabulary the learner should add to their personal vocabulary list.

Respond ONLY with valid JSON in this exact format, with no other text or markdown fences:

{
  "assessment": "<2-3 sentence summary of the learner's language performance>",
  "vocabWords": ["<word1>", "<word2>"],
  "grammarFeedback": "<one-sentence grammar observation>",
  "comprehensionScore": <number between 0.0 and 1.0>
}

vocabWords: extract any vocabulary from the AI tutor's response that is appropriate for this learner to note, given their level. Aim for 1-3 items per turn. Return an empty array if none are noteworthy.

Be constructive and encouraging. Note progress, not just errors. Use British English.`;

export const assessTurn = async (params: {
  esolLevel: string;
  learnerInput: string;
  aiResponse: string;
}): Promise<AssessmentResult> => {
  const anthropic = getClient();

  const systemPrompt = ASSESSMENT_SYSTEM_PROMPT.replace(
    "{level}",
    params.esolLevel
  );

  const userMessage = `LEARNER INPUT:\n${params.learnerInput}\n\nAI TUTOR RESPONSE:\n${params.aiResponse}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    const text = extractText(response.content);
    const parsed = parseJsonFromResponse<AssessmentResult>(text);

    return {
      assessment: String(parsed.assessment || ""),
      vocabWords: Array.isArray(parsed.vocabWords)
        ? parsed.vocabWords.filter((w) => typeof w === "string" && w.length > 0)
        : [],
      grammarFeedback: String(parsed.grammarFeedback || ""),
      comprehensionScore: Math.max(
        0,
        Math.min(1, Number(parsed.comprehensionScore) || 0)
      ),
    };
  } catch (err) {
    logger.error({ err }, "Turn assessment failed");
    return {
      assessment: "",
      vocabWords: [],
      grammarFeedback: "",
      comprehensionScore: 0,
    };
  }
};

/* ── Teacher prep note ── */

export interface TeacherPrepInput {
  esolLevel: string;
  l1Language?: string | null;
  topic?: string | null;
  sessionMode: AISessionMode;
  recentSessionSummaries: string[];
}

const TEACHER_PREP_SYSTEM_PROMPT = `You are an ESOL teacher's assistant generating a pre-session briefing for an ESOL teacher about to deliver a consolidation session with a learner.

You will receive:
- The learner's current ESOL level
- The learner's first language (L1)
- The session topic
- The session mode (BRIDGE / ANCHOR / IMMERSION)
- Summaries of the learner's recent AI tutor sessions

Generate a concise teacher briefing in markdown format with these sections:

**Learner Snapshot**
1-2 sentences about the learner's current strengths and stage.

**Recent Progress**
Notable observations from recent sessions.

**Areas to Focus**
2-3 specific areas that would benefit from teacher attention.

**Suggested Activities**
2-3 concrete activity ideas appropriate for the level and topic.

**Watch For**
Anything to be mindful of based on past sessions (learning blocks, sensitivities, gaps).

Keep the entire briefing under 300 words. Use British English throughout.`;

export const generateTeacherPrepNote = async (
  input: TeacherPrepInput
): Promise<string> => {
  const anthropic = getClient();

  const userMessage = [
    `Learner level: ${input.esolLevel}`,
    `L1 language: ${input.l1Language ?? "Not specified"}`,
    `Topic: ${input.topic ?? "General consolidation"}`,
    `Session mode: ${input.sessionMode}`,
    "",
    "Recent session summaries:",
    input.recentSessionSummaries.length > 0
      ? input.recentSessionSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "None — this is the learner's first AI session.",
  ].join("\n");

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: TEACHER_PREP_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    return extractText(response.content);
  } catch (err) {
    logger.error({ err }, "Teacher prep note generation failed");
    throw new ApiError(500, "Could not generate teacher prep note");
  }
};

/* ── Final session summary ── */

const SESSION_SUMMARY_SYSTEM_PROMPT = `You are an ESOL teacher producing a final summary of an AI tutoring session.

You will receive a transcript of an AI tutoring session (learner inputs and tutor responses) and the per-turn assessments.

Produce a concise summary (3-5 sentences) covering:
- Overall learner engagement and language use
- Topics covered and vocabulary introduced
- Recommended focus for the next session

Use British English. Be constructive and specific.`;

export const generateSessionSummary = async (
  transcriptAndAssessments: string
): Promise<string> => {
  const anthropic = getClient();

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: [
        {
          type: "text",
          text: SESSION_SUMMARY_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: transcriptAndAssessments }],
    });

    return extractText(response.content);
  } catch (err) {
    logger.error({ err }, "Session summary generation failed");
    return "Session summary could not be generated automatically.";
  }
};
