/**
 * Tests for the safeguarding-alert email worker — brief Function 10.
 *
 *   E1   buildSafeguardingEmailBody produces the exact spec text
 *        — no learner name, no session id, no message content
 *   E2   sendSafeguardingAlertEmail calls transporter.sendMail with
 *        the env-driven recipient, the brief's subject, and the body
 *   E3   The worker looks up the org name and falls back gracefully
 *        when the org is missing
 *   E4   notificationSentAt is stamped on the SafeguardingAlert
 *   E5   dispatch_latency_ms is computed from alert_created_at and
 *        logged at WARN when > 5s SLA
 *   E6   processNotifications dispatches by job.name and rejects
 *        invalid payloads
 */

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";
process.env.SAFEGUARDING_EMAIL = "safeguarding-test@ambertraining.local";
process.env.AUTH_EMAIL = "amber-bot@ambertraining.local";

// Queue mock — services/queueProcessors transitively loads ../../queues
// for type re-exports + the worker dispatcher. The real queues module
// calls createBullmqConnection() at load, which throws unless REDIS_URL
// is set. We don't enqueue anything in this suite, so the stubs only
// need to satisfy module resolution.
jest.mock("../queues", () => ({
  __esModule: true,
  esolSessionQueue: { add: jest.fn() },
  rarpaEvidenceQueue: { add: jest.fn() },
  ilrExportQueue: { add: jest.fn() },
  complianceValidationQueue: { add: jest.fn() },
  misPushQueue: { add: jest.fn() },
  priorityQueueQueue: { add: jest.fn() },
  deltaSyncQueue: { add: jest.fn() },
  notificationsQueue: { add: jest.fn() },
  cacheRefreshQueue: { add: jest.fn() },
  allQueues: {},
}));

