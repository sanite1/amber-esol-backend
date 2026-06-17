/**
 * ILR GLH formula — Final Addendum §12.
 *
 * Unit-tests the pure formula helper `computeIlrLearnerGlh`. The
 * helper has no DB / network / time dependency, so this suite is
 * fast (sub-100ms total) and doesn't need the in-memory Mongo
 * boot the other test suites carry.
 *
 * What's covered
 * ==============
 *
 *   F1   Brief's worked example: 3 ai_tutor + 1 pre_platform + 0 teacher
 *        consolidation + 5h teacher_contact → exact total.
 *   F2   teacher_consolidation sessions DO NOT roll into total_glh
 *        (the double-count guard — see service-file rationale).
 *   F3   Unknown / missing session_source values are bucketed as
 *        `unknown_source_count`, never silently into a known bucket.
 *   F4   Negative / NaN / null durations are skipped (defensive
 *        against bad pre-platform imports).
 *   F5   Null / undefined / negative `glhTeacherContact` coerce to 0.
 *   F6   Per-source breakdown is independent — adding a session to
 *        one bucket doesn't bleed into another.
 *   F7   Empty input returns zeros across the board.
 *   F8   1dp rounding happens ONCE at the end, not per session
 *        (regression against the "drift across 100 sessions" trap).
 */

import {
  computeIlrLearnerGlh,
  __internals__,
} from "../services/ilrGlh.service";
import type { IlrGlhSessionInput } from "../services/ilrGlh.service";

const session = (source: string, mins: number): IlrGlhSessionInput => ({
  session_source: source,
  duration_mins: mins,
});

