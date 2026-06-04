/**
 * Tests for /api/esol/learners/:id/vocab-ledger and /sessions.
 *
 *   V1   Vocab ledger groups retained vs in_progress correctly
 *   V2   Vocab ledger in_progress sorted by last_seen_at ASC, then count
 *   V3   Sessions paginated, recent first, heavy fields projected out
 *   V4   org_admin viewing a learner in another org → 403
 *   V5   admin (Amber) viewing any learner → 200
 *   V6   Non-existent learner → 404
 *   V7   Invalid learner id → 400
 */

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import VocabLedger from "../models/VocabLedger";
import AISession from "../models/AISession";
import {
  getLearnerVocabLedgerService,
  getLearnerSessionsService,
} from "../services/esolLearner.service";
import ApiError from "../errors/apiError";

const createOrg = async () =>
  Organisation.create({
    name: "Detail Test Org",
    slug: `det-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "a@x.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = async (orgId: unknown) =>
  User.create({
    firstname: "T",
    lastname: "L",
    email: `l-${Date.now()}-${Math.random().toString(16).slice(2)}@x.local`,
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

const seedVocab = async (
  learnerId: unknown,
  rows: Array<{ word: string; retained?: boolean; times?: number; lastSeen?: Date }>
) => {
  await VocabLedger.insertMany(
    rows.map((r) => ({
      learnerId,
      word: r.word,
      retained: r.retained ?? false,
      times_encountered: r.times ?? 1,
      last_seen_at: r.lastSeen ?? new Date(),
      introducedAt: new Date(),
    }))
  );
};

const seedSession = async (
  learnerId: unknown,
  orgId: unknown,
  overrides: Record<string, unknown> = {}
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

// ═════════════════════════════════════════════════════════════════════
// Vocab ledger endpoint
// ═════════════════════════════════════════════════════════════════════

describe("GET /api/esol/learners/:id/vocab-ledger", () => {
  it("V1 — groups retained vs in_progress and reports totals", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    await seedVocab(learner._id, [
      { word: "apple",      retained: true,  times: 6 },
      { word: "banana",     retained: true,  times: 7 },
      { word: "cherry",     retained: false, times: 2 },
      { word: "doughnut",   retained: false, times: 1 },
      { word: "elderberry", retained: false, times: 3 },
    ]);

    const res = await getLearnerVocabLedgerService(
      learner._id.toString(),
      "org_admin",
      org._id.toString()
    );
    const data = res.data as {
      retained: Array<{ word: string }>;
      in_progress: Array<{ word: string }>;
      totals: { retained: number; in_progress: number; total: number };
    };

    expect(data.retained.map((r) => r.word).sort()).toEqual(["apple", "banana"]);
    expect(data.in_progress.map((r) => r.word).sort()).toEqual([
      "cherry",
      "doughnut",
      "elderberry",
    ]);
    expect(data.totals).toEqual({ retained: 2, in_progress: 3, total: 5 });
  });

  it("V2 — in_progress sorted by last_seen_at ASC, then times_encountered ASC", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    await seedVocab(learner._id, [
      { word: "old_rare",   times: 1, lastSeen: new Date("2024-01-01") },
      { word: "recent_rare", times: 1, lastSeen: new Date("2024-12-01") },
      { word: "old_common", times: 5, lastSeen: new Date("2024-01-01") },
    ]);

    const res = await getLearnerVocabLedgerService(
      learner._id.toString(),
      "org_admin",
      org._id.toString()
    );
    const data = res.data as { in_progress: Array<{ word: string }> };
    // Same last_seen → tiebreak on times_encountered ASC (rare first)
    expect(data.in_progress.map((r) => r.word)).toEqual([
      "old_rare",
      "old_common",
      "recent_rare",
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Sessions endpoint
// ═════════════════════════════════════════════════════════════════════

describe("GET /api/esol/learners/:id/sessions", () => {
  it("V3 — sessions paginated recent-first, heavy fields stripped", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);

    // Seed 25 sessions with explicit createdAt
    for (let i = 0; i < 25; i++) {
      const s = await seedSession(learner._id, org._id);
      await AISession.collection.updateOne(
        { _id: s._id },
        { $set: { createdAt: new Date(2024, 0, 1, 0, i) } } // jan 1, hour:i
      );
    }

    // Page 1: 20 (default limit)
    const r1 = await getLearnerSessionsService(
      learner._id.toString(),
      "org_admin",
      org._id.toString()
    );
    const d1 = r1.data as {
      sessions: Array<{ createdAt: string; turns?: unknown[] }>;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };
    expect(d1.sessions).toHaveLength(20);
    expect(d1.pagination).toEqual({ page: 1, limit: 20, total: 25, totalPages: 2 });

    // Recent-first ordering
    const times = d1.sessions.map((s) => new Date(s.createdAt).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i - 1]);
    }

    // Heavy `turns[]` field NOT in payload (.select doesn't include it)
    expect((d1.sessions[0] as { turns?: unknown }).turns).toBeUndefined();

    // Page 2: remaining 5
    const r2 = await getLearnerSessionsService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      { page: 2 }
    );
    const d2 = r2.data as { sessions: unknown[]; pagination: { page: number } };
    expect(d2.sessions).toHaveLength(5);
    expect(d2.pagination.page).toBe(2);
  });

  it("V3.b — limit caps at SESSION_LIST_MAX_LIMIT (100)", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    await seedSession(learner._id, org._id);

    const res = await getLearnerSessionsService(
      learner._id.toString(),
      "org_admin",
      org._id.toString(),
      { limit: 5000 }
    );
    const data = res.data as { pagination: { limit: number } };
    expect(data.pagination.limit).toBe(100);
  });
});

// ═════════════════════════════════════════════════════════════════════
// ACL
// ═════════════════════════════════════════════════════════════════════

describe("ACL on learner-detail endpoints", () => {
  it("V4 — org_admin from a different org → 403", async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const learnerInA = await createLearner(orgA._id);

    await expect(
      getLearnerVocabLedgerService(
        learnerInA._id.toString(),
        "org_admin",
        orgB._id.toString()       // different org
      )
    ).rejects.toMatchObject({ statusCode: 403 });

    await expect(
      getLearnerSessionsService(
        learnerInA._id.toString(),
        "org_admin",
        orgB._id.toString()
      )
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("V5 — admin (Amber) bypasses the org check", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    await seedVocab(learner._id, [{ word: "apple", times: 1 }]);

    // Admin from no org (or different org) can still read
    const res = await getLearnerVocabLedgerService(
      learner._id.toString(),
      "admin",
      null
    );
    expect(res.statusCode).toBe(200);
    expect(
      (res.data as { totals: { total: number } }).totals.total
    ).toBe(1);
  });

  it("V6 — non-existent learner → 404", async () => {
    const fakeId = new Types.ObjectId().toString();
    await expect(
      getLearnerVocabLedgerService(fakeId, "admin", null)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("V7 — invalid learner id → 400", async () => {
    await expect(
      getLearnerVocabLedgerService("not-an-objectid", "admin", null)
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      getLearnerSessionsService("not-an-objectid", "admin", null)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("non-student User cannot be queried via these endpoints (404)", async () => {
    // A tutor / org_admin / admin shouldn't appear in vocab + sessions
    // queries even by id — the service filters role: "student".
    const org = await createOrg();
    const tutor = await User.create({
      firstname: "Tu",
      lastname: "Tor",
      email: `tutor-${Date.now()}@x.local`,
      password: "x",
      phoneNumber: "07000000001",
      role: "tutor",
      orgId: org._id,
      isActive: true,
      status: "active",
      verified: true,
    });

    await expect(
      getLearnerVocabLedgerService(
        tutor._id.toString(),
        "admin",
        null
      )
    ).rejects.toBeInstanceOf(ApiError);
  });
});
