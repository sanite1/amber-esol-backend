import OpenAI from "openai";
import ApiError from "../errors/apiError";
import logger from "../config/logger";
import { AISessionMode } from "../interfaces/aiSession.interface";

const MODEL = "deepseek-chat";

let client: OpenAI | null = null;

const getClient = (): OpenAI => {
  if (client) return client;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseURL = process.env.DEEPSEEK_BASE_URL;
  if (!apiKey || !baseURL) {
    throw new ApiError(500, "DeepSeek API is not configured");
  }
  client = new OpenAI({ apiKey, baseURL });
  return client;
};

const buildSystemPrompt = (params: {
  sessionMode: AISessionMode;
  esolLevel: string;
  l1Language?: string | null;
  topic?: string | null;
}): string => {
  const level = params.esolLevel;
  const topic = params.topic ?? "general English conversation";
  const l1 = params.l1Language ?? "their first language";

  switch (params.sessionMode) {
    case "BRIDGE":
      return `You are an ESOL English tutor helping a learner at ${level} level. The learner's first language is ${l1}.

Use clear, simple English appropriate for their level. You may occasionally use brief phrases in ${l1} to clarify difficult concepts, but keep responses primarily in English (around 80% English). Use British English spelling and grammar.

Be encouraging and patient. Current topic: ${topic}.

Keep responses to 2-3 sentences maximum. Always end with one short follow-up question to encourage the learner to continue practising.`;

    case "ANCHOR":
      return `You are an ESOL English tutor focused on vocabulary development. The learner is at ${level} level.

In each response, naturally introduce or reinforce 1-2 key vocabulary items appropriate for this level. Use the new words in clear, simple sentences so the learner sees them in context. Use British English spelling and grammar.

Current topic: ${topic}.

Keep responses brief (2-3 sentences). End with one short question that invites the learner to use the new vocabulary.`;

    case "IMMERSION":
      return `You are an ESOL English tutor. Respond entirely in English — do not use the learner's first language at all.

The learner is at ${level} level. Use simple, clear language appropriate for this level. Use British English spelling and grammar. Encourage the learner to express themselves in English.

Current topic: ${topic}.

Keep responses to 2-3 sentences. Always end with one short follow-up question to keep the conversation flowing.`;
  }
};

export interface DialogueHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export const generateDialogue = async (params: {
  sessionMode: AISessionMode;
  esolLevel: string;
  l1Language?: string | null;
  topic?: string | null;
  history: DialogueHistoryEntry[];
  scrubbedInput: string;
}): Promise<string> => {
  const openai = getClient();

  const systemPrompt = buildSystemPrompt({
    sessionMode: params.sessionMode,
    esolLevel: params.esolLevel,
    l1Language: params.l1Language,
    topic: params.topic,
  });

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...params.history.map((h) => ({
      role: h.role,
      content: h.content,
    })),
    { role: "user", content: params.scrubbedInput },
  ];

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      max_tokens: 256,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content;
    if (!reply) {
      throw new ApiError(500, "DeepSeek returned an empty response");
    }
    return reply.trim();
  } catch (err) {
    logger.error({ err }, "DeepSeek dialogue generation failed");
    throw new ApiError(502, "AI tutor is temporarily unavailable. Please try again.");
  }
};
