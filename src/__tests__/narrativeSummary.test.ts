/**
 * Tests for the cohort narrative summary — brief Function 12 To-Do 3.
 *
 * Gemini is fully mocked — these tests must NEVER hit Vertex.
 *
 *   M1   computeCohortMetrics: active_count uses cohort_status when set
 *        and live last_session_at when not
 *   M2   total_glh_this_period = AISession.duration_mins/60 (28d window)
 *        + sum of glh_teacher_contact
 *   M3   level_progression_count: only LevelChanges within the window
 *   M4   avg_sessions_per_learner = period sessions / total_learners
 *   M5   top_3_weakest_skill_domains collapses ILR codes → domains
 *        and ranks by learner_count
 *   M6   inactive_learner_count uses cohort_status / live fallback
 *   M7   teacher_oversight_hours = sum of glh_teacher_contact
 *
 *   G1   First call → computes metrics, calls Gemini, persists cache,
 *        returns cache_hit: false
 *   G2   Second call within 24h → cache hit, Gemini NOT called again
 *   G3   Cache expired beyond 24h → re-generated, fresh row written
 *   G4   Gemini failure with a stale cache → returns the stale narrative
 *        (graceful degrade) without re-throwing
 *   G5   Gemini failure with no cache → 502
 *   G6   Prompt forbids names + asks for prose — system prompt assertions
 *
 *   P1   buildNarrativeUserPrompt embeds the metrics JSON cleanly
 *   P2   Invalid org_id → 400
 */

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// ── Mock the Gemini client BEFORE the SUT is imported ───────────────
const generateContentMock = jest.fn();
const getGenerativeModelMock = jest.fn(() => ({
  generateContent: generateContentMock,
}));
jest.mock("../lib/gemini", () => ({
  __esModule: true,
  MODEL_NAME: "gemini-2.5-flash",
  initGeminiClient: jest.fn(),
  geminiClient: {
    preview: { getGenerativeModel: getGenerativeModelMock },
  },
}));

import { Types } from "mongoose";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import LevelChange from "../models/LevelChange";
import NarrativeCache from "../models/NarrativeCache";
import {
  computeCohortMetrics,
  getCohortNarrativeService,
  __internals__,
} from "../services/narrativeSummary.service";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const createOrg = async (name = "Narrative Org") =>
  Organisation.create({
    name,
    slug: `narr-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "admin@narr.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

interface LearnerOpts {
  orgId: unknown;
  cohortStatus?: string | null;
  lastSessionAt?: Date | null;
  weakFlags?: string[];
  glhTeacherContact?: number;
  isActive?: boolean;
  role?: string;
}
const createLearner = async (opts: LearnerOpts) =>
  User.create({
    firstname: "N",
    lastname: "Learner",
    email: `n-${Date.now()}-${Math.random().toString(16).slice(2)}@narr.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: opts.role ?? "student",
    orgId: opts.orgId,
    isActive: opts.isActive ?? true,
    status: "active",
    verified: true,
    esolLevel: "e2",
    cohort_status: opts.cohortStatus ?? null,
    last_session_at: opts.lastSessionAt ?? null,
    skillWeaknessFlags: opts.weakFlags ?? [],
    glh_teacher_contact: opts.glhTeacherContact ?? 0,
  });

const seedSession = async (
  learnerId: unknown,
  orgId: unknown,
  args: { durationMins?: number; createdAt?: Date } = {}
) => {
  const s = await AISession.create({
    learnerId, orgId,
    sessionMode: "BRIDGE", esolLevel: "e2",
    turns: [], safeguardingFlagged: false, vocabIntroduced: [],
    session_source: "ai_tutor",
    duration_mins: args.durationMins ?? 30,
    turn_scores: [], teaching_mode_sequence: [],
    start_time: new Date(),
  });
  if (args.createdAt) {
    await AISession.collection.updateOne(
      { _id: s._id as unknown as never },
      { $set: { createdAt: args.createdAt } }
    );
  }
  return s;
};

