/**
 * Tests for the admin MIS sync UI services —
 * Phase 4 / Final Addendum §7 (BE-D).
 *
 *   M1   listSyncLogs returns ONLY this org's MIS-related rows
 *   M2   listSyncLogs sort + pagination + summary aggregate
 *   M3   listConflicts returns ONLY this org's mis-push FailedJob
 *        rows that aren't dismissed
 *   M4   triggerSyncNow collects every student's ULN, enqueues a
 *        push-batch, writes an audit row, returns job_id + count
 *   M5   triggerSyncNow with no eligible ULNs returns 200 + 0
 *        without enqueueing
 *   M6   triggerSyncNow with explicit ulns body uses that list
 *   M7   resolveMisConflict flips dismissed=true + writes audit
 *   M8   resolveMisConflict is idempotent on already-dismissed
 *   M9   resolveMisConflict 404s on wrong org_id
 *  M10   validation rejects invalid orgId
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import FailedJob from "../models/FailedJob";
import {
  listSyncLogsService,
  listMisConflictsService,
  triggerSyncNowService,
  resolveMisConflictService,
} from "../services/adminMisSync.service";

// Mock the BullMQ queue — the test environment doesn't have Redis,
// and even if it did we don't want to actually push jobs from this
// suite. The queue's `.add` is the only method triggerSyncNowService
// calls; stubbing it returns a synthetic job id.
jest.mock("../queues", () => {
  const original = jest.requireActual("../queues");
  return {
    ...original,
    misPushQueue: {
      add: jest.fn().mockResolvedValue({ id: "mocked-job-id" }),
    },
  };
});

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "MIS Sync Org") =>
  Organisation.create({
    name,
    slug: `mso-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@mso.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createAdmin = async () =>
  User.create({
    firstname: "Amber",
    lastname: "Admin",
    email: `aa-${Date.now()}-${Math.random().toString(16).slice(2)}@mso.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "admin",
    isActive: true,
    status: "active",
    verified: true,
  });

const createStudent = async (
  orgId: unknown,
  uln: string | null,
  opts: { firstname?: string } = {},
) =>
  User.create({
    firstname: opts.firstname ?? "Stu",
    lastname: "Dent",
    email: `st-${Date.now()}-${Math.random().toString(16).slice(2)}@mso.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
    ...(uln !== null ? { uln: uln } : {}),
  });

interface SeedAuditArgs {
  orgId: unknown;
  action?: string;
  reason?: string;
  timestamp?: Date;
}
const seedAudit = (args: SeedAuditArgs) =>
  AuditLog.create({
    timestamp: args.timestamp ?? new Date(),
    actor_type: "amber_admin",
    actor_id: null,
    org_id: args.orgId,
    learner_id: null,
    action: args.action ?? "mis_push_completed",
    before_state: null,
    after_state: null,
    reason: args.reason ?? "seeded",
    compliance_config_version: null,
  });

const seedFailedJob = async (
  orgId: string,
  opts: {
    jobId?: string;
    error?: string;
    dismissed?: boolean;
    kind?: "push-learner" | "push-batch";
    uln?: string;
    createdAt?: Date;
  },
) =>
  FailedJob.create({
    queue_name: "mis-push",
    job_id: opts.jobId ?? `j-${Math.random().toString(16).slice(2)}`,
    job_data: {
      kind: opts.kind ?? "push-learner",
      org_id: orgId,
      uln: opts.uln ?? "1234567890",
    },
    error: opts.error ?? "synthetic error",
    attempts: 1,
    created_at: opts.createdAt ?? new Date(),
    dismissed: opts.dismissed ?? false,
  });

// ═════════════════════════════════════════════════════════════════════

describe("adminMisSync.service", () => {
  describe("listSyncLogsService", () => {
    it("M1 — returns only the supplied org's MIS-related rows", async () => {
      const mine = await createOrg("Mine");
      const other = await createOrg("Other");

      await seedAudit({
        orgId: mine._id,
        action: "mis_push_completed",
        reason: "mine-pushed",
      });
      await seedAudit({
        orgId: mine._id,
        action: "mis_push_held",
        reason: "mine-held",
      });
      // Non-MIS action — must be excluded.
      await seedAudit({
        orgId: mine._id,
        action: "session_completed",
        reason: "mine-session",
      });
      // Other org's row — must be excluded.
      await seedAudit({
        orgId: other._id,
        action: "mis_push_completed",
        reason: "other-pushed",
      });

      const res = await listSyncLogsService(mine._id.toString(), {});
      const data = res.data as {
        rows: Array<{ reason: string; action: string }>;
        pagination: { total: number };
      };
      expect(data.pagination.total).toBe(2);
      expect(data.rows.map((r) => r.reason).sort()).toEqual([
        "mine-held",
        "mine-pushed",
      ]);
    });

    it("M2 — sort desc, pagination shape, summary aggregate", async () => {
      const org = await createOrg();
      const now = new Date("2026-03-15T12:00:00Z");
      // 12 mis_push_completed + 3 mis_push_held + 1 mis_settings_updated
      for (let i = 0; i < 12; i++) {
        await seedAudit({
          orgId: org._id,
          action: "mis_push_completed",
          reason: `c${i}`,
          timestamp: new Date(now.getTime() - i * 60_000),
        });
      }
      for (let i = 0; i < 3; i++) {
        await seedAudit({
          orgId: org._id,
          action: "mis_push_held",
          reason: `h${i}`,
          timestamp: new Date(now.getTime() - (100 + i) * 60_000),
        });
      }
      await seedAudit({
        orgId: org._id,
        action: "mis_settings_updated",
        reason: "u",
        timestamp: new Date(now.getTime() - 200 * 60_000),
      });

      const res = await listSyncLogsService(org._id.toString(), {
        page: "1",
        limit: "10",
      });
      const data = res.data as {
        rows: Array<{ reason: string; timestamp: string }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          total_pages: number;
        };
        summary: {
          by_action: Record<string, number>;
          last_pushed_at: string | null;
        };
      };

      expect(data.rows).toHaveLength(10);
      // newest first
      expect(data.rows[0].reason).toBe("c0");
      expect(data.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 16,
        total_pages: 2,
      });
      expect(data.summary.by_action.mis_push_completed).toBe(12);
      expect(data.summary.by_action.mis_push_held).toBe(3);
      expect(data.summary.by_action.mis_settings_updated).toBe(1);
      expect(data.summary.last_pushed_at).toBe(now.toISOString());
    });
  });

  describe("listMisConflictsService", () => {
    it("M3 — only undismissed mis-push rows for this org", async () => {
      const mine = await createOrg();
      const other = await createOrg();

      await seedFailedJob(mine._id.toString(), { error: "mine-1" });
      await seedFailedJob(mine._id.toString(), { error: "mine-2" });
      await seedFailedJob(mine._id.toString(), {
        error: "mine-dismissed",
        dismissed: true,
      });
      await seedFailedJob(other._id.toString(), { error: "other-active" });

      const res = await listMisConflictsService(mine._id.toString(), {});
      const data = res.data as {
        rows: Array<{ error: string }>;
        pagination: { total: number };
      };
      expect(data.pagination.total).toBe(2);
      expect(data.rows.map((r) => r.error).sort()).toEqual([
        "mine-1",
        "mine-2",
      ]);
    });
  });

  describe("triggerSyncNowService", () => {
    it("M4 — collects student ULNs, enqueues, writes audit", async () => {
      const org = await createOrg();
      const admin = await createAdmin();
      await createStudent(org._id, "111111111A");
      await createStudent(org._id, "222222222B");
      await createStudent(org._id, null); // no ULN — excluded
      // Non-student (must be excluded even if uln somehow set).
      await User.create({
        firstname: "Stray",
        lastname: "Tutor",
        email: `tut-${Date.now()}@mso.local`,
        password: "x",
        phoneNumber: "07000000000",
        role: "tutor",
        orgId: org._id,
        isActive: true,
        status: "active",
        verified: true,
        uln: "999999999Z",
      });

      const res = await triggerSyncNowService({
        org_id: org._id.toString(),
        actor_user_id: admin._id.toString(),
      });
      const data = res.data as {
        job_id: string;
        ulns_enqueued: number;
        capped: boolean;
      };
      expect(res.statusCode).toBe(202);
      expect(data.ulns_enqueued).toBe(2);
      expect(data.capped).toBe(false);

      const audit = await AuditLog.findOne({
        org_id: org._id,
        action: "mis_settings_updated",
      }).lean();
      expect(audit).toBeTruthy();
      expect((audit as { reason: string }).reason).toContain("2 ULN");
    });

    it("M5 — no eligible ULNs → 200, ulns_enqueued: 0, no enqueue", async () => {
      const org = await createOrg();
      const admin = await createAdmin();

      const res = await triggerSyncNowService({
        org_id: org._id.toString(),
        actor_user_id: admin._id.toString(),
      });
      const data = res.data as {
        job_id: string;
        ulns_enqueued: number;
      };
      expect(res.statusCode).toBe(200);
      expect(data.ulns_enqueued).toBe(0);
      expect(data.job_id).toBe("");
    });

    it("M6 — explicit ulns body wins over org-wide collection", async () => {
      const org = await createOrg();
      const admin = await createAdmin();
      await createStudent(org._id, "AAAAAAAAA1");
      await createStudent(org._id, "BBBBBBBBB2");

      const res = await triggerSyncNowService({
        org_id: org._id.toString(),
        actor_user_id: admin._id.toString(),
        ulns: ["CCCCCCCCC3"],
      });
      const data = res.data as { ulns_enqueued: number };
      expect(data.ulns_enqueued).toBe(1);
    });

    it("M10a — invalid org id rejected with 400", async () => {
      const admin = await createAdmin();
      await expect(
        triggerSyncNowService({
          org_id: "not-an-objectid",
          actor_user_id: admin._id.toString(),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe("resolveMisConflictService", () => {
    it("M7 — flips dismissed=true + writes failed_job_dismissed audit", async () => {
      const org = await createOrg();
      const admin = await createAdmin();
      const fj = await seedFailedJob(org._id.toString(), {
        error: "live conflict",
      });

      const res = await resolveMisConflictService({
        conflict_id: String(fj._id),
        org_id: org._id.toString(),
        actor_user_id: admin._id.toString(),
        note: "Resolved manually by ops",
      });
      const data = res.data as {
        already_resolved: boolean;
        dismissed_at?: string;
      };
      expect(res.statusCode).toBe(200);
      expect(data.already_resolved).toBe(false);

      const after = await FailedJob.findById(String(fj._id)).lean();
      expect((after as { dismissed: boolean }).dismissed).toBe(true);
      expect(
        (after as { dismissed_by: Types.ObjectId }).dismissed_by.toString(),
      ).toBe(admin._id.toString());

      const audit = await AuditLog.findOne({
        org_id: org._id,
        action: "failed_job_dismissed",
      }).lean();
      expect(audit).toBeTruthy();
      expect((audit as { reason: string }).reason).toContain(
        "Resolved manually",
      );
    });

    it("M8 — already-dismissed conflict returns already_resolved=true", async () => {
      const org = await createOrg();
      const admin = await createAdmin();
      const fj = await seedFailedJob(org._id.toString(), {
        error: "stale",
        dismissed: true,
      });
      const res = await resolveMisConflictService({
        conflict_id: String(fj._id),
        org_id: org._id.toString(),
        actor_user_id: admin._id.toString(),
      });
      const data = res.data as { already_resolved: boolean };
      expect(data.already_resolved).toBe(true);
    });

    it("M9 — conflict belonging to a different org → 404", async () => {
      const mine = await createOrg();
      const other = await createOrg();
      const admin = await createAdmin();
      const fj = await seedFailedJob(other._id.toString(), {
        error: "other-orgs",
      });

      await expect(
        resolveMisConflictService({
          conflict_id: String(fj._id),
          org_id: mine._id.toString(),
          actor_user_id: admin._id.toString(),
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("M10b — invalid conflict id rejected with 400", async () => {
      const org = await createOrg();
      const admin = await createAdmin();
      await expect(
        resolveMisConflictService({
          conflict_id: "not-an-objectid",
          org_id: org._id.toString(),
          actor_user_id: admin._id.toString(),
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
