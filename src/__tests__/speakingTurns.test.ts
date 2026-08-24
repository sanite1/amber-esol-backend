/**
 * F32 speaking turns — processTurnService behaviour (mocked Gemini).
 *
 *   S1  voice turn blends the score 0.7 content / 0.3 pronunciation,
 *       forces Sc, persists input_mode + pronunciation + content_score,
 *       and the response carries transcript / pronunciation / turn_score
 *   S2  typed answer to a pending speaking prompt strips Sc/Sd, earns
 *       no speaking credit, and the prompt tells the tutor so
 *   S3  skill_codes_covered is a deduped union of VALID codes only
 *   S4  speaking_prompt from Gemini is persisted on the turn + returned,
 *       and getPendingSpeakingTarget reads it back
 *   S5  typed turn with no assessment stores nothing voice-ish
 *   S6  Layer 5 voice gating line follows VOICE_STT_ENABLED
 *   S7  capture-evidence payload carries inputMode / pronunciation /
 *       targetPhrase
 *   S8  persistSessionOnEnd rolls up spoken_turns + pronunciation_avg
 */

jest.mock("../lib/gemini", () => {
  const generateContent = jest.fn();
  const getGenerativeModel = jest.fn(() => ({ generateContent }));
  return {
    __esModule: true,
    MODEL_NAME: "gemini-2.5-flash",
    initGeminiClient: jest.fn(),
    geminiClient: { preview: { getGenerativeModel } },
    __mockGenerateContent: generateContent,
    __mockGetGenerativeModel: getGenerativeModel,
  };
});

jest.mock("../services/safeguardingDetector.service", () => {
  const scan = jest.fn().mockReturnValue({
    triggered: false,
    category: null,
    matched_pattern: null,
  });
  return {
    __esModule: true,
    default: { loadAll: jest.fn(), scan, __resetCacheForTests: jest.fn() },
  };
});

jest.mock("../queues", () => ({
  __esModule: true,
  esolSessionQueue: { add: jest.fn().mockResolvedValue(undefined) },
  notificationsQueue: { add: jest.fn().mockResolvedValue(undefined) },
  priorityQueueQueue: { add: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../services/ComplianceConfigService", () => ({
  __esModule: true,
  default: { getCurrent: jest.fn().mockReturnValue({ version: 1 }) },
}));

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import {
  processTurnService,
  persistSessionOnEnd,
  getPendingSpeakingTarget,
  deriveTurnSkillCodes,
  pendingSpeakingTargetFromTurns,
} from "../services/aiSession.service";
import { esolSessionQueue } from "../queues";
import { PronunciationAssessment } from "../interfaces/pronunciation.interface";

const gemini = require("../lib/gemini") as {
  __mockGenerateContent: jest.Mock;
  __mockGetGenerativeModel: jest.Mock;
};

// ── Fixtures ──────────────────────────────────────────────────────────

const createOrg = async () =>
  Organisation.create({
    name: "F32 Test College",
    slug: `f32-org-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@f32.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = async (orgId: unknown) =>
  User.create({
    firstname: "Aamina",
    lastname: "Ali",
    email: `learner-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: "e2",
    l1Language: "english",
  });

const createSession = async (
  learnerId: unknown,
  orgId: unknown,
  overrides: Record<string, unknown> = {},
) =>
  AISession.create({
    learnerId,
    orgId,
    sessionMode: "BRIDGE",
    esolLevel: "e2",
    turns: [],
    safeguardingFlagged: false,
    vocabIntroduced: [],
    session_source: "ai_tutor",
    scenario_id: "s1_gp_appointment",
    turn_scores: [],
    teaching_mode_sequence: [],
    skill_codes_covered: [],
    start_time: new Date(),
    ...overrides,
  });

const turnJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply: "Lovely — that was clear. Now, what time would you like?",
    mode: "bridge",
    skill_codes_used: ["Lr"],
    turn_score: 0.8,
    vocabulary_items_used: ["appointment"],
    safeguarding_flag: false,
    safeguarding_category: null,
    session_complete: false,
    session_summary: null,
    ...overrides,
  });

const okGemini = (json: string) => ({
  response: {
    candidates: [{ content: { parts: [{ text: json }] } }],
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 200,
      cachedContentTokenCount: 700,
    },
  },
});

const pron = (
  overrides: Partial<PronunciationAssessment> = {},
): PronunciationAssessment => ({
  score: 0.6,
  clarity: "mostly_clear",
  unclear_words: ["appointment"],
  tip_for_learner: "Try stressing the second part of 'appointment'.",
  note_for_tutor: "Mostly clear; 'appointment' slightly unclear.",
  target_phrase: null,
  method: "stt_confidence",
  ...overrides,
});

