/**
 * F32 pronunciation service tests — pure scoring maths + the mock path.
 *
 * No Gemini client is exercised: the fallback (`stt_confidence`) and
 * mock (`VOICE_MOCK`) paths never touch Vertex, and the primary path is
 * driven through a jest mock of ../lib/gemini so we can prove both the
 * success shape and the fail-safe fallback when Gemini blows up.
 */

jest.mock("../lib/gemini", () => {
  const generateContent = jest.fn();
  return {
    __esModule: true,
    MODEL_NAME: "gemini-2.5-flash",
    initGeminiClient: jest.fn(),
    geminiClient: {
      preview: {
        getGenerativeModel: jest.fn(() => ({ generateContent })),
      },
    },
    __mockGenerateContent: generateContent,
  };
});

import { Types } from "mongoose";
import AIUsage from "../models/AIUsage";
import {
  assessFromSttConfidence,
  assessPronunciation,
  clamp01,
  round2,
  tokenOverlap,
  tokenize,
} from "../services/pronunciation.service";
import { clarityFromScore } from "../interfaces/pronunciation.interface";

const mockGenerateContent = (
  require("../lib/gemini") as { __mockGenerateContent: jest.Mock }
).__mockGenerateContent;

const tracking = () => ({
  sessionId: new Types.ObjectId().toString(),
  orgId: new Types.ObjectId().toString(),
  learnerId: new Types.ObjectId().toString(),
});

const words = (pairs: Array<[string, number]>) =>
  pairs.map(([word, confidence]) => ({ word, confidence }));

afterEach(() => {
  delete process.env.VOICE_MOCK;
  jest.clearAllMocks();
});

describe("F32 pronunciation helpers", () => {
  it("tokenize lowercases and strips punctuation", () => {
    expect(tokenize("I'd like an Appointment, please!")).toEqual([
      "i'd",
      "like",
      "an",
      "appointment",
      "please",
    ]);
    expect(tokenize("")).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });

  it("tokenOverlap is the fraction of target tokens present in the transcript", () => {
    expect(
      tokenOverlap(
        "I would like an appointment",
        "I would like an appointment",
      ),
    ).toBe(1);
    expect(
      tokenOverlap("I would like", "I would like an appointment"),
    ).toBeCloseTo(0.6);
    expect(tokenOverlap("hello", "good morning")).toBe(0);
    expect(tokenOverlap("anything", null)).toBe(1);
    expect(tokenOverlap("anything", "   ")).toBe(1);
  });

  it("clamp01 + round2 behave", () => {
    expect(clamp01(1.7)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(NaN)).toBe(0);
    expect(round2(0.123456)).toBe(0.12);
    expect(round2(0.125)).toBe(0.13);
  });

  it("clarity buckets: >= 0.75 clear, >= 0.5 mostly_clear, else unclear", () => {
    expect(clarityFromScore(0.75)).toBe("clear");
    expect(clarityFromScore(0.9)).toBe("clear");
    expect(clarityFromScore(0.5)).toBe("mostly_clear");
    expect(clarityFromScore(0.74)).toBe("mostly_clear");
    expect(clarityFromScore(0.49)).toBe("unclear");
    expect(clarityFromScore(0)).toBe("unclear");
  });
});

describe("F32 assessFromSttConfidence (fallback scoring)", () => {
  it("without a target: score is the mean word confidence", () => {
    const a = assessFromSttConfidence({
      transcript: "I would like an appointment",
      sttConfidence: 0.3,
      words: words([
        ["I", 0.9],
        ["would", 0.8],
        ["like", 0.7],
        ["an", 0.6],
        ["appointment", 0.5],
      ]),
      targetPhrase: null,
    });
    expect(a.method).toBe("stt_confidence");
    expect(a.score).toBe(0.7);
    expect(a.clarity).toBe("mostly_clear");
    expect(a.unclear_words).toEqual(["appointment"]);
    expect(a.target_phrase).toBeNull();
    expect(a.tip_for_learner.length).toBeGreaterThan(0);
    expect(a.note_for_tutor.length).toBeGreaterThan(0);
  });

  it("with a target: 0.5 * avg confidence + 0.5 * token overlap", () => {
    const a = assessFromSttConfidence({
      transcript: "I would like",
      sttConfidence: null,
      words: words([
        ["I", 0.8],
        ["would", 0.8],
        ["like", 0.8],
      ]),
      targetPhrase: "I would like an appointment",
    });
    // 0.5*0.8 + 0.5*0.6 = 0.7
    expect(a.score).toBe(0.7);
    expect(a.target_phrase).toBe("I would like an appointment");
    // Missing target tokens are reported as unclear.
    expect(a.unclear_words).toEqual(["an", "appointment"]);
  });

  it("falls back to the utterance confidence when there are no word confidences", () => {
    const a = assessFromSttConfidence({
      transcript: "hello there",
      sttConfidence: 0.9,
      words: [],
      targetPhrase: null,
    });
    expect(a.score).toBe(0.9);
    expect(a.clarity).toBe("clear");
    expect(a.unclear_words).toEqual([]);
  });

  it("falls back to 0.6 when no confidence is available at all", () => {
    const a = assessFromSttConfidence({
      transcript: "hello there",
      sttConfidence: null,
      words: [],
      targetPhrase: null,
    });
    expect(a.score).toBe(0.6);
    expect(a.clarity).toBe("mostly_clear");
  });

  it("clamps out-of-range confidences and caps unclear words at 5", () => {
    const a = assessFromSttConfidence({
      transcript: "",
      sttConfidence: null,
      words: words([
        ["a", 1.7],
        ["b", 0.1],
        ["c", 0.1],
        ["d", 0.1],
        ["e", 0.1],
        ["f", 0.1],
        ["g", 0.1],
      ]),
      targetPhrase: "one two three four five six seven",
    });
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(1);
    expect(a.unclear_words.length).toBe(5);
  });

  it("a perfect match on the target scores 1 and is clear", () => {
    const a = assessFromSttConfidence({
      transcript: "Can I book an appointment",
      sttConfidence: null,
      words: words([
        ["Can", 1],
        ["I", 1],
        ["book", 1],
        ["an", 1],
        ["appointment", 1],
      ]),
      targetPhrase: "Can I book an appointment?",
    });
    expect(a.score).toBe(1);
    expect(a.clarity).toBe("clear");
    expect(a.unclear_words).toEqual([]);
  });
});

