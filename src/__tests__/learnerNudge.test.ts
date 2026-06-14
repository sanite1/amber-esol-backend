/**
 * Tests for POST /api/org-admin/learners/:id/nudge — Function 12 To-Do 4.
 *
 *   N1   Happy path: enqueues learner-nudge-email with the right
 *        payload, writes AuditLog "learner_nudge_sent", returns 200
 *   N2   CSV-placeholder email → skipped (200), no queue enqueue,
 *        audit row carries reason: "no_real_email"
 *   N3   Empty email → same skipped path as N2
 *   N4   custom_message gets trimmed + passed through to the payload
 *   N5   custom_message over 1000 chars → 400
 *   N6   org_admin from a different org → 403 (the ACL gate, asserted)
 *   N7   Non-existent learner → 404; invalid id → 400
 *   N8   L1 language passed through to the email payload
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

const notificationsAdd = jest.fn().mockResolvedValue({ id: "fake" });
jest.mock("../queues", () => ({
  __esModule: true,
  notificationsQueue: { add: notificationsAdd },
  priorityQueueQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  esolSessionQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { sendLearnerNudgeService } from "../services/learnerNudge.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async () =>
  Organisation.create({
    name: "Nudge Org",
    slug: `nudge-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@nudge.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

interface LearnerOpts {
  orgId: unknown;
  email?: string;
  l1?: string;
}
const createLearner = async (opts: LearnerOpts) =>
  User.create({
    firstname: "Nudge",
    lastname: "Learner",
    email:
      opts.email ??
      `nudge-${Date.now()}-${Math.random().toString(16).slice(2)}@nudge.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId: opts.orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: "e2",
    l1Language: opts.l1 ?? "english",
  });

const createOrgAdmin = async (orgId: unknown) =>
  User.create({
    firstname: "Org",
    lastname: "Admin",
    email: `oa-${Date.now()}-${Math.random().toString(16).slice(2)}@nudge.local`,
    password: "x",
    phoneNumber: "07000000099",
    role: "org_admin",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
  });

beforeEach(() => {
  notificationsAdd.mockClear();
});

// ═════════════════════════════════════════════════════════════════════

describe("sendLearnerNudgeService", () => {
  it("N1 — happy path: enqueues email, writes audit row, returns 200", async () => {
    const org = await createOrg();
    const admin = await createOrgAdmin(org._id);
    const learner = await createLearner({ orgId: org._id, l1: "arabic" });

    const res = await sendLearnerNudgeService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      admin._id.toString(),
      {},
    );

    const data = res.data as { email_sent: boolean; l1_language_used: string };
    expect(data.email_sent).toBe(true);
    expect(data.l1_language_used).toBe("arabic");

    // Email enqueued
    expect(notificationsAdd).toHaveBeenCalledTimes(1);
    const [name, payload] = notificationsAdd.mock.calls[0];
    expect(name).toBe("learner-nudge-email");
    expect(payload.payload.learner_email).toBe(learner.email);
    expect(payload.payload.l1_language).toBe("arabic");
    expect(payload.payload.custom_message).toBeNull();

    // Audit row
    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "learner_nudge_sent",
    }).lean();
    expect(audit).toBeTruthy();
    expect((audit?.after_state as { email_sent?: boolean })?.email_sent).toBe(
      true,
    );
    expect(audit?.actor_id?.toString()).toBe(admin._id.toString());
  });

  it("N2 — CSV-placeholder email → skipped, no queue, audit explains why", async () => {
    const org = await createOrg();
    const admin = await createOrgAdmin(org._id);
    const learner = await createLearner({
      orgId: org._id,
      email: "csv-placeholder-abc123def456@example.local",
    });

    const res = await sendLearnerNudgeService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      admin._id.toString(),
      {},
    );

    const data = res.data as { email_sent: boolean; reason: string };
    expect(data.email_sent).toBe(false);
    expect(data.reason).toBe("no_real_email");
    expect(notificationsAdd).not.toHaveBeenCalled();

    const audit = await AuditLog.findOne({
      learner_id: learner._id,
      action: "learner_nudge_sent",
    }).lean();
    expect(audit).toBeTruthy();
    expect((audit?.after_state as { reason?: string })?.reason).toBe(
      "no_real_email",
    );
  });

  it("N3 — empty email → skipped same way", async () => {
    const org = await createOrg();
    const admin = await createOrgAdmin(org._id);
    // Create the learner then null out the email (the schema requires it on create)
    const learner = await createLearner({ orgId: org._id });
    await User.collection.updateOne(
      { _id: learner._id as unknown as never },
      { $set: { email: "" } },
    );

    const res = await sendLearnerNudgeService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      admin._id.toString(),
      {},
    );
    const data = res.data as { email_sent: boolean; reason: string };
    expect(data.email_sent).toBe(false);
    expect(data.reason).toBe("no_real_email");
  });

  it("N4 — custom_message trimmed and propagated", async () => {
    const org = await createOrg();
    const admin = await createOrgAdmin(org._id);
    const learner = await createLearner({ orgId: org._id });

    await sendLearnerNudgeService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      admin._id.toString(),
      { custom_message: "   Your tutor is asking after you.   " },
    );

    const [, payload] = notificationsAdd.mock.calls[0];
    expect(payload.payload.custom_message).toBe(
      "Your tutor is asking after you.",
    );
  });

  it("N5 — custom_message over 1000 chars → 400", async () => {
    const org = await createOrg();
    const admin = await createOrgAdmin(org._id);
    const learner = await createLearner({ orgId: org._id });

    await expect(
      sendLearnerNudgeService(
        learner._id.toString(),
        "org_admin",
        org._id.toString(),
        admin._id.toString(),
        { custom_message: "x".repeat(1_001) },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("N6 — org_admin from a different org → 403", async () => {
    const orgMine = await createOrg();
    const orgOther = await createOrg();
    const admin = await createOrgAdmin(orgMine._id);
    const learnerInOther = await createLearner({ orgId: orgOther._id });

    await expect(
      sendLearnerNudgeService(
        learnerInOther._id.toString(),
        "org_admin",
        orgMine._id.toString(), // caller's org
        admin._id.toString(),
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(notificationsAdd).not.toHaveBeenCalled();
  });

  it("N7 — non-existent learner → 404; invalid id → 400", async () => {
    const org = await createOrg();
    const admin = await createOrgAdmin(org._id);

    await expect(
      sendLearnerNudgeService(
        new Types.ObjectId().toString(),
        "org_admin",
        org._id.toString(),
        admin._id.toString(),
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      sendLearnerNudgeService(
        "not-an-objectid",
        "org_admin",
        org._id.toString(),
        admin._id.toString(),
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("N8 — L1 language passed through verbatim", async () => {
    const org = await createOrg();
    const admin = await createOrgAdmin(org._id);
    const somaliLearner = await createLearner({ orgId: org._id, l1: "somali" });

    await sendLearnerNudgeService(
      somaliLearner._id.toString(),
      "org_admin",
      org._id.toString(),
      admin._id.toString(),
      {},
    );

    const [, payload] = notificationsAdd.mock.calls[0];
    expect(payload.payload.l1_language).toBe("somali");
  });
});
