/**
 * Tests for GET /api/learner/me/audit-log — Final Addendum §6 (BE-A).
 *
 *   L1   Caller sees only their OWN rows (no cross-learner leakage)
 *   L2   Sorted by timestamp desc (newest first)
 *   L3   Pagination shape + total + total_pages
 *   L4   ?from / ?to date range filter
 *   L5   Invalid learnerId → 400
 *   L6   Pagination bounds: limit out of range / page < 1 → 400
 *   L7   reason field returned verbatim (the inspector-facing copy)
 *
 * What we explicitly do NOT test (by design):
 *   - learner_id filter — the service hardcodes it from the JWT; no
 *     query input can pivot to another learner.
 *   - action filter — not accepted by the learner endpoint (validation
 *     layer rejects it at the route level, not the service).
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { listLearnerAuditLogService } from "../services/learnerAuditLog.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures — kept local to this file to avoid coupling to other test
// fixture changes. Tiny enough that duplication is cheaper than
// extracting a shared helper.
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "Learner Audit Org") =>
  Organisation.create({
    name,
    slug: `lal-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@lal.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createUser = async (
  orgId: unknown,
  opts: { role?: string; firstname?: string } = {},
) =>
  User.create({
    firstname: opts.firstname ?? "Test",
    lastname: "Learner",
    email: `lu-${Date.now()}-${Math.random().toString(16).slice(2)}@lal.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: opts.role ?? "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
  });

interface SeedAuditArgs {
  orgId: unknown;
  learnerId: unknown;
  actorId?: unknown;
  actorType?: string;
  action?: string;
  reason?: string;
  timestamp?: Date;
}
const seedAudit = (args: SeedAuditArgs) =>
  AuditLog.create({
    timestamp: args.timestamp ?? new Date(),
    actor_type: args.actorType ?? "system",
    actor_id: args.actorId ?? null,
    org_id: args.orgId,
    learner_id: args.learnerId,
    action: args.action ?? "session_completed",
    before_state: null,
    after_state: null,
    reason: args.reason ?? "default reason",
    compliance_config_version: null,
  });

// ═════════════════════════════════════════════════════════════════════

describe("listLearnerAuditLogService", () => {
  it("L1 — caller sees only their own rows", async () => {
    const org = await createOrg();
    const learnerMe = await createUser(org._id, { firstname: "Me" });
    const learnerThem = await createUser(org._id, { firstname: "Them" });

    await seedAudit({
      orgId: org._id,
      learnerId: learnerMe._id,
      reason: "mine 1",
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learnerMe._id,
      reason: "mine 2",
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learnerThem._id,
      reason: "theirs 1",
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learnerThem._id,
      reason: "theirs 2",
    });

    const res = await listLearnerAuditLogService(
      learnerMe._id.toString(),
      org._id.toString(),
      {},
    );
    const data = res.data as {
      rows: Array<{ reason: string }>;
      pagination: { total: number };
    };
    expect(data.pagination.total).toBe(2);
    expect(data.rows.map((r) => r.reason).sort()).toEqual(["mine 1", "mine 2"]);
  });

  it("L2 — sorted by timestamp desc", async () => {
    const org = await createOrg();
    const learner = await createUser(org._id);
    const t0 = new Date("2026-01-01T10:00:00Z");
    const t1 = new Date("2026-02-01T10:00:00Z");
    const t2 = new Date("2026-03-01T10:00:00Z");
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "oldest",
      timestamp: t0,
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "middle",
      timestamp: t1,
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "newest",
      timestamp: t2,
    });

    const res = await listLearnerAuditLogService(
      learner._id.toString(),
      org._id.toString(),
      {},
    );
    const rows = (res.data as { rows: Array<{ reason: string }> }).rows;
    expect(rows.map((r) => r.reason)).toEqual(["newest", "middle", "oldest"]);
  });

  it("L3 — pagination shape", async () => {
    const org = await createOrg();
    const learner = await createUser(org._id);
    for (let i = 0; i < 25; i++) {
      await seedAudit({
        orgId: org._id,
        learnerId: learner._id,
        reason: `entry ${i}`,
        timestamp: new Date(2026, 0, 1, 0, i),
      });
    }
    const res = await listLearnerAuditLogService(
      learner._id.toString(),
      org._id.toString(),
      { page: "2", limit: "10" },
    );
    const data = res.data as {
      rows: Array<unknown>;
      pagination: {
        page: number;
        limit: number;
        total: number;
        total_pages: number;
      };
    };
    expect(data.rows).toHaveLength(10);
    expect(data.pagination).toEqual({
      page: 2,
      limit: 10,
      total: 25,
      total_pages: 3,
    });
  });

  it("L4 — from/to date range filter narrows the result set", async () => {
    const org = await createOrg();
    const learner = await createUser(org._id);
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "jan",
      timestamp: new Date("2026-01-15T10:00:00Z"),
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "feb",
      timestamp: new Date("2026-02-15T10:00:00Z"),
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "mar",
      timestamp: new Date("2026-03-15T10:00:00Z"),
    });

    const res = await listLearnerAuditLogService(
      learner._id.toString(),
      org._id.toString(),
      { from: "2026-02-01", to: "2026-02-28" },
    );
    const rows = (res.data as { rows: Array<{ reason: string }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("feb");
  });

  it("L5 — invalid learnerId rejected with 400", async () => {
    await expect(
      listLearnerAuditLogService("not-an-objectid", null, {}),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("L6 — bad pagination rejected with 400", async () => {
    const org = await createOrg();
    const learner = await createUser(org._id);

    await expect(
      listLearnerAuditLogService(learner._id.toString(), org._id.toString(), {
        page: "0",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      listLearnerAuditLogService(learner._id.toString(), org._id.toString(), {
        limit: "5", // below MIN_PAGE_SIZE = 10
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      listLearnerAuditLogService(learner._id.toString(), org._id.toString(), {
        limit: "999", // above MAX_PAGE_SIZE = 200
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("L7 — reason field returned verbatim", async () => {
    const org = await createOrg();
    const learner = await createUser(org._id);
    const inspectorCopy =
      "Stage 3 objective 'order food in a café' marked complete after 3 successful sessions.";
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: inspectorCopy,
    });

    const res = await listLearnerAuditLogService(
      learner._id.toString(),
      org._id.toString(),
      {},
    );
    const rows = (res.data as { rows: Array<{ reason: string }> }).rows;
    expect(rows[0].reason).toBe(inspectorCopy);
  });
});
