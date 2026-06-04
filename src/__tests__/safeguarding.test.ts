/**
 * Safeguarding privacy audit — brief Function 10.
 *
 * The SafeguardingAlert collection MUST store SHA-256 hashes only; the
 * raw triggering message MUST NOT appear in:
 *
 *   - Pino log lines (any level)
 *   - SafeguardingAlert documents (any field, any sub-document)
 *   - AISession documents (especially session.turns[].originalInput)
 *   - AuditLog documents
 *   - BullMQ job payloads (notifications-queue + esol-session-queue)
 *
 * TurnLog IS allowed to contain the raw message — it's the platform's
 * cleartext audit store of record (Function 7 To-Do 5). The audit
 * carve-out is documented in src/services/aiSession.service.ts and the
 * SAFEGUARDING_REVIEW.md doc.
 *
 * Strategy: drive a known-unique disclosure string ("AUDIT-CANARY-…")
 * through processTurnService with a triggering keyword. Then walk
 * every Mongo collection and every captured logger call asserting the
 * canary substring is absent. The collection walk uses raw collection
 * scans so we catch fields that Mongoose doesn't expose on the typed
 * document — a regression that adds e.g. `disclosureText` to the alert
 * schema would still be caught here.
 *
 *   P1   Canary disclosure is hashed onto SafeguardingAlert and the
 *        raw string appears in zero alert documents
 *   P2   Canary string does NOT appear in any AISession document
 *        (the safeguarding path early-returns BEFORE session.turns.push)
 *   P3   Canary string does NOT appear in any AuditLog document
 *   P4   Canary string does NOT appear in any notifications-queue
 *        BullMQ job payload (notificationsQueue.add captured)
 *   P5   Canary string does NOT appear in any Pino log line (all
 *        levels: trace/debug/info/warn/error/fatal mocked + captured)
 *   P6   Canary DOES appear in TurnLog.message — the accepted
 *        cleartext audit store
 */

// ── Mocks ───────────────────────────────────────────────────────────
// Gemini is mocked so we never call the real API. Queues are mocked
// so we capture .add() calls without spinning up Redis.
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

const esolSessionAddMock = jest.fn().mockResolvedValue(undefined);
const notificationsAddMock = jest.fn().mockResolvedValue(undefined);
const priorityAddMock = jest.fn().mockResolvedValue(undefined);
jest.mock("../queues", () => ({
  __esModule: true,
  esolSessionQueue:   { add: esolSessionAddMock },
  notificationsQueue: { add: notificationsAddMock },
  priorityQueueQueue: { add: priorityAddMock },
}));

jest.mock("../services/ComplianceConfigService", () => ({
  __esModule: true,
  default: { getCurrent: jest.fn().mockReturnValue({ version: 1 }) },
}));

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { createHash } from "crypto";
import mongoose, { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import AuditLog from "../models/AuditLog";
import SafeguardingAlert from "../models/SafeguardingAlert";
import SafeguardingKeyword from "../models/SafeguardingKeyword";
import TurnLog from "../models/TurnLog";
import SafeguardingDetector from "../services/safeguardingDetector.service";
import { processTurnService } from "../services/aiSession.service";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Canary — a deliberately distinctive substring so a grep across
// every document field + every log meta object catches incidental
// leakage. Embedded in the message text the test sends.
// ─────────────────────────────────────────────────────────────────────

const CANARY = "AUDIT-CANARY-3f8b21d4-9c0a-4e7f-bd62-7a55e9e1f4cc";
const TRIGGER_PHRASE = "want to die";
const MESSAGE = `${CANARY} — ${TRIGGER_PHRASE}`;

// ─────────────────────────────────────────────────────────────────────
// Logger interception. We replace each level with a spy BEFORE the SUT
// fires so even early bootstrap logs are captured. Restored in afterAll.
// ─────────────────────────────────────────────────────────────────────

type LoggerLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
const LEVELS: LoggerLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

const loggerSpies: Record<LoggerLevel, jest.SpyInstance> = {} as never;

const captureLoggerCallsContaining = (needle: string): unknown[][] => {
  const hits: unknown[][] = [];
  for (const lvl of LEVELS) {
    for (const args of loggerSpies[lvl]?.mock.calls ?? []) {
      const serialised = JSON.stringify(args);
      if (serialised.includes(needle)) hits.push(args);
    }
  }
  return hits;
};

// ─────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────

const createOrg = async () =>
  Organisation.create({
    name: "Audit Org",
    slug: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@audit.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = async (orgId: unknown) =>
  User.create({
    firstname: "Audit",
    lastname: "Learner",
    email: `audit-${Date.now()}-${Math.random().toString(16).slice(2)}@audit.local`,
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

const createSession = async (learnerId: unknown, orgId: unknown) =>
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
  });

// ─────────────────────────────────────────────────────────────────────
// Setup / teardown
// ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  for (const lvl of LEVELS) {
    loggerSpies[lvl] = jest.spyOn(logger, lvl).mockImplementation(() => logger);
  }

  // Seed the keyword bank so the SafeguardingDetector triggers on our phrase
  await SafeguardingKeyword.create({
    pattern: TRIGGER_PHRASE,
    language: "en",
    category: "self_harm",
    severity: "high",
    active: true,
  });
  await SafeguardingDetector.loadAll();
});

