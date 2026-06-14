/**
 * D2 AI tutor acceptance suite — brief Function 7 To-Do 8.
 *
 * 12 tests:
 *   T1   Voice principle 2 — no "wrong"/"incorrect" in tutor replies   [LIVE]
 *   T2   Response length cap at e1                                      [LIVE]
 *   T3   L1 handling for Arabic / Somali / Dari                         [LIVE]
 *   T4   ANCHOR mode trigger after 2 turns < 0.40                       [LIVE]
 *   T5   IMMERSION trigger after 3 turns ≥ 0.80 at e3                   [LIVE]
 *   T6   Safeguarding self_harm — pre-cache served, no Gemini call     [MOCKED]
 *   T7   All six safeguarding categories — same shape                  [MOCKED]
 *   T8   Session logging completeness                                  [MOCKED]
 *   T9   Vocab ledger updates after a session                          [MOCKED]
 *   T10  Gemini timeout — graceful 502 + session preserved              [MOCKED]
 *   T11  JSON output validation across 50 turns                         [LIVE]
 *   T12  Prompt cache hit ratio > 60% across 20 sessions                [LIVE]
 *
 * Live tests are skipped unless `ENABLE_LIVE_TESTS=true`. They:
 *   - Call real Vertex AI (requires GOOGLE_CLOUD_PROJECT_ID + ADC)
 *   - Cost real money (~£0.50 for the full live run on flash)
 *   - Take ~5 minutes (Gemini median latency × turn count)
 *
 * Mock factories below check the env var so the file works in both
 * modes without forking into two test files.
 */

// ── Env-aware mocks ──────────────────────────────────────────────────
//
// jest.mock() factories are hoisted ABOVE imports, so we can't import
// a helper to compute LIVE_GEMINI before the mocks evaluate. Each
// factory inlines the env-var check and either returns the real
// module (live mode) or a mock (default).

