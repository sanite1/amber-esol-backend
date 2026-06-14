/**
 * Unit tests for the safeguarding-messages loader — Function 10 To-Do 2.
 *
 *   M1   loadSafeguardingMessage returns the English message when
 *        translations are empty (current state pre Step 3 sign-off)
 *   M2   Returns the L1-translated message when the slot is filled
 *   M3   Falls back English when the bank has no slot for the language
 *   M4   Falls back to mental_health_crisis when category is unrecognised
 *   M5   mapL1ToLanguageCode handles the wizard's free-text variants
 *   M6   mapCategoryToBankKey bridges Gemini's `child_protection` to
 *        the brief's `child_concern`
 *   M7   Integration: the keyword-triggered safeguarding alert carries
 *        the SHA-256 of the original message + the trigger category
 */

import { createHash } from "crypto";
import {
  loadSafeguardingMessage,
  mapL1ToLanguageCode,
  mapCategoryToBankKey,
  __reloadSafeguardingBankForTests,
} from "../services/safeguardingMessages.service";

// ─────────────────────────────────────────────────────────────────────
// M5 — L1 mapping (pure)
// ─────────────────────────────────────────────────────────────────────

describe("mapL1ToLanguageCode", () => {
  it("M5 — wizard variants map to the 5 bank codes; Pashto degrades to fa", () => {
    expect(mapL1ToLanguageCode("english")).toBe("en");
    expect(mapL1ToLanguageCode("English")).toBe("en");
    expect(mapL1ToLanguageCode("en")).toBe("en");
    expect(mapL1ToLanguageCode("arabic")).toBe("ar");
    expect(mapL1ToLanguageCode("Somali")).toBe("so");
    expect(mapL1ToLanguageCode("dari")).toBe("fa");
    expect(mapL1ToLanguageCode("farsi")).toBe("fa");
    expect(mapL1ToLanguageCode("pashto")).toBe("fa"); // degrade — see brief
    expect(mapL1ToLanguageCode("cantonese")).toBe("zh");
    expect(mapL1ToLanguageCode("Mandarin")).toBe("zh");
    expect(mapL1ToLanguageCode(undefined)).toBe("en");
    expect(mapL1ToLanguageCode("")).toBe("en");
    expect(mapL1ToLanguageCode("klingon")).toBe("en");
  });
});

// ─────────────────────────────────────────────────────────────────────
// M6 — Category bridging (pure)
// ─────────────────────────────────────────────────────────────────────

