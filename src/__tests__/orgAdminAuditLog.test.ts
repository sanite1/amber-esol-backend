/**
 * Tests for GET /api/org-admin/audit-log — Final Addendum §6.
 *
 *   A1   Scoped to caller's org_id; other-org entries invisible
 *   A2   Sort timestamp desc (newest first)
 *   A3   Pagination shape + total + total_pages
 *   A4   ?learner_id filter narrows to that learner's entries
 *   A5   ?action filter narrows to that action
 *   A6   ?from / ?to date range filter (YYYY-MM-DD accepted)
 *   A7   actor_name resolved when actor_id is set
 *   A8   learner_name resolved when learner_id is set
 *   A9   actor_id null (system actions) → actor_name null, no crash
 *  A10   Pagination bounds: limit < 10 or > 200 → 400; page < 1 → 400
 *  A11   Invalid action → 400
 *  A12   Invalid date / from > to → 400
 *  A13   reason field returned verbatim (the inspector-facing copy)
 */

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { listOrgAdminAuditLogService } from "../services/orgAdminAuditLog.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "AL Org") =>
  Organisation.create({
    name,
    slug: `al-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@al.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createUser = async (
  orgId: unknown,
  opts: { role?: string; firstname?: string; lastname?: string } = {},
) =>
  User.create({
    firstname: opts.firstname ?? "Test",
    lastname: opts.lastname ?? "User",
    email: `u-${Date.now()}-${Math.random().toString(16).slice(2)}@al.local`,
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
  learnerId?: unknown;
  actorId?: unknown;
  actorType?: string;
  action?: string;
  reason?: string;
  timestamp?: Date;
  before?: unknown;
  after?: unknown;
  version?: number | null;
}
const seedAudit = (args: SeedAuditArgs) =>
  AuditLog.create({
    timestamp: args.timestamp ?? new Date(),
    actor_type: args.actorType ?? "system",
    actor_id: args.actorId ?? null,
    org_id: args.orgId,
    learner_id: args.learnerId ?? null,
    action: args.action ?? "session_completed",
    before_state: args.before ?? null,
    after_state: args.after ?? null,
    reason: args.reason ?? "default reason",
    compliance_config_version: args.version ?? null,
  });

// ═════════════════════════════════════════════════════════════════════
// A1 — org scoping
// ═════════════════════════════════════════════════════════════════════

describe("listOrgAdminAuditLogService", () => {
  it("A1 — only the caller's org entries are visible", async () => {
    const orgMine = await createOrg("Mine");
    const orgOther = await createOrg("Other");
    const learner = await createUser(orgMine._id);

    await seedAudit({ orgId: orgMine._id, learnerId: learner._id, reason: "mine 1" });
    await seedAudit({ orgId: orgMine._id, learnerId: learner._id, reason: "mine 2" });
    await seedAudit({ orgId: orgOther._id, reason: "other 1" });
    await seedAudit({ orgId: orgOther._id, reason: "other 2" });
    await seedAudit({ orgId: orgOther._id, reason: "other 3" });

    const res = await listOrgAdminAuditLogService(orgMine._id.toString(), {});
    const data = res.data as {
      rows: Array<{ reason: string }>;
      pagination: { total: number };
    };
    expect(data.pagination.total).toBe(2);
    expect(data.rows.map((r) => r.reason).sort()).toEqual(["mine 1", "mine 2"]);
  });

  it("A2 — sorted by timestamp desc", async () => {
    const org = await createOrg();
    const t0 = new Date("2026-01-01T10:00:00Z");
    const t1 = new Date("2026-02-01T10:00:00Z");
    const t2 = new Date("2026-03-01T10:00:00Z");
    await seedAudit({ orgId: org._id, reason: "first", timestamp: t0 });
    await seedAudit({ orgId: org._id, reason: "second", timestamp: t1 });
    await seedAudit({ orgId: org._id, reason: "third", timestamp: t2 });

    const res = await listOrgAdminAuditLogService(org._id.toString(), {});
    const rows = (res.data as { rows: Array<{ reason: string; timestamp: string }> }).rows;
    expect(rows.map((r) => r.reason)).toEqual(["third", "second", "first"]);
  });

  it("A3 — pagination shape", async () => {
    const org = await createOrg();
    for (let i = 0; i < 25; i++) {
      await seedAudit({
        orgId: org._id,
        reason: `entry ${i}`,
        timestamp: new Date(2026, 0, 1, 0, i),
      });
    }
    const res = await listOrgAdminAuditLogService(org._id.toString(), {
      page: "2",
      limit: "10",
    });
    const data = res.data as {
      rows: Array<unknown>;
      pagination: { page: number; limit: number; total: number; total_pages: number };
    };
    expect(data.rows).toHaveLength(10);
    expect(data.pagination).toEqual({ page: 2, limit: 10, total: 25, total_pages: 3 });
  });

  it("A4 — learner_id filter narrows the result set", async () => {
    const org = await createOrg();
    const learnerA = await createUser(org._id, { firstname: "Aaron" });
    const learnerB = await createUser(org._id, { firstname: "Bea" });
    await seedAudit({ orgId: org._id, learnerId: learnerA._id, reason: "A1" });
    await seedAudit({ orgId: org._id, learnerId: learnerA._id, reason: "A2" });
    await seedAudit({ orgId: org._id, learnerId: learnerB._id, reason: "B1" });

    const res = await listOrgAdminAuditLogService(org._id.toString(), {
      learner_id: learnerA._id.toString(),
    });
    const data = res.data as { rows: Array<{ reason: string }>; pagination: { total: number } };
    expect(data.pagination.total).toBe(2);
    expect(data.rows.map((r) => r.reason).sort()).toEqual(["A1", "A2"]);
  });

  it("A5 — action filter narrows the result set", async () => {
    const org = await createOrg();
    await seedAudit({ orgId: org._id, action: "level_change_confirmed", reason: "promotion" });
    await seedAudit({ orgId: org._id, action: "session_completed", reason: "session" });
    await seedAudit({ orgId: org._id, action: "session_completed", reason: "session 2" });

    const res = await listOrgAdminAuditLogService(org._id.toString(), {
      action: "session_completed",
    });
    const data = res.data as { pagination: { total: number } };
    expect(data.pagination.total).toBe(2);
  });

  it("A6 — from/to date filter (YYYY-MM-DD accepted)", async () => {
    const org = await createOrg();
    await seedAudit({
      orgId: org._id,
      reason: "before",
      timestamp: new Date("2026-01-15T10:00:00Z"),
    });
    await seedAudit({
      orgId: org._id,
      reason: "in window",
      timestamp: new Date("2026-02-15T10:00:00Z"),
    });
    await seedAudit({
      orgId: org._id,
      reason: "after",
      timestamp: new Date("2026-03-15T10:00:00Z"),
    });

    const res = await listOrgAdminAuditLogService(org._id.toString(), {
      from: "2026-02-01",
      to: "2026-02-28",
    });
    const data = res.data as { rows: Array<{ reason: string }>; pagination: { total: number } };
    expect(data.pagination.total).toBe(1);
    expect(data.rows[0].reason).toBe("in window");
  });

  it("A7 — actor_name resolved from actor_id", async () => {
    const org = await createOrg();
    const actor = await createUser(org._id, {
      role: "org_admin",
      firstname: "Ada",
      lastname: "Admin",
    });
    await seedAudit({
      orgId: org._id,
      actorId: actor._id,
      actorType: "org_admin",
      reason: "did a thing",
    });

    const res = await listOrgAdminAuditLogService(org._id.toString(), {});
    const row = (res.data as { rows: Array<{ actor_name: string | null; actor_id: string | null }> }).rows[0];
    expect(row.actor_name).toBe("Ada Admin");
    expect(row.actor_id).toBe(actor._id.toString());
  });

  it("A8 — learner_name resolved from learner_id", async () => {
    const org = await createOrg();
    const learner = await createUser(org._id, {
      firstname: "Liam",
      lastname: "Learner",
    });
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      reason: "about the learner",
    });

    const res = await listOrgAdminAuditLogService(org._id.toString(), {});
    const row = (res.data as { rows: Array<{ learner_name: string | null }> }).rows[0];
    expect(row.learner_name).toBe("Liam Learner");
  });

  it("A9 — system actions (actor_id null) render actor_name as null without crashing", async () => {
    const org = await createOrg();
    const learner = await createUser(org._id);
    await seedAudit({
      orgId: org._id,
      learnerId: learner._id,
      actorId: null,
      actorType: "system",
      action: "cohort_status_changed",
      reason: "daily cron sweep",
    });

    const res = await listOrgAdminAuditLogService(org._id.toString(), {});
    const row = (res.data as { rows: Array<{ actor_name: string | null; actor_type: string }> }).rows[0];
    expect(row.actor_name).toBeNull();
    expect(row.actor_type).toBe("system");
  });
});

// ═════════════════════════════════════════════════════════════════════
// A10–A12 — Input validation
// ═════════════════════════════════════════════════════════════════════

describe("validation", () => {
  it("A10 — limit out of range / page < 1 → 400", async () => {
    const org = await createOrg();
    await expect(
      listOrgAdminAuditLogService(org._id.toString(), { limit: "5" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      listOrgAdminAuditLogService(org._id.toString(), { limit: "999" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      listOrgAdminAuditLogService(org._id.toString(), { page: "0" }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("A11 — unknown action → 400", async () => {
    const org = await createOrg();
    await expect(
      listOrgAdminAuditLogService(org._id.toString(), {
        action: "not_a_real_action",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("A12 — bad date / from > to → 400", async () => {
    const org = await createOrg();
    await expect(
      listOrgAdminAuditLogService(org._id.toString(), { from: "not a date" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      listOrgAdminAuditLogService(org._id.toString(), {
        from: "2026-03-01",
        to: "2026-01-01",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("A13 — reason returned verbatim (the inspector-facing copy)", async () => {
    const org = await createOrg();
    const verbatim =
      "Amber admin confirmed progression: criteria_met includes a 22-day track at E2 with avg 0.83";
    await seedAudit({
      orgId: org._id,
      action: "level_change_confirmed",
      reason: verbatim,
    });

    const res = await listOrgAdminAuditLogService(org._id.toString(), {});
    const row = (res.data as { rows: Array<{ reason: string }> }).rows[0];
    expect(row.reason).toBe(verbatim);
  });
});
