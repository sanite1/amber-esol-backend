/**
 * F28 voice service — graceful-degradation + locale-resolution tests.
 *
 * No GCP client is exercised here: with the feature flags off (the test
 * default), every entry point must return null/false so the platform
 * falls back to text-only + tap-to-type. This is the safety contract.
 */

import {
  voiceLocaleFor,
  synthesizeSpeech,
  transcribeSpeech,
  voiceCapabilities,
} from "../services/voice.service";

describe("F28 voiceLocaleFor", () => {
  it("resolves the MVP languages to their voice locales", () => {
    expect(voiceLocaleFor("english")).toBe("en-GB");
    expect(voiceLocaleFor("arabic")).toBe("ar-XA");
    expect(voiceLocaleFor("cantonese")).toBe("yue-HK");
    expect(voiceLocaleFor("turkish")).toBe("tr-TR");
  });

  it("returns null for deferred languages (no voice contract yet)", () => {
    expect(voiceLocaleFor("somali")).toBeNull();
    expect(voiceLocaleFor("dari")).toBeNull();
  });
});

describe("F28 graceful degradation when disabled", () => {
  const prevTts = process.env.VOICE_TTS_ENABLED;
  const prevStt = process.env.VOICE_STT_ENABLED;

  beforeAll(() => {
    delete process.env.VOICE_TTS_ENABLED;
    delete process.env.VOICE_STT_ENABLED;
  });
  afterAll(() => {
    if (prevTts === undefined) delete process.env.VOICE_TTS_ENABLED;
    else process.env.VOICE_TTS_ENABLED = prevTts;
    if (prevStt === undefined) delete process.env.VOICE_STT_ENABLED;
    else process.env.VOICE_STT_ENABLED = prevStt;
  });

  it("synthesizeSpeech returns null when TTS is disabled", async () => {
    expect(await synthesizeSpeech("Hello there", "english")).toBeNull();
  });

  it("transcribeSpeech returns null when STT is disabled", async () => {
    expect(await transcribeSpeech("base64audio", "english")).toBeNull();
  });

  it("capabilities report both features off + the configured region", () => {
    const caps = voiceCapabilities();
    expect(caps.tts).toBe(false);
    expect(caps.stt).toBe(false);
    expect(typeof caps.location).toBe("string");
  });
});

describe("F28 TTS still no-ops on an unvoiced language even if enabled", () => {
  const prev = process.env.VOICE_TTS_ENABLED;
  beforeAll(() => {
    process.env.VOICE_TTS_ENABLED = "true";
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.VOICE_TTS_ENABLED;
    else process.env.VOICE_TTS_ENABLED = prev;
  });

  it("returns null for a deferred language before any client call", async () => {
    // somali has no voiceLocale → short-circuits before GCP init.
    expect(await synthesizeSpeech("Salaan", "somali")).toBeNull();
  });

  it("returns null for empty text", async () => {
    expect(await synthesizeSpeech("   ", "english")).toBeNull();
  });
});

describe("F32 VOICE_MOCK transcription", () => {
  const prevStt = process.env.VOICE_STT_ENABLED;
  const prevMock = process.env.VOICE_MOCK;
  const prevEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (prevStt === undefined) delete process.env.VOICE_STT_ENABLED;
    else process.env.VOICE_STT_ENABLED = prevStt;
    if (prevMock === undefined) delete process.env.VOICE_MOCK;
    else process.env.VOICE_MOCK = prevMock;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  });

  it("returns the canned transcript + confidences without Google when STT is on", async () => {
    process.env.VOICE_STT_ENABLED = "true";
    process.env.VOICE_MOCK = "true";
    process.env.NODE_ENV = "test";
    const r = await transcribeSpeech("AAAA", "english");
    expect(r).not.toBeNull();
    expect(r!.transcript).toBe(
      "I would like to book an appointment with the doctor please",
    );
    expect(r!.confidence).toBe(0.86);
    expect(r!.words.length).toBeGreaterThan(0);
    expect(r!.words.every((w) => typeof w.confidence === "number")).toBe(true);
  });

  it("mock is ignored when STT is disabled (mock never turns the feature on)", async () => {
    delete process.env.VOICE_STT_ENABLED;
    process.env.VOICE_MOCK = "true";
    expect(await transcribeSpeech("AAAA", "english")).toBeNull();
  });

  it("mock is ignored in production (falls through to the real path, which has no locale for somali → null)", async () => {
    process.env.VOICE_STT_ENABLED = "true";
    process.env.VOICE_MOCK = "true";
    process.env.NODE_ENV = "production";
    expect(await transcribeSpeech("AAAA", "somali")).toBeNull();
  });
});
