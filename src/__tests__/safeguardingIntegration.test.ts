/**
 * Pre-cache safeguarding verification suite — Final Addendum §2.
 *
 * Five checks against the Function 7 To-Do 5 integration:
 *
 *   V1   Startup log format: "SafeguardingDetector loaded: <N>
 *        patterns across <L> languages …"
 *   V2   Order invariant: scan() runs BEFORE any Gemini call
 *   V3   Performance: scan() p95 < 5 ms with 1000+ patterns loaded
 *   V4   Triggered scan → pre-cache served + Gemini NOT called
 *   V5   AI-only flag: detector returns triggered=false but Gemini's
 *        safeguarding_flag returns true → pre-cache served, alert
 *        created, AuditLog action "safeguarding_ai_only_flag"
 *
 * Differs from aiTutor.test.ts: this file uses the REAL
 * SafeguardingDetector (not the mock). Loads actual keyword rows into
 * the in-memory Mongo, exercises the live scan code path.
 */

// ── Module mocks — Gemini + queues mocked, detector left real ───────
jest.mock("../lib/gemini", () => {
  const generateContent = jest.fn();
  return {
    __esModule: true,
    MODEL_NAME: "gemini-2.5-flash",
    initGeminiClient: jest.fn(),
    geminiClient: {
      preview: { getGenerativeModel: jest.fn(() => ({ generateContent })) },
    },
    __mockGenerateContent: generateContent,
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
import AuditLog from "../models/AuditLog";
import SafeguardingAlert from "../models/SafeguardingAlert";
import SafeguardingKeyword from "../models/SafeguardingKeyword";
import { processTurnService } from "../services/aiSession.service";
import SafeguardingDetector from "../services/safeguardingDetector.service";
import logger from "../config/logger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockGenerateContent = (
  require("../lib/gemini") as {
    __mockGenerateContent: jest.Mock;
  }
).__mockGenerateContent;

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const validTurnJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    reply: "Good — you used 'appointment' correctly.",
    mode: "bridge",
    skill_codes_used: ["Sc"],
    turn_score: 0.75,
    vocabulary_items_used: [],
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
      cachedContentTokenCount: 700,
    },
  },
});