describe("F32 assessPronunciation", () => {
  it("returns the canned mock when VOICE_MOCK=true (no Gemini call)", async () => {
    process.env.VOICE_MOCK = "true";
    const a = await assessPronunciation({
      audioBase64: "AAAA",
      mimeType: "audio/webm",
      transcript: "I would like to book an appointment with the doctor please",
      sttConfidence: 0.86,
      words: [],
      targetPhrase: "book an appointment",
      esolLevel: "e2",
      tracking: tracking(),
    });
    expect(a).toEqual({
      score: 0.82,
      clarity: "clear",
      unclear_words: ["appointment"],
      tip_for_learner:
        "Nice and clear. Try stressing the second part of 'appointment'.",
      note_for_tutor: "Spoken turn was clear; 'appointment' slightly unclear.",
      target_phrase: "book an appointment",
      method: "mock",
    });
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("returns null when there is nothing to assess (no transcript, no audio)", async () => {
    const a = await assessPronunciation({
      audioBase64: "",
      mimeType: "audio/webm",
      transcript: "   ",
      sttConfidence: null,
      words: [],
      targetPhrase: null,
      esolLevel: null,
      tracking: tracking(),
    });
    expect(a).toBeNull();
  });

  it("uses Gemini audio when it succeeds, clamps the score and records AIUsage", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    score: 1.4,
                    clarity: "clear",
                    unclear_words: ["Appointment.", "appointment", "the"],
                    tip_for_learner: "Lovely and clear — keep that pace.",
                    note_for_tutor: "Clear turn; 'appointment' a touch soft.",
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 60 },
      },
    });
    const t = tracking();
    const a = await assessPronunciation({
      audioBase64: "AAAA",
      mimeType: "audio/webm",
      transcript: "I would like an appointment",
      sttConfidence: 0.5,
      words: [],
      targetPhrase: "I would like an appointment",
      esolLevel: "e2",
      tracking: t,
    });
    expect(a).not.toBeNull();
    expect(a!.method).toBe("gemini_audio");
    expect(a!.score).toBe(1);
    expect(a!.clarity).toBe("clear");
    expect(a!.unclear_words).toEqual(["appointment", "the"]);
    expect(a!.target_phrase).toBe("I would like an appointment");

    // The audio went inline as the first part of one user message.
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.contents[0].role).toBe("user");
    expect(call.contents[0].parts[0].inlineData).toEqual({
      mimeType: "audio/webm",
      data: "AAAA",
    });
    expect(typeof call.contents[0].parts[1].text).toBe("string");

    // AIUsage row (fire-and-forget) — poll briefly rather than racing it.
    let rows: Array<{ model_name: string }> = [];
    for (let i = 0; i < 40 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      rows = await AIUsage.find({ session_id: t.sessionId }).lean();
    }
    expect(rows.length).toBe(1);
    expect(rows[0].model_name).toBe("gemini-2.5-flash");
  });

  it("falls back to stt_confidence when Gemini throws (fail safe, never throws)", async () => {
    mockGenerateContent.mockRejectedValueOnce(new Error("boom"));
    const a = await assessPronunciation({
      audioBase64: "AAAA",
      mimeType: "audio/webm",
      transcript: "hello",
      sttConfidence: 0.8,
      words: [],
      targetPhrase: null,
      esolLevel: "e1",
      tracking: tracking(),
    });
    expect(a).not.toBeNull();
    expect(a!.method).toBe("stt_confidence");
    expect(a!.score).toBe(0.8);
  });

  it("falls back to stt_confidence when Gemini returns unparseable JSON", async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        candidates: [{ content: { parts: [{ text: "not json" }] } }],
      },
    });
    const a = await assessPronunciation({
      audioBase64: "AAAA",
      mimeType: "audio/webm",
      transcript: "hello",
      sttConfidence: null,
      words: words([["hello", 0.4]]),
      targetPhrase: null,
      esolLevel: null,
      tracking: tracking(),
    });
    expect(a!.method).toBe("stt_confidence");
    expect(a!.score).toBe(0.4);
    expect(a!.clarity).toBe("unclear");
    expect(a!.unclear_words).toEqual(["hello"]);
  });
});
