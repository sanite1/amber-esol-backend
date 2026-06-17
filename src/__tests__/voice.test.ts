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
