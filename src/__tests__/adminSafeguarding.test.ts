/**
 * Tests for the admin + org-admin safeguarding endpoints —
 * brief Function 10 / Function 15.
 *
 *   A1  Amber admin list: returns alerts across ALL orgs, hash-only,
 *       sorted by triggered_at desc, paginated
 *   A2  resolved=true / resolved=false filter
 *   A3  org_id + category filters
 *   A4  Amber admin detail: full response with learner name + org name,
 *       NO raw message, session populate excludes turns
 *   A5  PATCH resolve: stamps resolved_at / resolved_by / resolution_notes
 *       + flips status to "resolved"; rejects a second resolve (409)
 *   A6  PATCH validation: empty notes → 400, missing body → 400
 *   A7  404 for non-existent alert, 400 for invalid id
 *   O1  Org-admin count returns { open, resolved, total } only
 *   O2  Org-admin count scopes to caller's orgId — never sees other orgs
 *   O3  Org-admin count rejects callers with no org_id (400)
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import SafeguardingAlert from "../models/SafeguardingAlert";
import {
  listAdminSafeguardingAlertsService,
  getAdminSafeguardingAlertService,
  resolveAdminSafeguardingAlertService,
  getOrgAdminSafeguardingCountService,
} from "../services/adminSafeguarding.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name: string) =>
  Organisation.create({
    name,
    slug: `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
    contactEmail: `admin@${name.toLowerCase().replace(/\s+/g, "")}.local`,
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = async (orgId: unknown, firstname = "Test") =>
  User.create({
    firstname,
    lastname: "Learner",
    email: `learner-${Date.now()}-${Math.random().toString(16).slice(2)}@x.local`,
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

const createAdmin = async () =>
  User.create({
    firstname: "Amber",
    lastname: "Admin",
    email: `admin-${Date.now()}-${Math.random().toString(16).slice(2)}@amber.local`,
    password: "x",
    phoneNumber: "07000000001",
    role: "admin",
    isActive: true,
    status: "active",
    verified: true,
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

interface CreateAlertArgs {
  learnerId: unknown;
  orgId: unknown;
  sessionId: unknown;
  category?: string;
  alertLevel?: "low" | "medium" | "high" | "critical";
  createdAt?: Date;
  resolved?: boolean;
  message?: string;
}

const createAlert = async (args: CreateAlertArgs) => {
  const alert = await SafeguardingAlert.create({
    learnerId: args.learnerId,
    orgId: args.orgId,
    sessionId: args.sessionId,
    alertLevel: args.alertLevel ?? "critical",
    messageContentHash: "b".repeat(64),
    triggerCategory: args.category ?? "self_harm",
    triggerSource: "keyword",
    status: args.resolved ? "resolved" : "open",
    resolvedAt: args.resolved ? new Date() : null,
  });
  if (args.createdAt) {
    await SafeguardingAlert.collection.updateOne(
      { _id: alert._id },
      { $set: { createdAt: args.createdAt } },
    );
  }
  return alert;
};

// ═════════════════════════════════════════════════════════════════════
// A1–A3 — Amber-admin list
// ═════════════════════════════════════════════════════════════════════

describe("listAdminSafeguardingAlertsService", () => {
  it("A1 — returns alerts across ALL orgs, hash-only, recent-first, paginated", async () => {
    const orgA = await createOrg("Org A");
    const orgB = await createOrg("Org B");
    const learnerA = await createLearner(orgA._id, "Ada");
    const learnerB = await createLearner(orgB._id, "Bea");
    const sessA = await createSession(learnerA._id, orgA._id);
    const sessB = await createSession(learnerB._id, orgB._id);

    // 22 alerts with controlled createdAt — page 1 should be the latest 20
    const baseTime = new Date("2026-04-01T00:00:00Z").getTime();
    for (let i = 0; i < 22; i++) {
      await createAlert({
        learnerId: i % 2 === 0 ? learnerA._id : learnerB._id,
        orgId: i % 2 === 0 ? orgA._id : orgB._id,
        sessionId: i % 2 === 0 ? sessA._id : sessB._id,
        createdAt: new Date(baseTime + i * 60_000),
      });
    }

    const res = await listAdminSafeguardingAlertsService({});
    const data = res.data as {
      alerts: Array<{
        org_id: string;
        org_name: string | null;
        learner_name: string | null;
        message_content_hash: string;
        triggered_at: string;
      }>;
      pagination: {
        page: number;
        limit: number;
        total: number;
        total_pages: number;
      };
    };

    expect(data.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 22,
      total_pages: 2,
    });
    expect(data.alerts).toHaveLength(20);

    // Both orgs represented (no implicit scoping)
    const orgNames = new Set(data.alerts.map((a) => a.org_name));
    expect(orgNames.has("Org A")).toBe(true);
    expect(orgNames.has("Org B")).toBe(true);

    // Recent-first by triggered_at
    const times = data.alerts.map((a) => new Date(a.triggered_at).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }

    // Hash-only — every alert carries a 64-hex digest, no raw message field
    for (const a of data.alerts) {
      expect(a.message_content_hash).toMatch(/^[0-9a-f]{64}$/);
      // No accidental message-bearing fields leaked through toBriefResponse
      expect(JSON.stringify(a)).not.toMatch(/"message"\s*:/);
    }
  });

  it("A2 — resolved=true / resolved=false filter the result set", async () => {
    const org = await createOrg("Filter Org");
    const learner = await createLearner(org._id);
    const sess = await createSession(learner._id, org._id);

    await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
      resolved: false,
    });
    await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
      resolved: false,
    });
    await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
      resolved: true,
    });

    const open = await listAdminSafeguardingAlertsService({
      resolved: "false",
    });
    const resolved = await listAdminSafeguardingAlertsService({
      resolved: "true",
    });

    expect(
      (open.data as { pagination: { total: number } }).pagination.total,
    ).toBe(2);
    expect(
      (resolved.data as { pagination: { total: number } }).pagination.total,
    ).toBe(1);
  });

  it("A3 — org_id + category filter the result set", async () => {
    const orgA = await createOrg("Cat Org A");
    const orgB = await createOrg("Cat Org B");
    const lA = await createLearner(orgA._id);
    const lB = await createLearner(orgB._id);
    const sA = await createSession(lA._id, orgA._id);
    const sB = await createSession(lB._id, orgB._id);

    await createAlert({
      learnerId: lA._id,
      orgId: orgA._id,
      sessionId: sA._id,
      category: "self_harm",
    });
    await createAlert({
      learnerId: lA._id,
      orgId: orgA._id,
      sessionId: sA._id,
      category: "domestic_abuse",
    });
    await createAlert({
      learnerId: lB._id,
      orgId: orgB._id,
      sessionId: sB._id,
      category: "self_harm",
    });

    const byOrg = await listAdminSafeguardingAlertsService({
      org_id: orgA._id.toString(),
    });
    expect(
      (byOrg.data as { pagination: { total: number } }).pagination.total,
    ).toBe(2);

    const byCat = await listAdminSafeguardingAlertsService({
      category: "self_harm",
    });
    expect(
      (byCat.data as { pagination: { total: number } }).pagination.total,
    ).toBe(2);

    const both = await listAdminSafeguardingAlertsService({
      org_id: orgA._id.toString(),
      category: "self_harm",
    });
    expect(
      (both.data as { pagination: { total: number } }).pagination.total,
    ).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════
// A4 — Amber-admin detail
// ═════════════════════════════════════════════════════════════════════

describe("getAdminSafeguardingAlertService", () => {
  it("A4 — populates learner name + org name; never exposes raw message; session populate excludes turns", async () => {
    const org = await createOrg("Detail Org");
    const learner = await createLearner(org._id, "Detail");
    const sess = await createSession(learner._id, org._id);

    // Push a learner-typed turn into the session so we can verify the
    // populate excludes it — even if the alert detail leaks the populate
    // shape, turns[].originalInput must NEVER make it to the response.
    await AISession.updateOne(
      { _id: sess._id },
      {
        $push: {
          turns: {
            turnIndex: 0,
            originalInput: "LEAK-CANARY-LEARNER-DISCLOSURE",
            scrubbed: false,
            deepSeekResponse: "ok",
            claudeAssessment: "{}",
            timestamp: new Date(),
          },
        },
      },
    );

    const alert = await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
      category: "self_harm",
    });

    const res = await getAdminSafeguardingAlertService(alert._id.toString());
    const data = res.data as {
      alert: {
        learner_name: string | null;
        learner_email: string | null;
        org_name: string | null;
        message_content_hash: string;
        category: string | null;
        session_context: {
          esol_level: string | null;
          session_mode: string | null;
        } | null;
      };
    };

    expect(data.alert.learner_name).toBe("Detail Learner");
    expect(data.alert.learner_email).toMatch(/@x\.local$/);
    expect(data.alert.org_name).toBe("Detail Org");
    expect(data.alert.category).toBe("self_harm");
    expect(data.alert.message_content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.alert.session_context?.esol_level).toBe("e2");

    // The critical privacy assertion — the seeded turn canary MUST NOT
    // appear anywhere in the serialised response.
    expect(JSON.stringify(data)).not.toContain(
      "LEAK-CANARY-LEARNER-DISCLOSURE",
    );
    expect(JSON.stringify(data)).not.toMatch(/"turns"\s*:/);
    expect(JSON.stringify(data)).not.toMatch(/"originalInput"\s*:/);
  });
});

// ═════════════════════════════════════════════════════════════════════
// A5 — PATCH resolve
// ═════════════════════════════════════════════════════════════════════

describe("resolveAdminSafeguardingAlertService", () => {
  it("A5 — stamps resolved_at / resolved_by / resolution_notes + status=resolved", async () => {
    const org = await createOrg("Resolve Org");
    const learner = await createLearner(org._id);
    const sess = await createSession(learner._id, org._id);
    const admin = await createAdmin();
    const alert = await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
    });

    const before = await SafeguardingAlert.findById(alert._id).lean();
    expect(before?.resolvedAt).toBeFalsy();
    expect(before?.status).toBe("open");

    const res = await resolveAdminSafeguardingAlertService(
      alert._id.toString(),
      { resolution_notes: "DSL spoke to learner; safety plan in place." },
      admin._id.toString(),
    );

    const data = res.data as {
      alert: {
        status: string;
        resolved_at: string | null;
        resolved_by: string | null;
        resolver_name: string | null;
        resolution_notes: string | null;
      };
    };
    expect(data.alert.status).toBe("resolved");
    expect(data.alert.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.alert.resolved_by).toBe(admin._id.toString());
    expect(data.alert.resolver_name).toBe("Amber Admin");
    expect(data.alert.resolution_notes).toBe(
      "DSL spoke to learner; safety plan in place.",
    );

    // Mongo-level confirmation
    const after = await SafeguardingAlert.findById(alert._id).lean();
    expect(after?.status).toBe("resolved");
    expect(after?.resolvedAt).toBeInstanceOf(Date);
    expect(after?.resolvedBy?.toString()).toBe(admin._id.toString());
  });

  it("A5.b — rejects a second resolve attempt (409)", async () => {
    const org = await createOrg("Race Org");
    const learner = await createLearner(org._id);
    const sess = await createSession(learner._id, org._id);
    const admin = await createAdmin();
    const alert = await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
    });

    await resolveAdminSafeguardingAlertService(
      alert._id.toString(),
      { resolution_notes: "first" },
      admin._id.toString(),
    );

    await expect(
      resolveAdminSafeguardingAlertService(
        alert._id.toString(),
        { resolution_notes: "second" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("A6 — empty notes → 400", async () => {
    const org = await createOrg("Empty Org");
    const learner = await createLearner(org._id);
    const sess = await createSession(learner._id, org._id);
    const admin = await createAdmin();
    const alert = await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
    });

    await expect(
      resolveAdminSafeguardingAlertService(
        alert._id.toString(),
        { resolution_notes: "   " },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("A7 — 404 for non-existent alert, 400 for invalid id", async () => {
    const admin = await createAdmin();

    await expect(
      resolveAdminSafeguardingAlertService(
        new Types.ObjectId().toString(),
        { resolution_notes: "n/a" },
        admin._id.toString(),
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    await expect(
      getAdminSafeguardingAlertService("not-an-objectid"),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// ═════════════════════════════════════════════════════════════════════
// O1–O3 — Org-admin count
// ═════════════════════════════════════════════════════════════════════

describe("getOrgAdminSafeguardingCountService", () => {
  it("O1 — returns { open, resolved, total } and nothing else", async () => {
    const org = await createOrg("Count Org");
    const learner = await createLearner(org._id);
    const sess = await createSession(learner._id, org._id);

    await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
    });
    await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
    });
    await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
      resolved: true,
    });

    const res = await getOrgAdminSafeguardingCountService(
      org._id.toString(),
      {},
    );
    expect(res.data).toEqual({ open: 2, resolved: 1, total: 3 });

    // O1.b — projection contains NO alert details
    const serialised = JSON.stringify(res.data);
    expect(serialised).not.toMatch(/learner|category|level|hash|id/i);
  });

  it("O1.b — resolved=false returns only the open count", async () => {
    const org = await createOrg("Open Org");
    const learner = await createLearner(org._id);
    const sess = await createSession(learner._id, org._id);
    await createAlert({
      learnerId: learner._id,
      orgId: org._id,
      sessionId: sess._id,
    });

    const res = await getOrgAdminSafeguardingCountService(org._id.toString(), {
      resolved: "false",
    });
    expect(res.data).toEqual({ open: 1 });
  });

  it("O2 — scopes strictly to the caller's orgId (other-org alerts invisible)", async () => {
    const orgMine = await createOrg("Mine");
    const orgOther = await createOrg("Other");
    const lMine = await createLearner(orgMine._id);
    const lOther = await createLearner(orgOther._id);
    const sMine = await createSession(lMine._id, orgMine._id);
    const sOther = await createSession(lOther._id, orgOther._id);

    await createAlert({
      learnerId: lMine._id,
      orgId: orgMine._id,
      sessionId: sMine._id,
    });
    // Three alerts in the other org — must NOT be visible
    await createAlert({
      learnerId: lOther._id,
      orgId: orgOther._id,
      sessionId: sOther._id,
    });
    await createAlert({
      learnerId: lOther._id,
      orgId: orgOther._id,
      sessionId: sOther._id,
    });
    await createAlert({
      learnerId: lOther._id,
      orgId: orgOther._id,
      sessionId: sOther._id,
    });

    const res = await getOrgAdminSafeguardingCountService(
      orgMine._id.toString(),
      {},
    );
    expect(res.data).toEqual({ open: 1, resolved: 0, total: 1 });
  });

  it("O3 — null org_id (Amber admin calling the wrong endpoint) → 400", async () => {
    await expect(
      getOrgAdminSafeguardingCountService(null, {}),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      getOrgAdminSafeguardingCountService("not-an-objectid", {}),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