describe("Final Addendum §12 — ILR GLH formula", () => {
  // ── F1 ────────────────────────────────────────────────────────
  it("worked example: ai + pre_platform + teacher_contact roll into total", () => {
    // 3 × 60 min ai_tutor = 3.0h
    // 1 × 120 min pre_platform = 2.0h
    // 5.0h teacher_contact (from the User row)
    // expected total = 10.0h
    const result = computeIlrLearnerGlh(
      [
        session("ai_tutor", 60),
        session("ai_tutor", 60),
        session("ai_tutor", 60),
        session("pre_platform", 120),
      ],
      5.0,
    );
    expect(result).toEqual({
      ai_glh: 3.0,
      pre_platform_glh: 2.0,
      teacher_contact_glh: 5.0,
      teacher_consolidation_glh: 0,
      unknown_source_count: 0,
      total_glh: 10.0,
      // F29 — claim-driving total EXCLUDES AI time: 2.0 + 5.0 = 7.0.
      claimable_glh: 7.0,
    });
  });

  // ── F2 ────────────────────────────────────────────────────────
  it("teacher_consolidation sessions DO NOT inflate total_glh", () => {
    // Same shape as F1 but with two extra teacher_consolidation
    // sessions worth 90 min each = 3.0h that MUST NOT show up
    // in total_glh (the User.glh_teacher_contact field already
    // accumulates the matching TeacherReview's contribution).
    const result = computeIlrLearnerGlh(
      [
        session("ai_tutor", 60),
        session("teacher_consolidation", 90),
        session("teacher_consolidation", 90),
        session("pre_platform", 120),
      ],
      4.0,
    );
    expect(result.ai_glh).toBeCloseTo(1.0, 6);
    expect(result.pre_platform_glh).toBeCloseTo(2.0, 6);
    expect(result.teacher_contact_glh).toBeCloseTo(4.0, 6);
    // Surfaced separately so the caller can sanity-check.
    expect(result.teacher_consolidation_glh).toBeCloseTo(3.0, 6);
    // total_glh = ai + pre_platform + teacher_contact ONLY.
    expect(result.total_glh).toBeCloseTo(7.0, 6);
    // claimable_glh (F29) drops the 1.0h AI time: 2.0 + 4.0 = 6.0.
    expect(result.claimable_glh).toBeCloseTo(6.0, 6);
  });

  // ── F3 ────────────────────────────────────────────────────────
  it("unknown / missing session_source rows are counted, not silently bucketed", () => {
    const result = computeIlrLearnerGlh(
      [
        session("ai_tutor", 30),
        session("legacy_typo_value", 30),
        session("", 30),
        // Cast to bypass the TS literal-union for null testing.
        { session_source: null as unknown as string, duration_mins: 30 },
        {
          session_source: undefined as unknown as string,
          duration_mins: 30,
        },
      ],
      0,
    );
    expect(result.ai_glh).toBeCloseTo(0.5, 6);
    expect(result.unknown_source_count).toBe(4);
    // Unknown rows never inflate any known bucket.
    expect(result.pre_platform_glh).toBe(0);
    expect(result.teacher_consolidation_glh).toBe(0);
    // The 4 unknown rows DO NOT contribute to total_glh either —
    // they live in the unknown_source_count field for ops
    // visibility, but the brief's three-term formula excludes them.
    expect(result.total_glh).toBeCloseTo(0.5, 6);
  });

  // ── F4 ────────────────────────────────────────────────────────
  it("negative / NaN / null / undefined / non-numeric durations are skipped", () => {
    const result = computeIlrLearnerGlh(
      [
        session("ai_tutor", 60), // valid — 1.0h
        session("ai_tutor", -15), // negative skipped
        session("ai_tutor", NaN), // NaN skipped
        {
          session_source: "ai_tutor",
          duration_mins: null,
        }, // null skipped
        {
          session_source: "ai_tutor",
          duration_mins: undefined,
        }, // undefined skipped
        {
          session_source: "ai_tutor",
          duration_mins: "30" as unknown as number,
        }, // string "30" — non-numeric, skipped (we don't coerce)
      ],
      0,
    );
    expect(result.ai_glh).toBeCloseTo(1.0, 6);
  });

  // ── F5 ────────────────────────────────────────────────────────
  it("glhTeacherContact null / undefined / negative coerces to 0", () => {
    const cases: Array<number | null | undefined> = [null, undefined, -5, NaN];
    for (const tc of cases) {
      const result = computeIlrLearnerGlh([session("ai_tutor", 60)], tc);
      expect(result.teacher_contact_glh).toBe(0);
      expect(result.total_glh).toBeCloseTo(1.0, 6);
    }
  });

  // ── F6 ────────────────────────────────────────────────────────
  it("per-source breakdown is independent — no cross-bucket bleed", () => {
    // 10 ai_tutor sessions of varying lengths
    const ai = Array.from({ length: 10 }).map(() => session("ai_tutor", 24)); // 4h
    // 5 pre_platform of varying lengths
    const pre = Array.from({ length: 5 }).map(() =>
      session("pre_platform", 12),
    ); // 1h
    const result = computeIlrLearnerGlh([...ai, ...pre], 2.0);

    expect(result.ai_glh).toBeCloseTo(4.0, 6);
    expect(result.pre_platform_glh).toBeCloseTo(1.0, 6);
    expect(result.teacher_contact_glh).toBeCloseTo(2.0, 6);
    expect(result.teacher_consolidation_glh).toBe(0);
    expect(result.total_glh).toBeCloseTo(7.0, 6);
  });

  // ── F7 ────────────────────────────────────────────────────────
  it("empty input returns zeros for every bucket", () => {
    const result = computeIlrLearnerGlh([], 0);
    expect(result).toEqual({
      ai_glh: 0,
      pre_platform_glh: 0,
      teacher_contact_glh: 0,
      teacher_consolidation_glh: 0,
      unknown_source_count: 0,
      total_glh: 0,
      claimable_glh: 0,
    });
  });

  // ── F8 ────────────────────────────────────────────────────────
  it("rounds once at the end — no per-session drift across 100 sessions", () => {
    // 100 × 17 mins ai_tutor sessions
    //   each = 0.28333… hours
    //   per-session rounded to 1dp would be 0.3
    //   sum of rounded = 30.0  (WRONG)
    //   sum-then-round = 28.3  (RIGHT — actual 28.333… rounded)
    const sessions = Array.from({ length: 100 }).map(() =>
      session("ai_tutor", 17),
    );
    const result = computeIlrLearnerGlh(sessions, 0);
    expect(result.ai_glh).toBe(28.3);
    expect(result.total_glh).toBe(28.3);
  });

  // ── Internal helpers smoke tests ─────────────────────────────
  describe("__internals__", () => {
    it("minsToHours guards null / negative / non-finite inputs", () => {
      const { minsToHours } = __internals__;
      expect(minsToHours(60)).toBe(1);
      expect(minsToHours(30)).toBeCloseTo(0.5, 6);
      expect(minsToHours(0)).toBe(0);
      expect(minsToHours(-10)).toBe(0);
      expect(minsToHours(NaN)).toBe(0);
      expect(minsToHours(null)).toBe(0);
      expect(minsToHours(undefined)).toBe(0);
    });

    it("round1dp clips to one decimal place", () => {
      const { round1dp } = __internals__;
      expect(round1dp(0.05)).toBeCloseTo(0.1, 6); // half-up
      expect(round1dp(0.04)).toBe(0);
      expect(round1dp(28.3333)).toBe(28.3);
      expect(round1dp(0)).toBe(0);
    });
  });
});
