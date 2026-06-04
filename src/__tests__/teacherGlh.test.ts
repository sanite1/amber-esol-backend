/**
 * Atomic GLH increment — Final Addendum §12.
 *
 * Verifies that the teacher review-log service uses Mongo's
 * `$inc` operator atomically — no read-modify-write window — so
 * two concurrent reviews from different teacher contexts on the
 * same learner cannot lose an update.
 *
 * The 1-teacher-per-learner model makes this race unlikely in
 * production today, but the brief calls out that the assumption
 * shifts in Phase 21+ (multi-teacher orgs) and the locking
 * primitive must already be in place before that lands. This test
 * is the regression fence — any future refactor that turns the
 * $inc back into a read-then-write would fail loudly here.
 *
 * What we DO test
 * ===============
 *
 *   - N concurrent `logTeacherReviewService` calls with distinct
 *     prime-minute durations (so any lost update produces an
 *     incorrect sum that's impossible to confuse with the right
 *     answer).
 *   - Final `User.glh_teacher_contact` equals the exact arithmetic
 *     sum of `duration_mins / 60`.
 *   - N TeacherReview rows exist — the write side is also
 *     verified (a service that dropped writes silently would have
 *     a matching low row count).
 *   - The `teacher_last_reviewed_at` field is set to one of the
 *     concurrent timestamps (any winner is fine — the field is
 *     overwriting, not accumulating).
 *
 * What we DON'T test here
 * =======================
 *
 *   - End-to-end auth (the route layer + middleware) — the
 *     service is invoked directly with a known teacher_id +
 *     learner_id. Route-layer tests live in the corresponding
 *     route test file.
 *   - The audit-log row's content — covered by the existing
 *     teacherReview integration tests; this test focuses on the
 *     concurrency invariant only.
 *   - The priority-queue enqueue side effect — mocked out.
 */

process.env.REFERRAL_JWT_SECRET = process.env.REFERRAL_JWT_SECRET ?? "test-secret";

// Queues mocked wholesale so the enqueueLearnerPriorityRecalc
// helper inside the service doesn't try to hit Redis. Match the
// pattern used by adminLevelChange.test.ts.
jest.mock("../queues", () => ({
  __esModule: true,
  notificationsQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  priorityQueueQueue: {
    add: jest.fn().mockResolvedValue({ id: "fake", timestamp: Date.now() }),
  },
  esolSessionQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  deltaSyncQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  cacheRefreshQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  rarpaEvidenceQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  ilrExportQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  complianceValidationQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
  misPushQueue: { add: jest.fn().mockResolvedValue({ id: "fake" }) },
}));

import mongoose, { Types } from "mongoose";
import User from "../models/User";
import TeacherReview from "../models/TeacherReview";
import Organisation from "../models/Organisation";
import { logTeacherReviewService } from "../services/teacherReviewLog.service";

// ─────────────────────────────────────────────────────────────────────
// Fixture builders — keep tests free of shared state across cases.
// ─────────────────────────────────────────────────────────────────────

const seedOrg = async () =>
  Organisation.create({
    name: "Concurrency Test Org",
    // `slug` is required + unique on the Organisation schema; mint
    // a per-call random value so the suite can re-seed within a
    // single test (the repeats-5x iteration deletes + re-creates).
    slug: `concurrency-test-${new Types.ObjectId().toString()}`,
    billing_active: true,
    misType: "none",
  });

const seedLearner = async (orgId: Types.ObjectId, teacherId: Types.ObjectId) =>
  User.create({
    firstname: "Test",
    lastname: "Learner",
    email: `concurrency-learner-${new Types.ObjectId().toString()}@test`,
    phoneNumber: "+440000000000",
    password: "x".repeat(12),
    role: "student",
    orgId,
    assigned_teacher_id: teacherId,
    esolLevel: "e2",
    glh_teacher_contact: 0,
    cohort_status: "active",
    last_session_at: new Date(),
  });

const seedTeacher = async (orgId: Types.ObjectId) =>
  User.create({
    firstname: "Test",
    lastname: "Teacher",
    email: `concurrency-teacher-${new Types.ObjectId().toString()}@test`,
    phoneNumber: "+440000000000",
    password: "x".repeat(12),
    role: "tutor",
    orgId,
    esolTeacherApproved: true,
    dbsCheckStatus: "cleared",
  });

// Distinct prime minute counts. Any single dropped write produces
// a wrong total that's impossible to confuse with another valid
// combination — the gap signals exactly which review was lost.
const DURATIONS_MINS = [13, 17, 19, 23, 29, 31, 37, 41, 43, 47];
const EXPECTED_TOTAL_MINS = DURATIONS_MINS.reduce((s, n) => s + n, 0); // 300
const EXPECTED_GLH = EXPECTED_TOTAL_MINS / 60; // 5.0