const fakeGeminiResponse = (narrative: string) => ({
  response: {
    candidates: [{ content: { parts: [{ text: narrative }] } }],
    usageMetadata: {
      promptTokenCount: 600,
      candidatesTokenCount: 80,
      cachedContentTokenCount: 0,
    },
  },
});

beforeEach(() => {
  generateContentMock.mockReset();
  getGenerativeModelMock.mockClear();
  generateContentMock.mockResolvedValue(
    fakeGeminiResponse(
      "87% of your cohort completed at least one scenario this month. 13 learners moved from Entry Level 1 to Entry Level 2."
    )
  );
});

// ═════════════════════════════════════════════════════════════════════
// M1–M7 — computeCohortMetrics
// ═════════════════════════════════════════════════════════════════════

describe("computeCohortMetrics", () => {
  it("M1 — active_count uses cohort_status, falls back to last_session_at", async () => {
    const org = await createOrg();
    // cohort_status precomputed: active
    await createLearner({ orgId: org._id, cohortStatus: "active" });
    await createLearner({ orgId: org._id, cohortStatus: "new" });
    // cohort_status null, last_session_at within window
    await createLearner({
      orgId: org._id,
      lastSessionAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    // cohort_status null, no session
    await createLearner({ orgId: org._id });

    const m = await computeCohortMetrics(org._id.toString());
    expect(m.active_count).toBe(3); // two via cohort_status + one via live
    expect(m.total_learners).toBe(4);
  });

  it("M2 — total_glh_this_period = (28d session mins / 60) + teacher_oversight_hours", async () => {
    const org = await createOrg();
    const a = await createLearner({ orgId: org._id, glhTeacherContact: 4 });
    const b = await createLearner({ orgId: org._id, glhTeacherContact: 2 });

    // In-window sessions: 120 + 60 = 180 mins = 3.0 hrs
    await seedSession(a._id, org._id, { durationMins: 120 });
    await seedSession(b._id, org._id, { durationMins: 60 });
    // Out-of-window session — should NOT count
    await seedSession(a._id, org._id, {
      durationMins: 999,
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });

    const m = await computeCohortMetrics(org._id.toString());
    expect(m.teacher_oversight_hours).toBe(6.0);
    expect(m.total_glh_this_period).toBeCloseTo(9.0, 5); // 3.0 + 6.0
  });

  it("M3 — level_progression_count only counts LevelChanges within the window", async () => {
    const org = await createOrg();
    const learner = await createLearner({ orgId: org._id });
    const admin = new Types.ObjectId();

    // In-window
    await LevelChange.create({
      learnerId: learner._id, orgId: org._id,
      fromLevel: "e1", toLevel: "e2", changedBy: admin,
      reason: "in window",
      effectiveDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    await LevelChange.create({
      learnerId: learner._id, orgId: org._id,
      fromLevel: "e2", toLevel: "e3", changedBy: admin,
      reason: "also in window",
      effectiveDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    });
    // Out-of-window
    await LevelChange.create({
      learnerId: learner._id, orgId: org._id,
      fromLevel: "e3", toLevel: "l1", changedBy: admin,
      reason: "old",
      effectiveDate: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    });

    const m = await computeCohortMetrics(org._id.toString());
    expect(m.level_progression_count).toBe(2);
  });

  it("M4 — avg_sessions_per_learner is period sessions / total_learners", async () => {
    const org = await createOrg();
    const a = await createLearner({ orgId: org._id });
    const b = await createLearner({ orgId: org._id });
    const c = await createLearner({ orgId: org._id });

    // 6 sessions across 3 learners → avg = 2.0
    for (let i = 0; i < 3; i++) await seedSession(a._id, org._id);
    for (let i = 0; i < 2; i++) await seedSession(b._id, org._id);
    await seedSession(c._id, org._id);

    const m = await computeCohortMetrics(org._id.toString());
    expect(m.total_learners).toBe(3);
    expect(m.avg_sessions_per_learner).toBeCloseTo(2.0, 5);
  });

  it("M5 — top_3_weakest_skill_domains collapses ILR codes → domains, ranked", async () => {
    const org = await createOrg();
    // Writing: 3 learners (Wt + Ws on one), Speaking: 2, Listening: 1
    await createLearner({ orgId: org._id, weakFlags: ["Wt"] });
    await createLearner({ orgId: org._id, weakFlags: ["Wt", "Ws"] });
    await createLearner({ orgId: org._id, weakFlags: ["Wt"] });
    await createLearner({ orgId: org._id, weakFlags: ["Sc"] });
    await createLearner({ orgId: org._id, weakFlags: ["Sd"] });
    await createLearner({ orgId: org._id, weakFlags: ["Lr"] });

    const m = await computeCohortMetrics(org._id.toString());
    const top = m.top_3_weakest_skill_domains_across_cohort;
    expect(top).toHaveLength(3);
    expect(top[0].domain).toBe("writing"); // 4 occurrences (3 Wt + 1 Ws)
    expect(top[0].learner_count).toBe(4);
    expect(top[1].domain).toBe("speaking"); // 2
    expect(top[2].domain).toBe("listening"); // 1
  });

  it("M6 — inactive_learner_count uses cohort_status / live fallback", async () => {
    const org = await createOrg();
    // Pre-computed by cron
    await createLearner({ orgId: org._id, cohortStatus: "inactive_mild" });
    await createLearner({ orgId: org._id, cohortStatus: "dormant" });
    // Live fallback — last_session_at > 14 days ago
    await createLearner({
      orgId: org._id,
      lastSessionAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    });
    // Active — should NOT count
    await createLearner({ orgId: org._id, cohortStatus: "active" });

    const m = await computeCohortMetrics(org._id.toString());
    expect(m.inactive_learner_count).toBe(3);
  });

  it("M7 — teacher_oversight_hours sums glh_teacher_contact across cohort", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, glhTeacherContact: 1.5 });
    await createLearner({ orgId: org._id, glhTeacherContact: 2.0 });
    await createLearner({ orgId: org._id, glhTeacherContact: 0 });

    const m = await computeCohortMetrics(org._id.toString());
    expect(m.teacher_oversight_hours).toBe(3.5);
  });
});

// ═════════════════════════════════════════════════════════════════════
// G1–G6 — Cache + Gemini wiring
// ═════════════════════════════════════════════════════════════════════

describe("getCohortNarrativeService", () => {
  it("G1 — first call computes metrics, calls Gemini, persists cache, cache_hit: false", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id, cohortStatus: "active" });

    const res = await getCohortNarrativeService(org._id.toString());
    const data = res.data as {
      narrative: string;
      generated_at: string;
      expires_at: string;
      cache_hit: boolean;
      metrics: { active_count: number };
    };

    expect(data.cache_hit).toBe(false);
    expect(data.narrative).toMatch(/scenario/);
    expect(data.metrics.active_count).toBe(1);
    expect(generateContentMock).toHaveBeenCalledTimes(1);

    // Cache row persisted
    const row = await NarrativeCache.findOne({ org_id: org._id }).lean();
    expect(row).toBeTruthy();
    expect(row?.narrative).toBe(data.narrative);
    expect(row?.expires_at.getTime()).toBeGreaterThan(row?.generated_at.getTime() ?? 0);
  });

  it("G2 — second call within 24h returns cached, Gemini NOT called again", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id });

    const first = await getCohortNarrativeService(org._id.toString());
    const firstNarrative = (first.data as { narrative: string }).narrative;
    expect(generateContentMock).toHaveBeenCalledTimes(1);

    const second = await getCohortNarrativeService(org._id.toString());
    const data = second.data as { narrative: string; cache_hit: boolean };
    expect(data.cache_hit).toBe(true);
    expect(data.narrative).toBe(firstNarrative);
    // Gemini should NOT have been called a second time
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("G3 — cache expired beyond 24h → re-generated", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id });

    // Seed a cache row "yesterday" — 25h ago.
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await NarrativeCache.create({
      org_id: org._id,
      narrative: "old narrative from yesterday",
      metrics: {},
      generated_at: yesterday,
      expires_at: new Date(yesterday.getTime() + 24 * 60 * 60 * 1000),
    });

    generateContentMock.mockResolvedValue(
      fakeGeminiResponse("fresh narrative from today")
    );

    const res = await getCohortNarrativeService(org._id.toString());
    const data = res.data as { narrative: string; cache_hit: boolean };
    expect(data.cache_hit).toBe(false);
    expect(data.narrative).toBe("fresh narrative from today");
    expect(generateContentMock).toHaveBeenCalledTimes(1);

    // Two cache rows now (the TTL index would eventually delete the old one)
    expect(await NarrativeCache.countDocuments({ org_id: org._id })).toBe(2);
  });

  it("G4 — Gemini failure with stale cache → serves stale, no throw", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id });

    // Seed a stale cache row (older than 24h)
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await NarrativeCache.create({
      org_id: org._id,
      narrative: "yesterday's narrative",
      metrics: {},
      generated_at: longAgo,
      expires_at: new Date(longAgo.getTime() + 24 * 60 * 60 * 1000),
    });

    generateContentMock.mockRejectedValueOnce(new Error("Vertex 503"));

    const res = await getCohortNarrativeService(org._id.toString());
    const data = res.data as { narrative: string; cache_hit: boolean };
    expect(data.cache_hit).toBe(true);
    expect(data.narrative).toBe("yesterday's narrative");
    expect(res.message).toMatch(/stale fallback/i);
  });

  it("G5 — Gemini failure with no cache → 502", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id });

    generateContentMock.mockRejectedValueOnce(new Error("Vertex down"));

    await expect(
      getCohortNarrativeService(org._id.toString())
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("G6 — system prompt forbids names, requires prose paragraph", async () => {
    const org = await createOrg();
    await createLearner({ orgId: org._id });

    await getCohortNarrativeService(org._id.toString());

    // The system instruction is passed to getGenerativeModel via the
    // options arg. Inspect what we actually sent.
    expect(getGenerativeModelMock).toHaveBeenCalledTimes(1);
    const opts = (getGenerativeModelMock.mock.calls[0] as unknown[])[0] as {
      systemInstruction: { parts: Array<{ text: string }> };
      generationConfig: { responseMimeType: string; temperature: number };
    };
    const sys = opts.systemInstruction.parts[0].text;
    expect(sys).toMatch(/MUST NOT[\s\S]*Name any individual learner/i);
    expect(sys).toMatch(/4.{0,3}6 sentences/i);
    expect(sys).toMatch(/single paragraph/i);
    // Plain text mode, not JSON
    expect(opts.generationConfig.responseMimeType).toBe("text/plain");
    // Temperature is in the middle range we set
    expect(opts.generationConfig.temperature).toBeCloseTo(0.4, 2);
  });
});