/** System prompt Gemini received on the most recent call. */
const lastSystemPrompt = (): string => {
  const calls = gemini.__mockGetGenerativeModel.mock.calls;
  const params = calls[calls.length - 1][0] as {
    systemInstruction?: { parts?: Array<{ text: string }> };
  };
  return params.systemInstruction?.parts?.[0]?.text ?? "";
};

const setup = async (sessionOverrides: Record<string, unknown> = {}) => {
  const org = await createOrg();
  const learner = await createLearner(org._id);
  const session = await createSession(learner._id, org._id, sessionOverrides);
  return {
    org,
    learner,
    session,
    ids: {
      sessionId: session._id.toString(),
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    },
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_STT_ENABLED;
  gemini.__mockGenerateContent.mockResolvedValue(okGemini(turnJson()));
});

// ── Pure helpers ──────────────────────────────────────────────────────

describe("F32 deriveTurnSkillCodes", () => {
  it("voice: forces Sc and drops drifted codes", () => {
    expect(
      deriveTurnSkillCodes({
        codes: ["Lr", "Sp", "Lr"],
        inputMode: "voice",
        pendingSpeakingTarget: null,
      }).sort(),
    ).toEqual(["Lr", "Sc"]);
  });

  it("typed with a pending target: strips Sc and Sd", () => {
    expect(
      deriveTurnSkillCodes({
        codes: ["Sc", "Sd", "Rt"],
        inputMode: "text",
        pendingSpeakingTarget: "I would like an appointment",
      }),
    ).toEqual(["Rt"]);
  });

  it("typed with no pending target: keeps Gemini's valid codes as-is", () => {
    expect(
      deriveTurnSkillCodes({
        codes: ["Sc", "Ww"],
        inputMode: "text",
        pendingSpeakingTarget: null,
      }).sort(),
    ).toEqual(["Sc", "Ww"]);
  });
});

describe("F32 pendingSpeakingTargetFromTurns", () => {
  it("reads the LAST turn's speaking_prompt only when expects_speech", () => {
    expect(pendingSpeakingTargetFromTurns(undefined)).toBeNull();
    expect(pendingSpeakingTargetFromTurns([])).toBeNull();
    expect(
      pendingSpeakingTargetFromTurns([
        { speaking_prompt: { expects_speech: true, target_phrase: "old" } },
        { speaking_prompt: null },
      ]),
    ).toBeNull();
    expect(
      pendingSpeakingTargetFromTurns([
        { speaking_prompt: { expects_speech: false, target_phrase: "x" } },
      ]),
    ).toBeNull();
    expect(
      pendingSpeakingTargetFromTurns([
        {
          speaking_prompt: {
            expects_speech: true,
            target_phrase: "  Say this  ",
          },
        },
      ]),
    ).toBe("Say this");
  });
});

// ── processTurnService ────────────────────────────────────────────────

describe("F32 processTurnService — voice turns", () => {
  it("S1 — blends 0.7/0.3, forces Sc, persists the spoken turn, returns voice fields", async () => {
    const { ids } = await setup();
    const p = pron({ score: 0.6 });

    const res = await processTurnService({
      ...ids,
      message: "I would like an appointment",
      inputMode: "voice",
      pronunciation: p,
      audioSeconds: 3.2,
    });
    const data = res.data as Record<string, unknown>;

    // 0.7 * 0.8 + 0.3 * 0.6 = 0.74
    expect(data.turn_score).toBe(0.74);
    expect(data.input_mode).toBe("voice");
    expect(data.transcript).toBe("I would like an appointment");
    expect(data.pronunciation).toEqual(p);
    expect(data.speaking_prompt).toBeNull();

    const session = await AISession.findById(ids.sessionId).lean();
    const turn = session!.turns[0];
    expect(turn.input_mode).toBe("voice");
    expect(turn.pronunciation).toEqual(p);
    expect(turn.content_score).toBe(0.8);
    expect(turn.audio_seconds).toBe(3.2);
    expect(turn.speaking_prompt).toBeNull();
    expect(session!.turn_scores).toEqual([0.74]);
    expect([...(session!.skill_codes_covered ?? [])].sort()).toEqual([
      "Lr",
      "Sc",
    ]);

    // Audio never lands on the session document.
    expect(JSON.stringify(session)).not.toMatch(/audio_base64|audioBase64/);

    // The tutor prompt saw the spoken turn + the assessment.
    const prompt = lastSystemPrompt();
    expect(prompt).toContain(
      "This turn's input was: SPOKEN (machine transcribed).",
    );
    expect(prompt).toContain("score 0.6/1 (mostly_clear)");
    expect(prompt).toContain("appointment");
  });

  it("voice turn WITHOUT an assessment keeps the content score and still forces Sc", async () => {
    const { ids } = await setup();
    const res = await processTurnService({
      ...ids,
      message: "hello",
      inputMode: "voice",
      pronunciation: null,
    });
    const data = res.data as Record<string, unknown>;
    expect(data.turn_score).toBe(0.8);
    expect(data.input_mode).toBe("voice");
    expect(data.pronunciation).toBeNull();
    const session = await AISession.findById(ids.sessionId).lean();
    expect(session!.turns[0].input_mode).toBe("voice");
    expect(session!.turns[0].pronunciation).toBeNull();
    expect(session!.skill_codes_covered).toContain("Sc");
  });
});

