/**
 * Tests for the org-admin onboarding embed services —
 * Phase 2 / Final Addendum §13 (BE-G).
 *
 *   O1   getStatus returns { completed_at: null } when org never stamped
 *   O2   getStatus returns the stamped ISO timestamp when set
 *   O3   markComplete on a fresh org flips the flag + writes audit row
 *   O4   markComplete is idempotent — second call returns the same
 *        timestamp WITHOUT writing a duplicate audit row
 *   O5   invalid orgId on either op → 400
 *   O6   missing actor on markComplete → 400
 *   O7   missing org → 404 on both ops
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import {
  getOrgOnboardingStatusService,
  markOrgOnboardingCompleteService,
} from "../services/orgOnboarding.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (
  opts: { name?: string; alreadyOnboarded?: boolean } = {},
) => {
  const org = await Organisation.create({
    name: opts.name ?? "Onboard Org",
    slug: `oo-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@oo.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
    ...(opts.alreadyOnboarded
      ? { org_onboarding_completed_at: new Date("2026-01-01T10:00:00Z") }
      : {}),
  });
  return org;
};

const createOrgAdmin = async (orgId: unknown) =>
  User.create({
    firstname: "Org",
    lastname: "Admin",
    email: `oa-${Date.now()}-${Math.random().toString(16).slice(2)}@oo.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "org_admin",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
  });

// ═════════════════════════════════════════════════════════════════════

describe("orgOnboarding.service", () => {
  describe("getOrgOnboardingStatusService", () => {
    it("O1 — returns completed_at: null when org never stamped", async () => {
      const org = await createOrg();
      const res = await getOrgOnboardingStatusService(org._id.toString());
      const data = res.data as { completed_at: string | null };
      expect(res.statusCode).toBe(200);
      expect(data.completed_at).toBeNull();
    });

    it("O2 — returns the stamped ISO timestamp when set", async () => {
      const org = await createOrg({ alreadyOnboarded: true });
      const res = await getOrgOnboardingStatusService(org._id.toString());
      const data = res.data as { completed_at: string | null };
      expect(data.completed_at).toBe("2026-01-01T10:00:00.000Z");
    });

    it("O5a — invalid orgId rejected with 400", async () => {
      await expect(
        getOrgOnboardingStatusService("not-an-objectid"),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("O7a — missing org rejected with 404", async () => {
      await expect(
        getOrgOnboardingStatusService(new Types.ObjectId().toString()),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("markOrgOnboardingCompleteService", () => {
    it("O3 — fresh org: flips the flag + writes audit row", async () => {
      const org = await createOrg();
      const admin = await createOrgAdmin(org._id);

      const auditBefore = await AuditLog.countDocuments({
        org_id: org._id,
        action: "org_onboarding_completed",
      });
      expect(auditBefore).toBe(0);

      const res = await markOrgOnboardingCompleteService({
        org_id: org._id.toString(),
        actor_user_id: admin._id.toString(),
        source: "roi_calculator_submitted",
      });
      const data = res.data as {
        completed_at: string;
        already_completed: boolean;
      };

      expect(res.statusCode).toBe(201);
      expect(data.already_completed).toBe(false);
      expect(typeof data.completed_at).toBe("string");

      // Field was actually persisted.
      const persisted = await Organisation.findById(org._id)
        .select("org_onboarding_completed_at")
        .lean();
      expect(
        (persisted as { org_onboarding_completed_at?: Date | null } | null)
          ?.org_onboarding_completed_at,
      ).toBeInstanceOf(Date);

      // Audit row was written, exactly one.
      const rows = await AuditLog.find({
        org_id: org._id,
        action: "org_onboarding_completed",
      })
        .lean()
        .exec();
      expect(rows).toHaveLength(1);
      const row = rows[0] as unknown as {
        actor_type: string;
        actor_id: Types.ObjectId | null;
        reason: string;
      };
      expect(row.actor_type).toBe("org_admin");
      expect(row.actor_id?.toString()).toBe(admin._id.toString());
      expect(row.reason).toContain("roi_calculator_submitted");
    });

    it("O4 — idempotent: second call returns same timestamp, no duplicate audit", async () => {
      const org = await createOrg();
      const admin = await createOrgAdmin(org._id);

      const first = await markOrgOnboardingCompleteService({
        org_id: org._id.toString(),
        actor_user_id: admin._id.toString(),
        source: "roi_calculator_submitted",
      });
      const firstStamp = (first.data as { completed_at: string }).completed_at;
      expect(firstStamp).toBeTruthy();

      const second = await markOrgOnboardingCompleteService({
        org_id: org._id.toString(),
        actor_user_id: admin._id.toString(),
        source: "skipped", // different source — must still be idempotent
      });
      const secondStamp = second.data as {
        completed_at: string;
        already_completed: boolean;
      };
      expect(secondStamp.already_completed).toBe(true);
      expect(secondStamp.completed_at).toBe(firstStamp);

      // Still exactly one audit row.
      const rows = await AuditLog.countDocuments({
        org_id: org._id,
        action: "org_onboarding_completed",
      });
      expect(rows).toBe(1);
    });

    it("O5b — invalid orgId rejected with 400", async () => {
      const admin = await createOrgAdmin(new Types.ObjectId());
      await expect(
        markOrgOnboardingCompleteService({
          org_id: "not-an-objectid",
          actor_user_id: admin._id.toString(),
          source: "skipped",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("O6 — missing actor rejected with 400", async () => {
      const org = await createOrg();
      await expect(
        markOrgOnboardingCompleteService({
          org_id: org._id.toString(),
          actor_user_id: "",
          source: "skipped",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("O7b — missing org rejected with 404", async () => {
      const admin = await createOrgAdmin(new Types.ObjectId());
      await expect(
        markOrgOnboardingCompleteService({
          org_id: new Types.ObjectId().toString(),
          actor_user_id: admin._id.toString(),
          source: "skipped",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });
});