describe("mapCategoryToBankKey", () => {
  it("M6 — Gemini's child_protection collapses onto the brief's child_concern", () => {
    expect(mapCategoryToBankKey("child_protection")).toBe("child_concern");
    expect(mapCategoryToBankKey("child_concern")).toBe("child_concern");
    expect(mapCategoryToBankKey("self_harm")).toBe("self_harm");
    expect(mapCategoryToBankKey("domestic_abuse")).toBe("domestic_abuse");
    expect(mapCategoryToBankKey("radicalisation")).toBe("radicalisation");
    expect(mapCategoryToBankKey("exploitation")).toBe("exploitation");
    expect(mapCategoryToBankKey("mental_health_crisis")).toBe(
      "mental_health_crisis",
    );
    expect(mapCategoryToBankKey(null)).toBeNull();
    expect(mapCategoryToBankKey("not_a_category")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// M1 / M2 / M3 / M4 — Lookup with fallback chain
// ─────────────────────────────────────────────────────────────────────

describe("loadSafeguardingMessage", () => {
  beforeAll(() => {
    __reloadSafeguardingBankForTests();
  });

  it("M1 — falls back to English when the L1 slot is empty (current bank state)", () => {
    // The current safeguarding-messages.json has empty `ar` for every
    // category — translators haven't run yet. Until Step 5 sign-off,
    // the loader serves English.
    const reply = loadSafeguardingMessage("self_harm", "arabic");
    expect(reply).toMatch(/Samaritans/);
    expect(reply).toMatch(/116 123/);
  });

  it("M2 — returns the L1-translated string when the slot is filled (per-category check)", () => {
    const en = loadSafeguardingMessage("domestic_abuse", "english");
    expect(en).toMatch(/National Domestic Abuse Helpline/);
    expect(en).toMatch(/0808 2000 247/);
  });

  it("M3 — Pashto request goes through the fa slot (degraded mapping)", () => {
    // Pashto → fa per mapL1ToLanguageCode. fa slot is empty → falls
    // back to English. Result: the same English string self_harm[en]
    // serves both `english` and `pashto` inputs until translators run.
    const pashto = loadSafeguardingMessage("self_harm", "pashto");
    const english = loadSafeguardingMessage("self_harm", "english");
    expect(pashto).toBe(english);
  });

  it("M4 — unrecognised category falls back to mental_health_crisis English", () => {
    const reply = loadSafeguardingMessage(
      "not_a_real_category" as never,
      "english",
    );
    expect(reply).toMatch(/NHS 111|SHOUT/);
  });

  it("M4.b — null category also resolves to a safe English string", () => {
    const reply = loadSafeguardingMessage(null, null);
    expect(reply.length).toBeGreaterThan(40);
    // Either bank's mental_health_crisis or the LAST_RESORT_EN —
    // both contain "Samaritans" or "NHS 111".
    expect(reply).toMatch(/Samaritans|NHS|Help is available/i);
  });

  it("M2.b — radicalisation message stays neutral (no external helpline)", () => {
    const reply = loadSafeguardingMessage("radicalisation", "english");
    // Per the brief: NO direct external phone for this category — DSL
    // handles the referral via the alert.
    expect(reply).not.toMatch(/\d{4}\s?\d{4}\s?\d{3,4}/); // no UK helpline pattern
    expect(reply).toMatch(/note|in touch|someone/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M7 — Integration: SafeguardingAlert carries SHA-256 + category
// ─────────────────────────────────────────────────────────────────────

describe("processTurnService — alert payload (Function 10 To-Do 2 spec)", () => {
  beforeAll(() => {
    process.env.REFERRAL_JWT_SECRET =
      process.env.REFERRAL_JWT_SECRET ?? "test-secret";
  });

  // Heavy mocks to keep the test self-contained
  let processTurnService: typeof import("../services/aiSession.service").processTurnService;
  let Organisation: typeof import("../models/Organisation").default;
  let User: typeof import("../models/User").default;
  let AISession: typeof import("../models/AISession").default;
  let SafeguardingAlert: typeof import("../models/SafeguardingAlert").default;
  let SafeguardingKeyword: typeof import("../models/SafeguardingKeyword").default;
  let SafeguardingDetector: typeof import("../services/safeguardingDetector.service").default;
  let Types: typeof import("mongoose").Types;

  beforeAll(async () => {
    jest.doMock("../lib/gemini", () => ({
      __esModule: true,
      MODEL_NAME: "gemini-2.5-flash",
      initGeminiClient: jest.fn(),
      geminiClient: {
        preview: {
          getGenerativeModel: jest.fn(() => ({
            generateContent: jest.fn(),
          })),
        },
      },
    }));
    jest.doMock("../queues", () => ({
      __esModule: true,
      esolSessionQueue: { add: jest.fn().mockResolvedValue(undefined) },
      notificationsQueue: { add: jest.fn().mockResolvedValue(undefined) },
      priorityQueueQueue: { add: jest.fn().mockResolvedValue(undefined) },
    }));
    jest.doMock("../services/ComplianceConfigService", () => ({
      __esModule: true,
      default: { getCurrent: jest.fn().mockReturnValue({ version: 1 }) },
    }));

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Organisation = require("../models/Organisation").default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    User = require("../models/User").default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    AISession = require("../models/AISession").default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SafeguardingAlert = require("../models/SafeguardingAlert").default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SafeguardingKeyword = require("../models/SafeguardingKeyword").default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    SafeguardingDetector =
      require("../services/safeguardingDetector.service").default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    processTurnService =
      require("../services/aiSession.service").processTurnService;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Types = require("mongoose").Types;
  });

  it("M7 — alert.messageContentHash is SHA-256 of message; triggerCategory + source filled", async () => {
    await SafeguardingKeyword.deleteMany({});
    await SafeguardingKeyword.create([
      {
        pattern: "want to die",
        language: "en",
        category: "self_harm",
        severity: "high",
        active: true,
      },
    ]);
    await SafeguardingDetector.loadAll();

    const org = await Organisation.create({
      name: "Hash Test Org",
      slug: `hash-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      contactEmail: "admin@hash.local",
      adminUserId: new Types.ObjectId(),
      billing_active: true,
      isActive: true,
    });
    const learner = await User.create({
      firstname: "Hash",
      lastname: "Test",
      email: `hash-${Date.now()}-${Math.random().toString(16).slice(2)}@hash.local`,
      password: "x",
      phoneNumber: "07000000000",
      role: "student",
      orgId: org._id,
      isActive: true,
      status: "active",
      verified: true,
      esolLevel: "e2",
      l1Language: "english",
    });
    const session = await AISession.create({
      learnerId: learner._id,
      orgId: org._id,
      sessionMode: "BRIDGE",
      esolLevel: "e2",
      turns: [],
      safeguardingFlagged: false,
      vocabIntroduced: [],
      session_source: "ai_tutor",
      scenario_id: "s1_gp_appointment",
      turn_scores: [],
      teaching_mode_sequence: [],
      start_time: new Date(),
    });

    const message = "I want to die";
    await processTurnService({
      sessionId: session._id.toString(),
      message,
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    });

    const alert = await SafeguardingAlert.findOne({ learnerId: learner._id });
    expect(alert).toBeTruthy();

    const expectedHash = createHash("sha256").update(message).digest("hex");
    expect(alert!.messageContentHash).toBe(expectedHash);
    expect(alert!.messageContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(alert!.triggerCategory).toBe("self_harm");
    expect(alert!.triggerSource).toBe("keyword");
    expect(alert!.alertLevel).toBe("critical"); // self_harm → critical
  });
});