describe("F32 processTurnService — typed turns", () => {
  it("S2 — typed answer to a pending speaking prompt strips Sc/Sd and tells the tutor", async () => {
    const { ids } = await setup({
      turns: [
        {
          turnIndex: 0,
          originalInput: "hello",
          scrubbed: false,
          deepSeekResponse: "Please say: I would like an appointment",
          timestamp: new Date(),
          input_mode: "text",
          speaking_prompt: {
            expects_speech: true,
            target_phrase: "I would like an appointment",
          },
        },
      ],
      turn_scores: [0.7],
      teaching_mode_sequence: ["bridge"],
      skill_codes_covered: ["Lr"],
    });
    gemini.__mockGenerateContent.mockResolvedValue(
      okGemini(
        turnJson({ skill_codes_used: ["Sc", "Sd", "Rt"], turn_score: 0.9 }),
      ),
    );

    const res = await processTurnService({
      ...ids,
      message: "I would like an appointment",
      // no inputMode → typed
    });
    const data = res.data as Record<string, unknown>;
    expect(data.input_mode).toBe("text");
    expect(data.transcript).toBeUndefined();
    expect(data.pronunciation).toBeUndefined();
    expect(data.turn_score).toBe(0.9);

    const session = await AISession.findById(ids.sessionId).lean();
    expect([...(session!.skill_codes_covered ?? [])].sort()).toEqual([
      "Lr",
      "Rt",
    ]);
    expect(session!.turns[1].input_mode).toBe("text");
    expect(session!.turns[1].pronunciation).toBeNull();
    expect(session!.turn_scores).toEqual([0.7, 0.9]);

    const prompt = lastSystemPrompt();
    expect(prompt).toContain("This turn's input was: TYPED.");
    expect(prompt).toContain(
      'You asked the learner to say "I would like an appointment" aloud but they typed instead.',
    );
    expect(prompt).toContain("Do not award speaking credit.");
  });

  it("S3 — skill_codes_covered is a deduped union of valid codes only", async () => {
    const { ids } = await setup({ skill_codes_covered: ["Lr", "Bogus"] });
    gemini.__mockGenerateContent.mockResolvedValue(
      okGemini(turnJson({ skill_codes_used: ["Lr", "Sc", "Sp", "Rt"] })),
    );
    await processTurnService({
      ...ids,
      message: "I would like an appointment",
    });
    const session = await AISession.findById(ids.sessionId).lean();
    expect([...(session!.skill_codes_covered ?? [])].sort()).toEqual([
      "Lr",
      "Rt",
      "Sc",
    ]);
  });

  it("S4 — Gemini's speaking_prompt is persisted + returned and read back as the pending target", async () => {
    const { ids } = await setup();
    gemini.__mockGenerateContent.mockResolvedValue(
      okGemini(
        turnJson({
          speaking_prompt: {
            expects_speech: true,
            target_phrase: "  Can I book an appointment?  ",
          },
        }),
      ),
    );
    const res = await processTurnService({ ...ids, message: "hi" });
    const data = res.data as Record<string, unknown>;
    expect(data.speaking_prompt).toEqual({
      expects_speech: true,
      target_phrase: "Can I book an appointment?",
    });
    const session = await AISession.findById(ids.sessionId).lean();
    expect(session!.turns[0].speaking_prompt).toEqual({
      expects_speech: true,
      target_phrase: "Can I book an appointment?",
    });

    const pending = await getPendingSpeakingTarget(
      ids.sessionId,
      ids.learnerId,
    );
    expect(pending).toEqual({
      targetPhrase: "Can I book an appointment?",
      esolLevel: "e2",
    });

    // Ownership: another learner reads nothing.
    const other = await getPendingSpeakingTarget(
      ids.sessionId,
      new Types.ObjectId().toString(),
    );
    expect(other).toEqual({ targetPhrase: null, esolLevel: null });
  });

  it("S5 — a plain typed turn stores text mode and null voice fields", async () => {
    const { ids } = await setup();
    const res = await processTurnService({ ...ids, message: "hello there" });
    const data = res.data as Record<string, unknown>;
    expect(data.input_mode).toBe("text");
    expect(data.turn_score).toBe(0.8);
    expect(data.speaking_prompt).toBeNull();
    const session = await AISession.findById(ids.sessionId).lean();
    const turn = session!.turns[0];
    expect(turn.input_mode).toBe("text");
    expect(turn.pronunciation).toBeNull();
    expect(turn.speaking_prompt).toBeNull();
    expect(turn.content_score).toBe(0.8);
    expect(turn.audio_seconds).toBeNull();
    expect(session!.turn_scores).toEqual([0.8]);
  });

  it("S6 — Layer 5 voice gating follows VOICE_STT_ENABLED", async () => {
    const a = await setup();
    await processTurnService({ ...a.ids, message: "hello" });
    expect(lastSystemPrompt()).toContain("Voice input available: no.");
    expect(lastSystemPrompt()).toContain(
      "Never ask the learner to say or repeat anything aloud",
    );

    process.env.VOICE_STT_ENABLED = "true";
    const b = await setup();
    await processTurnService({ ...b.ids, message: "hello" });
    expect(lastSystemPrompt()).toContain("Voice input available: yes.");
    expect(lastSystemPrompt()).toContain(
      "set speaking_prompt.expects_speech=true",
    );
  });

  it("S7 — capture-evidence payload carries inputMode / pronunciation / targetPhrase", async () => {
    const { ids } = await setup({
      turns: [
        {
          turnIndex: 0,
          originalInput: "hello",
          scrubbed: false,
          deepSeekResponse: "Say: good morning",
          timestamp: new Date(),
          speaking_prompt: {
            expects_speech: true,
            target_phrase: "good morning",
          },
        },
      ],
    });
    const p = pron({
      score: 0.9,
      clarity: "clear",
      target_phrase: "good morning",
    });
    await processTurnService({
      ...ids,
      message: "good morning",
      inputMode: "voice",
      pronunciation: p,
    });
    const add = esolSessionQueue.add as jest.Mock;
    const evidenceCall = add.mock.calls.find(
      (c) => c[0] === "capture-evidence",
    );
    expect(evidenceCall).toBeDefined();
    const payload = evidenceCall![1].payload;
    expect(payload.inputMode).toBe("voice");
    expect(payload.pronunciation).toEqual(p);
    expect(payload.targetPhrase).toBe("good morning");
    expect(payload.skillCodesUsed).toContain("Sc");
    // 0.7*0.8 + 0.3*0.9 = 0.83
    expect(payload.turnScore).toBe(0.83);
  });
});

