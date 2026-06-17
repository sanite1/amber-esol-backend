/**
 * Safeguarding detector — multilingual coverage (F22 hardening).
 *
 * Pins two properties the Phase 1 hardening fixed:
 *   1. The learner's raw L1 ("turkish", "Cantonese", "fa-AF") is
 *      normalised so the right pattern bank is consulted — non-English
 *      learners no longer silently fall back to English-only detection.
 *   2. The English bank is ALWAYS scanned alongside the L1 bank, because
 *      learners practise in English — an English-language disclosure
 *      from a Turkish learner must still trigger.
 *
 * Uses the shared in-memory Mongo (setup.ts); seeds a minimal pattern
 * set rather than the production JSON so the assertions are stable.
 */
import SafeguardingKeyword from "../models/SafeguardingKeyword";
import SafeguardingDetector from "../services/safeguardingDetector.service";

describe("SafeguardingDetector — multilingual", () => {
  beforeAll(async () => {
    await SafeguardingKeyword.deleteMany({});
    await SafeguardingKeyword.create([
      {
        language: "en",
        pattern: "want to die",
        category: "self_harm",
        severity: "high",
        active: true,
      },
      {
        language: "tr",
        pattern: "ölmek istiyorum",
        category: "self_harm",
        severity: "high",
        active: true,
      },
      {
        language: "yue",
        pattern: "我想死",
        category: "self_harm",
        severity: "high",
        active: true,
      },
    ]);
    await SafeguardingDetector.loadAll();
  });

  it("fires on an L1 disclosure (Turkish), with raw L1 normalisation", () => {
    expect(
      SafeguardingDetector.scan("ölmek istiyorum", "turkish").triggered,
    ).toBe(true);
    // code form resolves the same bank
    expect(SafeguardingDetector.scan("ölmek istiyorum", "tr").triggered).toBe(
      true,
    );
  });

  it("fires on an L1 disclosure (Cantonese) from raw 'Cantonese'", () => {
    expect(SafeguardingDetector.scan("我想死", "Cantonese").triggered).toBe(
      true,
    );
  });

  it("ALWAYS scans English too — English disclosure from an L1 learner triggers", () => {
    const r = SafeguardingDetector.scan("i want to die", "turkish");
    expect(r.triggered).toBe(true);
    expect(r.category).toBe("self_harm");
  });

  it("does not fire on a benign message", () => {
    expect(
      SafeguardingDetector.scan("hello how are you today", "turkish").triggered,
    ).toBe(false);
  });

  it("unknown L1 still gets English coverage", () => {
    expect(
      SafeguardingDetector.scan("i want to die", "klingon").triggered,
    ).toBe(true);
  });
});