// ═════════════════════════════════════════════════════════════════════
// P1–P2 — Prompt + validation
// ═════════════════════════════════════════════════════════════════════

describe("prompt + validation", () => {
  it("P1 — buildNarrativeUserPrompt embeds metrics JSON", () => {
    const prompt = __internals__.buildNarrativeUserPrompt({
      active_count: 12,
      total_glh_this_period: 342,
      level_progression_count: 13,
      avg_sessions_per_learner: 3.2,
      top_3_weakest_skill_domains_across_cohort: [
        { domain: "writing", learner_count: 8 },
      ],
      inactive_learner_count: 3,
      teacher_oversight_hours: 24,
      reporting_window: { start: "2026-05-01", end: "2026-05-29", days: 28 },
      total_learners: 15,
    });

    expect(prompt).toMatch(/Cohort metrics for the period/);
    expect(prompt).toMatch(/"active_count": 12/);
    expect(prompt).toMatch(/"level_progression_count": 13/);
    expect(prompt).toMatch(/"total_glh_this_period": 342/);
    expect(prompt).toMatch(/"label": "written English"/);
    expect(prompt).toMatch(/Paragraph only\./);
  });

  it("P2 — invalid orgId → 400", async () => {
    await expect(
      getCohortNarrativeService("not-an-objectid")
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