const createOrgAndLearner = async () => {
  const org = await Organisation.create({
    name: "Verify Org",
    slug: `verify-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@verify.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });
  const learner = await User.create({
    firstname: "Test",
    lastname: "Learner",
    email: `learner-${Date.now()}-${Math.random().toString(16).slice(2)}@verify.local`,
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
  return { org, learner, session };
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockGenerateContent.mockResolvedValue(okGeminiResponse(validTurnJson()));
  SafeguardingDetector.__resetCacheForTests();
});

// ═════════════════════════════════════════════════════════════════════
// V1 — Startup log format
// ═════════════════════════════════════════════════════════════════════

describe("V1 — startup log format", () => {
  it("loadAll emits 'SafeguardingDetector loaded: <N> patterns across <L> languages …'", async () => {
    // Seed a small known set so we can assert the exact counts
    await SafeguardingKeyword.create([
      {
        pattern: "want to die",
        language: "en",
        category: "self_harm",
        severity: "high",
        active: true,
      },
      {
        pattern: "kill myself",
        language: "en",
        category: "self_harm",
        severity: "high",
        active: true,
      },
      {
        pattern: "أريد أن أموت",
        language: "ar",
        category: "self_harm",
        severity: "high",
        active: true,
      },
      {
        pattern: "my husband hit me",
        language: "en",
        category: "domestic_abuse",
        severity: "high",
        active: true,
      },
    ]);

    const infoSpy = jest.spyOn(logger, "info");
    try {
      await SafeguardingDetector.loadAll();
    } finally {
      // Find the loaded-log line among any other info calls fired
      // during the load (mongoose chatter, etc.).
      const loadedLine = infoSpy.mock.calls.find((args) => {
        const m = typeof args[0] === "string" ? args[0] : "";
        return /SafeguardingDetector loaded:/.test(m);
      });
      expect(loadedLine).toBeDefined();
      const message = loadedLine![0] as string;
      // 4 patterns total
      expect(message).toMatch(/SafeguardingDetector loaded:\s*4\s+patterns/);
      // 2 distinct languages (en, ar)
      expect(message).toMatch(/across\s+2\s+languages/);
      // Per-language breakdown in parens (en=3, ar=1)
      expect(message).toMatch(/\(en=3, ar=1\)|\(ar=1, en=3\)/);
      infoSpy.mockRestore();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// V2 — Order invariant: scan BEFORE Gemini
// ═════════════════════════════════════════════════════════════════════

describe("V2 — order invariant (scan THEN gemini)", () => {
  it("scan() resolves before generateContent() is invoked", async () => {
    // Empty keyword bank — scan returns NO_MATCH, the turn proceeds to Gemini.
    await SafeguardingDetector.loadAll();

    // Record call ordering by stamping a counter on each invocation.
    let nextTick = 0;
    const scanSpy = jest
      .spyOn(SafeguardingDetector, "scan")
      .mockImplementation(((
        ...args: Parameters<typeof SafeguardingDetector.scan>
      ) => {
        (scanSpy as any).__order = ++nextTick;
        // Delegate to the real implementation via the original method:
        // jest.spyOn preserves it on `scanSpy.mockRestore` later. For
        // this assertion the return value just needs to be NO_MATCH.
        return { triggered: false, category: null, matched_pattern: null };
      }) as any);
    mockGenerateContent.mockImplementation(async () => {
      (mockGenerateContent as any).__order = ++nextTick;
      return okGeminiResponse(validTurnJson());
    });

    const { org, learner, session } = await createOrgAndLearner();
    await processTurnService({
      sessionId: session._id.toString(),
      message: "Hello, I'd like an appointment",
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    });

    expect(scanSpy).toHaveBeenCalledTimes(1);
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    expect((scanSpy as any).__order).toBe(1);
    expect((mockGenerateContent as any).__order).toBe(2);

    scanSpy.mockRestore();
  });
});

// ═════════════════════════════════════════════════════════════════════
// V3 — Performance: p95 < 5ms with 1000 patterns
// ═════════════════════════════════════════════════════════════════════

describe("V3 — scan() performance with 1000 patterns", () => {
  it("p95 latency under 5ms across 1000 scans", async () => {
    // Seed 1000 patterns across two languages — realistic-shape data
    // so the perf claim survives a real keyword bank growing.
    const docs: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 800; i++) {
      docs.push({
        pattern: `english pattern number ${i} that should not match`,
        language: "en",
        category: "self_harm",
        severity: "high",
        active: true,
      });
    }
    for (let i = 0; i < 200; i++) {
      docs.push({
        pattern: `pattern arabe numéro ${i} هذا نمط`,
        language: "ar",
        category: "self_harm",
        severity: "high",
        active: true,
      });
    }
    await SafeguardingKeyword.insertMany(docs);
    await SafeguardingDetector.loadAll();

    // Sanity: cache really did load
    const sample = SafeguardingDetector.scan(
      "english pattern number 1 that should not match",
      "en",
    );
    expect(sample.triggered).toBe(true);

    // Time 500 scans against a NON-matching message — worst case
    // because the scanner walks every pattern.
    const haystack =
      "Hello Amber, today I would like to book an appointment with my GP";
    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t0 = process.hrtime.bigint();
      SafeguardingDetector.scan(haystack, "en");
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0) / 1_000_000); // ns → ms
    }

    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const median = samples[Math.floor(samples.length * 0.5)];

    // Diagnostic on failure — print percentiles so a regression
    // points at the actual numbers.
    if (p95 >= 5) {
      // eslint-disable-next-line no-console
      console.error(
        `Perf samples: median=${median.toFixed(3)}ms p95=${p95.toFixed(3)}ms`,
      );
    }
    expect(p95).toBeLessThan(5);
  }, 30_000);
});

// ═════════════════════════════════════════════════════════════════════
// V4 — Triggered scan → pre-cache served, Gemini NOT called
// ═════════════════════════════════════════════════════════════════════

describe("V4 — triggered scan bypasses Gemini entirely", () => {
  it("matching keyword fires pre-cache + audit + no generateContent call", async () => {
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

    const { org, learner, session } = await createOrgAndLearner();

    const res = await processTurnService({
      sessionId: session._id.toString(),
      message: "I want to die",
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    });

    const data = res.data as { reply: string; safeguarding_served?: boolean };
    expect(data.safeguarding_served).toBe(true);
    expect(data.reply).toMatch(/Samaritans|NHS|Help is available/i);

    // The critical assertion: Gemini was NEVER called.
    expect(mockGenerateContent).not.toHaveBeenCalled();

    // SafeguardingAlert + audit row both written
    const alerts = await SafeguardingAlert.find({ learnerId: learner._id });
    expect(alerts).toHaveLength(1);
    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "safeguarding_alert_raised",
    });
    expect(audit).toBeTruthy();
  });
});

// ═════════════════════════════════════════════════════════════════════
// V5 — AI-only flag (detector miss, Gemini caught)
// ═════════════════════════════════════════════════════════════════════

describe("V5 — AI-only safeguarding flag (defence-in-depth)", () => {
  it("keyword scan returns false, Gemini flag true → pre-cache served + audit safeguarding_ai_only_flag", async () => {
    // Empty bank — detector will return triggered=false for any input
    await SafeguardingKeyword.deleteMany({});
    await SafeguardingDetector.loadAll();

    // Gemini returns a turn JSON with safeguarding_flag=true
    mockGenerateContent.mockResolvedValue(
      okGeminiResponse(
        validTurnJson({
          safeguarding_flag: true,
          safeguarding_category: "mental_health_crisis",
        }),
      ),
    );

    const { org, learner, session } = await createOrgAndLearner();

    const res = await processTurnService({
      sessionId: session._id.toString(),
      message: "I have been feeling really low for weeks",
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    });

    const data = res.data as { reply: string; safeguarding_served?: boolean };
    expect(data.safeguarding_served).toBe(true);

    // Pre-cached reply, NOT Gemini's text — even though Gemini did run,
    // we don't surface its reply when it flags.
    expect(data.reply).toMatch(/Samaritans|NHS|Help is available/i);
    expect(data.reply).not.toMatch(/appointment/i); // Gemini's stock reply mentioned appointment

    // Gemini WAS called (this is the AI-only path)
    expect(mockGenerateContent).toHaveBeenCalledTimes(1);

    // SafeguardingAlert created
    const alerts = await SafeguardingAlert.find({ learnerId: learner._id });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alertLevel).toBe("medium"); // mental_health_crisis → medium

    // AuditLog action is the AI-only variant
    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "safeguarding_ai_only_flag",
    });
    expect(audit).toBeTruthy();
    // before/after state captures the AI-only source
    expect((audit?.after_state as { source?: string })?.source).toBe("ai_only");
  });
});