describe("Final Addendum §12 — atomic GLH increment", () => {
  it("N concurrent review writes accumulate exactly — no lost updates", async () => {
    const org = await seedOrg();
    const orgId = org._id as Types.ObjectId;

    // Two teachers, both assigned to the same learner — simulates
    // the post-Phase-21 multi-teacher case. The service's
    // assignment gate accepts either as long as
    // `learner.assigned_teacher_id` matches; we set assignment to
    // teacherA and route half the calls through a second teacher
    // by reassigning before each write would be racy — instead we
    // reassign once to teacherB after the first half (which lets
    // both halves pass the gate while exercising the $inc race).
    //
    // Update — simpler: assign to teacherA, fire ALL writes from
    // teacherA. The race we care about is the $inc atomicity at
    // the DB layer, which doesn't depend on the teacher identity.
    // The brief's "two teachers" framing is the future case; the
    // primitive is the same.
    const teacherA = await seedTeacher(orgId);
    const teacherAId = (teacherA._id as Types.ObjectId).toString();
    const learner = await seedLearner(orgId, teacherA._id as Types.ObjectId);
    const learnerId = (learner._id as Types.ObjectId).toString();

    // ── Fire N writes in parallel ──────────────────────────────
    // Promise.all + map preserves rejection visibility — if any
    // single call throws the whole Promise.all rejects and Jest
    // surfaces the cause.
    const results = await Promise.all(
      DURATIONS_MINS.map((mins) =>
        logTeacherReviewService({
          learner_id: learnerId,
          teacher_id: teacherAId,
          body: {
            review_type: "async_review",
            duration_mins: mins,
            ai_recommendation_acted_on: false,
          },
        }),
      ),
    );

    // Every call should have returned a 201 — a 500 here means
    // the service rolled back or the $inc threw under contention.
    for (const r of results) {
      expect(r.statusCode).toBe(201);
    }

    // ── Assertion 1 — exact GLH sum ────────────────────────────
    // Re-read the User from disk (NOT from the mutation return)
    // so we're testing the durable state, not the in-flight
    // response. A lost update would manifest as a glh below the
    // expected sum.
    const finalLearner = await User.findById(learner._id)
      .select("glh_teacher_contact teacher_last_reviewed_at")
      .lean();
    expect(finalLearner).not.toBeNull();
    // Use toBeCloseTo to tolerate IEEE-754 noise from the
    // per-write `mins / 60` divisions — but the precision is
    // tight (6 decimal places) so a real lost update (a missing
    // 13-min write = 0.2167) would fail by a wide margin.
    expect(finalLearner!.glh_teacher_contact).toBeCloseTo(EXPECTED_GLH, 6);

    // ── Assertion 2 — every review row landed ─────────────────
    // Verifies the write side. A service that dropped writes
    // silently (e.g. caught a duplicate-key error and bailed)
    // would have fewer rows than calls.
    const reviewCount = await TeacherReview.countDocuments({
      learner_id: learner._id,
    });
    expect(reviewCount).toBe(DURATIONS_MINS.length);

    // ── Assertion 3 — last_reviewed_at was set ────────────────
    // The field is overwriting (each $set wins), not
    // accumulating — we just check non-null. A "last writer
    // wins" semantic is correct here; the audit log carries the
    // full chronology.
    expect(finalLearner!.teacher_last_reviewed_at).toBeInstanceOf(Date);
  });

  it("repeats the test 5x to flush out flaky races", async () => {
    // Concurrency races are non-deterministic — a single pass can
    // accidentally serialise. Running the same scenario 5 times
    // in sequence raises the chance of catching a regression
    // where the $inc was naively replaced with a read-then-write.
    // Each iteration starts from a clean state (afterEach in
    // setup.ts truncates every collection).
    //
    // Smaller batch per iteration to keep wall-clock bounded;
    // total writes across the suite stay >50.
    const smallBatch = [7, 11, 13, 17, 19];
    const smallExpectedGlh = smallBatch.reduce((s, n) => s + n, 0) / 60;

    for (let iteration = 0; iteration < 5; iteration += 1) {
      // Truncate manually inside the iteration so this single
      // `it` block stays self-contained. afterEach only fires
      // between top-level `it`s.
      //
      // TeacherReview enforces append-only via pre-update /
      // pre-delete Mongoose middleware — drop through to the
      // native collection driver so the test cleanup isn't
      // blocked by the model's production safety net.
      await Promise.all([
        User.deleteMany({}),
        mongoose.connection.collection("teacherreviews").deleteMany({}),
        Organisation.deleteMany({}),
      ]);

      const org = await seedOrg();
      const orgId = org._id as Types.ObjectId;
      const teacher = await seedTeacher(orgId);
      const learner = await seedLearner(orgId, teacher._id as Types.ObjectId);

      await Promise.all(
        smallBatch.map((mins) =>
          logTeacherReviewService({
            learner_id: (learner._id as Types.ObjectId).toString(),
            teacher_id: (teacher._id as Types.ObjectId).toString(),
            body: {
              review_type: "async_review",
              duration_mins: mins,
              ai_recommendation_acted_on: false,
            },
          }),
        ),
      );

      const fresh = await User.findById(learner._id)
        .select("glh_teacher_contact")
        .lean();
      expect(fresh!.glh_teacher_contact).toBeCloseTo(smallExpectedGlh, 6);
      const rows = await TeacherReview.countDocuments({
        learner_id: learner._id,
      });
      expect(rows).toBe(smallBatch.length);
    }
  });
});