afterAll(() => {
  for (const lvl of LEVELS) loggerSpies[lvl]?.mockRestore();
});

beforeEach(() => {
  esolSessionAddMock.mockClear();
  notificationsAddMock.mockClear();
  priorityAddMock.mockClear();
  for (const lvl of LEVELS) loggerSpies[lvl]?.mockClear();
});

// ═════════════════════════════════════════════════════════════════════
// The audit
// ═════════════════════════════════════════════════════════════════════

describe("Function 10 privacy audit — no raw message anywhere except TurnLog", () => {
  it("P1–P6 — canary disclosure is hashed-only, never persisted or logged elsewhere", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    const session = await createSession(learner._id, org._id);

    const res = await processTurnService({
      sessionId: session._id.toString(),
      message: MESSAGE,
      learnerId: learner._id.toString(),
      orgId: org._id.toString(),
    });

    // Sanity — safeguarding path was actually taken
    expect((res.data as { safeguarding_served?: boolean }).safeguarding_served).toBe(true);

    // ── P1: SafeguardingAlert stores hash only ──────────────────────
    const alerts = await SafeguardingAlert.find({ learnerId: learner._id });
    expect(alerts).toHaveLength(1);
    const alert = alerts[0];
    const expectedHash = createHash("sha256").update(MESSAGE).digest("hex");
    expect(alert.messageContentHash).toBe(expectedHash);
    expect(alert.messageContentHash).toMatch(/^[0-9a-f]{64}$/);

    // Raw collection scan — catches future schema additions that
    // Mongoose's typed projection would hide. Stringify the whole
    // document and grep for the canary.
    const alertsRawColl = mongoose.connection
      .collection(SafeguardingAlert.collection.name);
    const alertDocs = await alertsRawColl.find({}).toArray();
    for (const doc of alertDocs) {
      expect(JSON.stringify(doc)).not.toContain(CANARY);
    }

    // ── P2: AISession does NOT contain the canary anywhere ─────────
    // The safeguarding-triggered path early-returns BEFORE
    // session.turns.push(...originalInput: input.message...). A
    // regression that removes the early return would leak via
    // session.turns[].originalInput; this assertion catches it.
    const sessionsRawColl = mongoose.connection
      .collection(AISession.collection.name);
    const sessionDocs = await sessionsRawColl.find({}).toArray();
    for (const doc of sessionDocs) {
      expect(JSON.stringify(doc)).not.toContain(CANARY);
    }
    // Belt-and-braces — explicitly check the turns subarray length
    const reloaded = await AISession.findById(session._id).lean();
    expect((reloaded as { turns?: unknown[] })?.turns ?? []).toHaveLength(0);

    // ── P3: AuditLog does NOT contain the canary ───────────────────
    const auditRows = await AuditLog.find({ learner_id: learner._id }).lean();
    expect(auditRows.length).toBeGreaterThan(0); // an audit WAS written
    for (const row of auditRows) {
      expect(JSON.stringify(row)).not.toContain(CANARY);
    }

    // ── P4: BullMQ payloads (notifications + esol-session) ─────────
    // On a safeguarding-triggered turn the hardened path enqueues
    // only ONE job: the safeguarding-alert notification. No
    // update-vocab or capture-evidence jobs should fire (no Gemini
    // call happened, no vocab to update). Defence-in-depth: check
    // both queues' add() calls for the canary.
    expect(notificationsAddMock).toHaveBeenCalledTimes(1);
    expect(esolSessionAddMock).not.toHaveBeenCalled();
    expect(priorityAddMock).not.toHaveBeenCalled();

    for (const call of notificationsAddMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(CANARY);
    }
    // Confirm the queued payload is the minimal Function-10 shape.
    const [jobName, payload] = notificationsAddMock.mock.calls[0];
    expect(jobName).toBe("safeguarding-alert");
    expect(payload).toEqual({
      category: "self_harm",
      org_id: org._id.toString(),
      alert_id: alert._id.toString(),
      alert_created_at: expect.any(String),
    });

    // ── P5: Pino log lines (every level) ───────────────────────────
    const leakedLogCalls = captureLoggerCallsContaining(CANARY);
    if (leakedLogCalls.length > 0) {
      // Make the failure noisy + actionable — print the leaking call
      // so the offending logger statement is obvious in CI output.
      // eslint-disable-next-line no-console
      console.error(
        "Canary leaked into logger calls:",
        JSON.stringify(leakedLogCalls, null, 2)
      );
    }
    expect(leakedLogCalls).toHaveLength(0);

    // ── P6: TurnLog DOES contain the canary (accepted carve-out) ──
    // The brief specifies TurnLog as the platform's audit store of
    // record for safeguarding-triggered messages. A regression that
    // removed this would silently break the audit trail — assert
    // it's still there so we notice.
    const turnLog = await TurnLog.findOne({ session_id: session._id });
    expect(turnLog).toBeTruthy();
    expect(turnLog?.message).toBe(MESSAGE);
    expect(turnLog?.served_path).toBe("safeguarding_precache");
  });
});
