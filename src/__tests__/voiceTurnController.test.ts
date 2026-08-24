/**
 * F32 POST /api/esol/session/turn-voice controller tests.
 *
 *   V1  STT disabled            → 200 { available: false }, nothing else runs
 *   V2  nothing heard           → 200 { available: true, heard: false }, no turn consumed
 *   V3  heard                   → pending target + assessment + processTurnService(voice)
 *   V4  oversized audio         → 400, no STT call
 *   V5  invalid session_id      → 400
 *
 * The voice + pronunciation + turn services are mocked — this suite is
 * about the controller's fail-safe branching, not the pipeline.
 */

jest.mock("../services/voice.service", () => ({
  __esModule: true,
  voiceCapabilities: jest.fn(),
  transcribeSpeech: jest.fn(),
  synthesizeSpeech: jest.fn(),
  voiceMockEnabled: jest.fn(() => false),
}));

jest.mock("../services/pronunciation.service", () => ({
  __esModule: true,
  assessPronunciation: jest.fn(),
}));

jest.mock("../services/aiSession.service", () => ({
  __esModule: true,
  processTurnService: jest.fn(),
  startSessionService: jest.fn(),
  endSessionService: jest.fn(),
  getPendingSpeakingTarget: jest.fn(),
}));

jest.mock("../services/rarpa.service", () => ({
  __esModule: true,
  buildStage3NegotiationScript: jest.fn(() => ""),
}));

import { Types } from "mongoose";
import ApiResponse from "../errors/apiResponse";
import { processVoiceTurn } from "../controllers/aiSession.controller";
import { transcribeSpeech, voiceCapabilities } from "../services/voice.service";
import { assessPronunciation } from "../services/pronunciation.service";
import {
  getPendingSpeakingTarget,
  processTurnService,
} from "../services/aiSession.service";

const mockCaps = voiceCapabilities as jest.Mock;
const mockStt = transcribeSpeech as jest.Mock;
const mockAssess = assessPronunciation as jest.Mock;
const mockPending = getPendingSpeakingTarget as jest.Mock;
const mockTurn = processTurnService as jest.Mock;

const learnerId = new Types.ObjectId().toString();
const orgId = new Types.ObjectId().toString();
const sessionId = new Types.ObjectId().toString();

const makeReq = (body: Record<string, unknown>) =>
  ({
    body,
    user: { id: learnerId },
    esol_context: { org_id: orgId },
  }) as any;

const makeRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const run = async (body: Record<string, unknown>) => {
  const req = makeReq(body);
  const res = makeRes();
  const next = jest.fn();
  await processVoiceTurn(req, res, next);
  return { res, next };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCaps.mockReturnValue({ tts: false, stt: true, location: "europe-west4" });
  mockPending.mockResolvedValue({ targetPhrase: null, esolLevel: "e2" });
  mockAssess.mockResolvedValue(null);
});

describe("F32 processVoiceTurn", () => {
  it("V1 — STT disabled → available:false, no transcription, no turn", async () => {
    mockCaps.mockReturnValue({
      tts: false,
      stt: false,
      location: "europe-west4",
    });
    const { res, next } = await run({
      session_id: sessionId,
      audio_base64: "AAAA",
    });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0] as ApiResponse;
    expect(body.data).toEqual({ available: false });
    expect(mockStt).not.toHaveBeenCalled();
    expect(mockTurn).not.toHaveBeenCalled();
  });

  it("V2 — nothing heard → heard:false, no turn consumed", async () => {
    mockStt.mockResolvedValue(null);
    const { res, next } = await run({
      session_id: sessionId,
      audio_base64: "AAAA",
    });
    expect(next).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0] as ApiResponse;
    expect(body.data).toEqual({ available: true, heard: false });
    expect(mockAssess).not.toHaveBeenCalled();
    expect(mockTurn).not.toHaveBeenCalled();

    // Whitespace-only transcript counts as not heard too.
    mockStt.mockResolvedValue({
      transcript: "   ",
      confidence: null,
      words: [],
    });
    const second = await run({ session_id: sessionId, audio_base64: "AAAA" });
    expect((second.res.json.mock.calls[0][0] as ApiResponse).data).toEqual({
      available: true,
      heard: false,
    });
    expect(mockTurn).not.toHaveBeenCalled();
  });

  it("V3 — heard → assesses against the pending target and runs a voice turn", async () => {
    mockStt.mockResolvedValue({
      transcript: "I would like an appointment",
      confidence: 0.9,
      words: [{ word: "appointment", confidence: 0.7 }],
    });
    mockPending.mockResolvedValue({
      targetPhrase: "I would like an appointment",
      esolLevel: "e1",
    });
    const assessment = {
      score: 0.8,
      clarity: "clear",
      unclear_words: [],
      tip_for_learner: "Nice and clear.",
      note_for_tutor: "Clear.",
      target_phrase: "I would like an appointment",
      method: "stt_confidence",
    };
    mockAssess.mockResolvedValue(assessment);
    mockTurn.mockResolvedValue(
      new ApiResponse(200, "Turn processed", {
        reply: "Lovely.",
        mode: "bridge",
        session_complete: false,
        vocab_words_seen: [],
        input_mode: "voice",
        transcript: "I would like an appointment",
        pronunciation: assessment,
        speaking_prompt: null,
        turn_score: 0.8,
      }),
    );

    const { res, next } = await run({
      session_id: sessionId,
      audio_base64: "AAAA",
      mime_type: "audio/webm;codecs=opus",
      audio_seconds: 2.5,
      language: "english",
    });
    expect(next).not.toHaveBeenCalled();

    expect(mockStt).toHaveBeenCalledWith("AAAA", "english", {
      encoding: "WEBM_OPUS",
      sampleRateHertz: 48000,
    });
    expect(mockPending).toHaveBeenCalledWith(sessionId, learnerId);
    expect(mockAssess).toHaveBeenCalledWith(
      expect.objectContaining({
        audioBase64: "AAAA",
        mimeType: "audio/webm;codecs=opus",
        transcript: "I would like an appointment",
        sttConfidence: 0.9,
        words: [{ word: "appointment", confidence: 0.7 }],
        targetPhrase: "I would like an appointment",
        esolLevel: "e1",
        tracking: { sessionId, orgId, learnerId },
      }),
    );
    expect(mockTurn).toHaveBeenCalledWith({
      sessionId,
      message: "I would like an appointment",
      learnerId,
      orgId,
      inputMode: "voice",
      pronunciation: assessment,
      audioSeconds: 2.5,
    });

    const body = res.json.mock.calls[0][0] as ApiResponse;
    expect(body.data).toMatchObject({
      available: true,
      heard: true,
      reply: "Lovely.",
      input_mode: "voice",
      transcript: "I would like an appointment",
      pronunciation: assessment,
      turn_score: 0.8,
    });
  });

  it("V4 — oversized audio_base64 → 400 before any STT call", async () => {
    const { res, next } = await run({
      session_id: sessionId,
      audio_base64: "a".repeat(4_000_001),
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(mockStt).not.toHaveBeenCalled();
  });

  it("V5 — invalid session_id → 400", async () => {
    const { next } = await run({ session_id: "nope", audio_base64: "AAAA" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(mockStt).not.toHaveBeenCalled();
  });
});