// Mock the transporter BEFORE the SUT is imported so the SMTP
// singleton's `verify()` call never tries to talk to the real server.
const sendMailMock = jest.fn();
jest.mock("../services/nodemailer/nodemailer", () => ({
  __esModule: true,
  default: { sendMail: sendMailMock },
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import SafeguardingAlert from "../models/SafeguardingAlert";
import {
  sendSafeguardingAlertEmail,
  buildSafeguardingEmailBody,
} from "../services/notifications/safeguardingAlertEmail.service";
import { processNotifications } from "../services/queueProcessors";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "Test FE College") =>
  Organisation.create({
    name,
    slug: `email-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@test.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createAlert = async (orgId: unknown) =>
  SafeguardingAlert.create({
    learnerId: new Types.ObjectId(),
    orgId,
    sessionId: new Types.ObjectId(),
    alertLevel: "critical",
    messageContentHash: "a".repeat(64),
    triggerCategory: "self_harm",
    triggerSource: "keyword",
    status: "open",
  });

beforeEach(() => {
  jest.clearAllMocks();
  sendMailMock.mockResolvedValue({ messageId: "<test-message-id@local>" });
});

// ═════════════════════════════════════════════════════════════════════
// E1 — Body composition (pure)
// ═════════════════════════════════════════════════════════════════════

describe("buildSafeguardingEmailBody", () => {
  it("E1 — matches the brief's exact format, no PII", () => {
    const t = new Date("2026-03-14T15:09:26.535Z");
    const body = buildSafeguardingEmailBody({
      category: "self_harm",
      orgName: "Test FE College",
      timestamp: t,
    });
    expect(body).toBe(
      [
        "A safeguarding alert has been triggered.",
        "",
        "Category: self_harm",
        "Organisation: Test FE College",
        "Time: 2026-03-14T15:09:26.535Z",
        "",
        "Log in to the Amber admin console to review.",
        "",
        "Do NOT reply to this email. This is an automated alert.",
      ].join("\n")
    );

    // Belt-and-braces: privacy assertions phrased the way a reviewer
    // would phrase them, so a regression that quietly adds PII screams.
    expect(body).not.toMatch(/learner/i);
    expect(body).not.toMatch(/session/i);
    expect(body).not.toMatch(/message/i);
    expect(body).not.toMatch(/@/); // no embedded email addresses
  });
});

// ═════════════════════════════════════════════════════════════════════
// E2 / E3 / E4 — Send + lookup + stamp
// ═════════════════════════════════════════════════════════════════════

describe("sendSafeguardingAlertEmail", () => {
  it("E2 — sends with SAFEGUARDING_EMAIL recipient, exact subject, text-only body", async () => {
    const org = await createOrg("Newcastle FE");
    const alert = await createAlert(org._id);

    const res = await sendSafeguardingAlertEmail({
      category: "self_harm",
      org_id: org._id.toString(),
      alert_id: alert._id.toString(),
      alert_created_at: alert.createdAt.toISOString(),
    });

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const call = sendMailMock.mock.calls[0][0];
    expect(call.to).toBe("safeguarding-test@ambertraining.local");
    expect(call.subject).toBe("[URGENT] Safeguarding alert triggered");
    expect(call.from).toMatch(/<amber-bot@ambertraining\.local>$/);
    expect(typeof call.text).toBe("string");
    expect(call.text).toMatch(/^A safeguarding alert has been triggered\.\n/);
    expect(call.text).toMatch(/Category: self_harm/);
    expect(call.text).toMatch(/Organisation: Newcastle FE/);
    // No HTML rendering path
    expect(call.html).toBeUndefined();
    expect(call.template).toBeUndefined();

    expect(res.sent).toBe(true);
    expect(res.recipient).toBe("safeguarding-test@ambertraining.local");
    expect(res.message_id).toBe("<test-message-id@local>");
  });

  it("E3 — falls back to '(unknown organisation)' when org_id is stale", async () => {
    const alert = await createAlert(new Types.ObjectId());
    const orphanOrgId = new Types.ObjectId().toString();

    await sendSafeguardingAlertEmail({
      category: "domestic_abuse",
      org_id: orphanOrgId,
      alert_id: alert._id.toString(),
      alert_created_at: alert.createdAt.toISOString(),
    });

    const call = sendMailMock.mock.calls[0][0];
    expect(call.text).toMatch(/Organisation: \(unknown organisation\)/);
    // Still delivers, doesn't throw — the DSL still gets paged
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("E4 — stamps notificationSentAt on the SafeguardingAlert", async () => {
    const org = await createOrg();
    const alert = await createAlert(org._id);
    expect(alert.notificationSentAt).toBeFalsy();

    await sendSafeguardingAlertEmail({
      category: "self_harm",
      org_id: org._id.toString(),
      alert_id: alert._id.toString(),
      alert_created_at: alert.createdAt.toISOString(),
    });

    // The stamp is best-effort (fire-and-forget) — give it a microtask.
    await new Promise((r) => setImmediate(r));
    const reloaded = await SafeguardingAlert.findById(alert._id);
    expect(reloaded?.notificationSentAt).toBeInstanceOf(Date);
  });
});

// ═════════════════════════════════════════════════════════════════════
// E5 — Latency metric
// ═════════════════════════════════════════════════════════════════════

describe("dispatch latency metric", () => {
  it("E5 — logs WARN when end-to-end latency exceeds 5s SLA", async () => {
    const org = await createOrg();
    const alert = await createAlert(org._id);

    // Pretend the alert was created 7 seconds ago — over the 5s budget.
    const sevenSecondsAgo = new Date(Date.now() - 7_000).toISOString();
    const warnSpy = jest.spyOn(logger, "warn");

    await sendSafeguardingAlertEmail({
      category: "exploitation",
      org_id: org._id.toString(),
      alert_id: alert._id.toString(),
      alert_created_at: sevenSecondsAgo,
    });

    const warnHit = warnSpy.mock.calls.find((args) =>
      typeof args[1] === "string"
        ? /exceeded 5000ms SLA/.test(args[1])
        : false
    );
    expect(warnHit).toBeDefined();
    const meta = warnHit?.[0] as { dispatch_latency_ms: number };
    expect(meta.dispatch_latency_ms).toBeGreaterThanOrEqual(7_000);
    warnSpy.mockRestore();
  });

  it("E5.b — logs INFO with metric meta when latency is within SLA", async () => {
    const org = await createOrg();
    const alert = await createAlert(org._id);
    const infoSpy = jest.spyOn(logger, "info");

    await sendSafeguardingAlertEmail({
      category: "self_harm",
      org_id: org._id.toString(),
      alert_id: alert._id.toString(),
      alert_created_at: new Date().toISOString(),
    });

    const infoHit = infoSpy.mock.calls.find((args) =>
      typeof args[1] === "string"
        ? args[1] === "Safeguarding alert email sent"
        : false
    );
    expect(infoHit).toBeDefined();
    const meta = infoHit?.[0] as {
      dispatch_latency_ms: number;
      worker_latency_ms: number;
      message_id?: string;
    };
    expect(meta.dispatch_latency_ms).toBeGreaterThanOrEqual(0);
    expect(meta.dispatch_latency_ms).toBeLessThan(5_000);
    expect(meta.worker_latency_ms).toBeGreaterThanOrEqual(0);
    expect(meta.message_id).toBe("<test-message-id@local>");
    infoSpy.mockRestore();
  });
});

// ═════════════════════════════════════════════════════════════════════
// E6 — Dispatcher behaviour
// ═════════════════════════════════════════════════════════════════════

describe("processNotifications dispatcher", () => {
  it("E6 — dispatches job.name 'safeguarding-alert' to the email sender", async () => {
    const org = await createOrg();
    const alert = await createAlert(org._id);

    // BullMQ Job shape minimised — only the fields the processor reads
    const fakeJob = {
      id: "test-job-1",
      name: "safeguarding-alert",
      data: {
        category: "mental_health_crisis",
        org_id: org._id.toString(),
        alert_id: alert._id.toString(),
        alert_created_at: alert.createdAt.toISOString(),
      },
    } as never;

    const result = await processNotifications(fakeJob);
    expect(result.kind).toBe("safeguarding-alert");
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("E6.b — rejects an invalid payload (missing alert_created_at)", async () => {
    const fakeJob = {
      id: "test-job-2",
      name: "safeguarding-alert",
      data: { category: "self_harm", org_id: "abc" },
    } as never;

    await expect(processNotifications(fakeJob)).rejects.toThrow(
      "Invalid safeguarding-alert payload"
    );
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("E6.c — unrecognised job.name falls through to the stub (no email)", async () => {
    const fakeJob = {
      id: "test-job-3",
      name: "teacher_message",
      data: { channel: "email", recipientId: "x", type: "teacher_message", payload: {} },
    } as never;

    const result = await processNotifications(fakeJob);
    expect(result.kind).toBe("stub");
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