describe("F32 persistSessionOnEnd rollups", () => {
  it("S8 — counts spoken turns and averages pronunciation scores", async () => {
    const { ids } = await setup({
      turns: [
        {
          turnIndex: 0,
          originalInput: "a",
          scrubbed: false,
          deepSeekResponse: "b",
          timestamp: new Date(),
          input_mode: "voice",
          pronunciation: pron({ score: 0.8 }),
        },
        {
          turnIndex: 1,
          originalInput: "c",
          scrubbed: false,
          deepSeekResponse: "d",
          timestamp: new Date(),
          input_mode: "text",
          pronunciation: null,
        },
        {
          turnIndex: 2,
          originalInput: "e",
          scrubbed: false,
          deepSeekResponse: "f",
          timestamp: new Date(),
          input_mode: "voice",
          pronunciation: pron({ score: 0.6 }),
        },
      ],
      turn_scores: [0.8, 0.7, 0.6],
    });
    await persistSessionOnEnd(ids.sessionId);
    const session = await AISession.findById(ids.sessionId).lean();
    expect(session!.spoken_turns).toBe(2);
    expect(session!.pronunciation_avg).toBe(0.7);
  });

  it("leaves pronunciation_avg null when nothing was spoken", async () => {
    const { ids } = await setup({
      turns: [
        {
          turnIndex: 0,
          originalInput: "a",
          scrubbed: false,
          deepSeekResponse: "b",
          timestamp: new Date(),
        },
      ],
      turn_scores: [0.8],
    });
    await persistSessionOnEnd(ids.sessionId);
    const session = await AISession.findById(ids.sessionId).lean();
    expect(session!.spoken_turns).toBe(0);
    expect(session!.pronunciation_avg).toBeNull();
  });
});