jest.mock("../lib/gemini", () => {
  if (process.env.ENABLE_LIVE_TESTS === "true") {
    return jest.requireActual("../lib/gemini");
  }
  // Mocked client — tests override `generateContent` per case via
  // the exported `mockGenerateContent` jest.fn.
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

jest.mock("../services/safeguardingDetector.service", () => {
  if (process.env.ENABLE_LIVE_TESTS === "true") {
    return jest.requireActual("../services/safeguardingDetector.service");
  }
  const scan = jest.fn().mockReturnValue({
    triggered: false,
    category: null,
    matched_pattern: null,
  });
  return {
    __esModule: true,
    default: {
      loadAll: jest.fn(),
      scan,
      __resetCacheForTests: jest.fn(),
    },
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

// Required env for the placement bank / referral JWT modules that load
// transitively when aiSession.service imports the orchestration chain.
process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import AuditLog from "../models/AuditLog";
import SafeguardingAlert from "../models/SafeguardingAlert";
import TurnLog from "../models/TurnLog";
import {
  processTurnService,
  startSessionService,
  endSessionService,
} from "../services/aiSession.service";
import SafeguardingDetector from "../services/safeguardingDetector.service";
import { notificationsQueue, esolSessionQueue } from "../queues";

const LIVE_GEMINI = process.env.ENABLE_LIVE_TESTS === "true";

// Pull the mock handle the gemini.ts factory exports when in mocked mode.
// In live mode this is undefined and we never use it.
const mockGenerateContent = !LIVE_GEMINI
  ? // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require("../lib/gemini") as { __mockGenerateContent: jest.Mock })
      .__mockGenerateContent
  : null;

const describeLive = LIVE_GEMINI ? describe : describe.skip;

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async () =>
  Organisation.create({
    name: "D2 Test College",
    slug: `d2-org-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@d2.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = async (
  orgId: Types.ObjectId | unknown,
  overrides: Record<string, unknown> = {},
) =>
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
    ...overrides,
  });

const createSession = async (
  learnerId: Types.ObjectId | unknown,
  orgId: Types.ObjectId | unknown,
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
    start_time: new Date(),
    ...overrides,
  });

/**
 * Build a Gemini-shaped JSON response for the mock. Conforms to the
 * Zod schema validated inside generateTurn.
 */
const validTurnJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply:
      "Good — you used 'appointment' correctly. Try 'I would like an appointment'.",
    mode: "bridge",
    skill_codes_used: ["Sc"],
    turn_score: 0.75,
    vocabulary_items_used: ["appointment"],
    safeguarding_flag: false,
    safeguarding_category: null,
    session_complete: false,
    session_summary: null,
    ...overrides,
  });

const okGeminiResponse = (json: string) => ({
  response: {
    candidates: [{ content: { parts: [{ text: json }] } }],
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 200,
      cachedContentTokenCount: 700, // 70% cache hit ratio — satisfies T12
    },
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  if (!LIVE_GEMINI) {
    // Default mock returns a clean turn; individual tests override.
    mockGenerateContent!.mockResolvedValue(okGeminiResponse(validTurnJson()));
    (SafeguardingDetector.scan as jest.Mock).mockReturnValue({
      triggered: false,
      category: null,
      matched_pattern: null,
    });
  }
});

// ═════════════════════════════════════════════════════════════════════
// LIVE tests (T1–T5, T11, T12)
// ═════════════════════════════════════════════════════════════════════

describeLive(
  "D2-T1 — voice principle 2 (no 'wrong'/'incorrect' phrases)",
  () => {
    it(
      "rejects nothing — 10 turns with grammar errors produce zero forbidden phrases",
      async () => {
        const FORBIDDEN = [
          /\b(that is|that's)\s+wrong\b/i,
          /\bincorrect\b/i,
          /\bwrong answer\b/i,
          /\bno, that's wrong\b/i,
        ];
        const org = await createOrg();
        const learner = await createLearner(org._id, { esolLevel: "e2" });
        const session = await createSession(learner._id, org._id);

        const errorfulInputs = [
          "I goes to shops yesterday",
          "She no understand me",
          "I am very tired the work",
          "Yesterday I am eating chicken",
          "He don't have the keys",
          "I want a apple",
          "She say me to come",
          "I no can hear you",
          "We was in London last week",
          "Mary and me went to park",
        ];

        for (const text of errorfulInputs) {
          const res = await processTurnService({
            sessionId: session._id.toString(),
            message: text,
            learnerId: learner._id.toString(),
            orgId: org._id.toString(),
          });
          const reply = (res.data as { reply: string }).reply;
          for (const re of FORBIDDEN) {
            expect(reply).not.toMatch(re);
          }
        }
      },
      5 * 60 * 1000,
    );
  },
);

describeLive("D2-T2 — response length cap at e1 (≤ 3 sentences)", () => {
  it(
    "10 turns at e1 all return ≤ 3 sentences",
    async () => {
      const org = await createOrg();
      const learner = await createLearner(org._id, { esolLevel: "e1" });
      const session = await createSession(learner._id, org._id, {
        esolLevel: "e1",
      });

      for (let i = 0; i < 10; i++) {
        const res = await processTurnService({
          sessionId: session._id.toString(),
          message: `Hello Amber, this is turn ${i + 1}.`,
          learnerId: learner._id.toString(),
          orgId: org._id.toString(),
        });
        const reply = (res.data as { reply: string }).reply;
        // Count sentence-ending punctuation. "Mr. Smith" undercounts as one
        // sentence — fine for e1 where idioms / honorifics aren't used.
        const sentenceCount = (reply.match(/[.!?]+(?=\s|$)/g) ?? []).length;
        expect(sentenceCount).toBeLessThanOrEqual(3);
      }
    },
    5 * 60 * 1000,
  );
});

describeLive("D2-T3 — L1 handling (Arabic / Somali / Dari)", () => {
  const cases: Array<{
    l1: string;
    lang: string;
    sample: string;
    expectedScript: RegExp;
  }> = [
    {
      l1: "arabic",
      lang: "ar",
      sample: "مرحبا، أحتاج مساعدة",
      expectedScript: /[؀-ۿ]/,
    },
    {
      l1: "somali",
      lang: "so",
      sample: "Salaan, waan jiraa caawimaad",
      expectedScript: /\b(salaan|fadlan|mahadsanid|waan)\b/i,
    },
    {
      l1: "dari",
      lang: "fa",
      sample: "سلام، به کمک نیاز دارم",
      expectedScript: /[؀-ۿ]/,
    },
  ];

  it.each(cases)(
    "$l1 — reply contains the L1 script + an English equivalent",
    async ({ l1, sample, expectedScript }) => {
      const org = await createOrg();
      const learner = await createLearner(org._id, {
        l1Language: l1,
        esolLevel: "e1",
      });
      const session = await createSession(learner._id, org._id);
      const res = await processTurnService({
        sessionId: session._id.toString(),
        message: sample,
        learnerId: learner._id.toString(),
        orgId: org._id.toString(),
      });
      const reply = (res.data as { reply: string }).reply;
      expect(reply).toMatch(expectedScript); // L1 present
      expect(reply).toMatch(/[a-zA-Z]/); // English equivalent present
    },
    2 * 60 * 1000,
  );
});

describeLive("D2-T4 — ANCHOR mode trigger (2 consecutive turns < 0.40)", () => {
  it(
    "session mode flips to ANCHOR after the second low-score turn",
    async () => {
      // Live test exercises real Gemini scoring of deliberately
      // sub-threshold inputs. The current code uses the model's own
      // turn_score; if Gemini disagrees this test surfaces calibration
      // drift in the prompt.
      const org = await createOrg();
      const learner = await createLearner(org._id, { esolLevel: "e2" });
      const session = await createSession(learner._id, org._id);
      const sessionId = session._id.toString();

      // Two turns of single-word or off-topic input — Gemini should
      // score these low because the rubric in layer 6 ties low score
      // to short / off-topic replies.
      await processTurnService({
        sessionId,
        message: "ok",
        learnerId: learner._id.toString(),
        orgId: org._id.toString(),
      });
      await processTurnService({
        sessionId,
        message: "yes",
        learnerId: learner._id.toString(),
        orgId: org._id.toString(),
      });

      const updated = await AISession.findById(sessionId).lean();
      expect(updated?.sessionMode).toBe("ANCHOR");
      expect(updated?.teaching_mode_sequence?.at(-1)).toBe("anchor");
    },
    3 * 60 * 1000,
  );
});

describeLive(
  "D2-T5 — IMMERSION trigger (3 consecutive turns ≥ 0.80 at e3)",
  () => {
    it(
      "session mode flips to IMMERSION after the third high-score turn",
      async () => {
        const org = await createOrg();
        const learner = await createLearner(org._id, { esolLevel: "e3" });
        const session = await createSession(learner._id, org._id, {
          esolLevel: "e3",
        });
        const sessionId = session._id.toString();

        // Three fluent, on-topic, well-formed responses
        const fluent = [
          "Good morning! I'd like to book an appointment for next Tuesday, please.",
          "I prefer the afternoon if possible — anytime after 2pm works well.",
          "Yes, I've registered with this practice. My name is Aamina Ali, date of birth fifth of June.",
        ];
        for (const text of fluent) {
          await processTurnService({
            sessionId,
            message: text,
            learnerId: learner._id.toString(),
            orgId: org._id.toString(),
          });
        }

        const updated = await AISession.findById(sessionId).lean();
        expect(updated?.sessionMode).toBe("IMMERSION");
        expect(updated?.teaching_mode_sequence?.at(-1)).toBe("immersion");
      },
      3 * 60 * 1000,
    );
  },
);

// ═════════════════════════════════════════════════════════════════════
// MOCKED tests (T6–T10) — run by default
// ═════════════════════════════════════════════════════════════════════

describe("D2-T6 — safeguarding category self_harm", () => {
  it("pre-cached message served, alert created, notification queued, Gemini NOT called", async () => {
    (SafeguardingDetector.scan as jest.Mock).mockReturnValue({
      triggered: true,
      category: "self_harm",
      matched_pattern: "want to die",
    });

    const org = await createOrg();
    const learner = await createLearner(org._id);
    const session = await createSession(learner._id, org._id);

    const res = await processTurnService({
      sessionId: session._id.toString(),
      message: "I want to die",
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    });

    const data = res.data as { reply: string; safeguarding_served?: boolean };

    // Pre-cached reply signals the safeguarding path was taken
    expect(data.safeguarding_served).toBe(true);
    expect(data.reply).toMatch(/Samaritans|NHS|Help is available/i);

    // Gemini was NOT invoked — generateContent mock has zero calls
    expect(mockGenerateContent!).not.toHaveBeenCalled();

    // SafeguardingAlert created
    const alerts = await SafeguardingAlert.find({ learnerId: learner._id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alertLevel).toBe("critical"); // self_harm → critical

    // Notification queued (DSL email)
    expect(notificationsQueue.add).toHaveBeenCalledTimes(1);

    // AuditLog row written with the right action
    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "safeguarding_alert_raised",
    });
    expect(audit).toBeTruthy();

    // TurnLog captured the message with served_path tagged
    const tl = await TurnLog.findOne({ session_id: session._id });
    expect(tl?.served_path).toBe("safeguarding_precache");
    expect(tl?.message).toBe("I want to die");
  });
});

describe("D2-T7 — all six safeguarding categories", () => {
  const categories = [
    { category: "domestic_abuse", severity: "high" },
    { category: "radicalisation", severity: "medium" },
    { category: "child_protection", severity: "critical" },
    { category: "exploitation", severity: "high" },
    { category: "mental_health_crisis", severity: "medium" },
  ] as const;

  it.each(categories)(
    "$category → pre-cache + $severity alert + email + no Gemini call",
    async ({ category, severity }) => {
      (SafeguardingDetector.scan as jest.Mock).mockReturnValue({
        triggered: true,
        category,
        matched_pattern: "pattern",
      });

      const org = await createOrg();
      const learner = await createLearner(org._id);
      const session = await createSession(learner._id, org._id);

      await processTurnService({
        sessionId: session._id.toString(),
        message: "trigger message",
        learnerId: learner._id.toString(),
        orgId: org._id.toString(),
      });

      expect(mockGenerateContent!).not.toHaveBeenCalled();
      const alerts = await SafeguardingAlert.find({ learnerId: learner._id });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertLevel).toBe(severity);
      expect(notificationsQueue.add).toHaveBeenCalledTimes(1);
    },
  );
});

describe("D2-T8 — session logging completeness", () => {
  it("a happy-path turn populates the session record's required fields", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    const session = await createSession(learner._id, org._id);

    await processTurnService({
      sessionId: session._id.toString(),
      message: "Hello, I'd like to book an appointment.",
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    });

    const updated = await AISession.findById(session._id).lean();
    expect(updated).toBeTruthy();
    // Brief: AISession record has all required fields populated
    expect(updated!.turns).toHaveLength(1);
    expect(updated!.turns[0].originalInput).toBe(
      "Hello, I'd like to book an appointment.",
    );
    expect(updated!.turns[0].deepSeekResponse).toMatch(/.+/); // Amber's reply
    expect(updated!.turn_scores).toHaveLength(1);
    expect(updated!.turn_scores![0]).toBeGreaterThan(0);
    expect(updated!.teaching_mode_sequence).toHaveLength(1);
    expect(updated!.teaching_mode_sequence![0]).toBe("bridge");
    expect(updated!.sessionMode).toBe("BRIDGE");

    // TurnLog row exists with the gemini served_path
    const tl = await TurnLog.findOne({ session_id: session._id });
    expect(tl?.served_path).toBe("gemini");
  });
});

describe("D2-T9 — vocab ledger updates referencing Stage 3 objectives", () => {
  it.skip("VocabLedger entries reference learner's Stage 3 Sc objective after a session — PENDING vocab worker", async () => {
    // The /turn handler enqueues an `update_vocab` job on the
    // esol-session BullMQ queue (verified below). The consumer
    // that actually writes VocabLedger rows is Phase 10 and not
    // yet implemented; this test waits for that worker.
    //
    // When the worker lands, replace the .skip with a proper test
    // that drives the queue + asserts VocabLedger rows reference
    // the learner's Stage 3 Sc objective via stage3_objective_id.
    const org = await createOrg();
    const learner = await createLearner(org._id);
    const session = await createSession(learner._id, org._id);
    await processTurnService({
      sessionId: session._id.toString(),
      message: "Hi",
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    });

    // Today we can only assert the enqueue happened.
    expect(esolSessionQueue.add).toHaveBeenCalledWith(
      "update-vocab",
      expect.objectContaining({ action: "update_vocab" }),
    );
  });
});

describe("D2-T10 — Gemini timeout", () => {
  it("returns 502, no crash, session state preserved", async () => {
    mockGenerateContent!.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(new Error("DEADLINE_EXCEEDED — simulated 10s timeout")),
            10,
          );
        }),
    );

    const org = await createOrg();
    const learner = await createLearner(org._id);
    const session = await createSession(learner._id, org._id);

    await expect(
      processTurnService({
        sessionId: session._id.toString(),
        message: "hello",
        learnerId: learner._id.toString(),
        orgId: org._id.toString(),
      }),
    ).rejects.toMatchObject({ statusCode: 502 });

    // Session state preserved — no turn appended, no score added
    const after = await AISession.findById(session._id).lean();
    expect(after?.turns).toHaveLength(0);
    expect(after?.turn_scores ?? []).toHaveLength(0);

    // The TurnLog row IS persisted (we capture before Gemini fires)
    const tl = await TurnLog.findOne({ session_id: session._id });
    expect(tl).toBeTruthy();
    expect(tl?.message).toBe("hello");
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════
// LIVE tests (T11, T12)
// ═════════════════════════════════════════════════════════════════════

describeLive("D2-T11 — JSON output validation across 50 turns", () => {
  it(
    "50 real turns all produce schema-valid output",
    async () => {
      const org = await createOrg();
      const learner = await createLearner(org._id);
      const session = await createSession(learner._id, org._id);

      const inputs = Array.from(
        { length: 50 },
        (_, i) => `Practice turn number ${i + 1}.`,
      );
      let validCount = 0;
      for (const text of inputs) {
        // generateTurn already runs the Zod validator and throws
        // GeminiSchemaError on failure. processTurnService surfaces
        // that as a 502; if all 50 succeed, validation passed.
        await processTurnService({
          sessionId: session._id.toString(),
          message: text,
          learnerId: learner._id.toString(),
          orgId: org._id.toString(),
        });
        validCount += 1;
      }
      expect(validCount).toBe(50);
    },
    15 * 60 * 1000,
  );
});

describeLive("D2-T12 — prompt cache hit ratio > 60% across 20 sessions", () => {
  it(
    "AIUsage rows show > 60% cached-token ratio on average",
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const AIUsage = require("../models/AIUsage").default;

      const org = await createOrg();
      const learner = await createLearner(org._id);

      // 20 distinct sessions × 5 turns each = 100 Gemini calls
      for (let s = 0; s < 20; s++) {
        const session = await createSession(learner._id, org._id);
        for (let t = 0; t < 5; t++) {
          await processTurnService({
            sessionId: session._id.toString(),
            message: `Turn ${t} of session ${s}`,
            learnerId: learner._id.toString(),
            orgId: org._id.toString(),
          });
        }
      }

      const rows = await AIUsage.find({ org_id: org._id }).lean();
      expect(rows.length).toBeGreaterThan(0);
      const totalIn = rows.reduce((s: number, r: any) => s + r.input_tokens, 0);
      const totalCached = rows.reduce(
        (s: number, r: any) => s + r.cached_tokens,
        0,
      );
      const ratio = totalIn > 0 ? totalCached / totalIn : 0;
      expect(ratio).toBeGreaterThan(0.6);
    },
    30 * 60 * 1000,
  );
});
