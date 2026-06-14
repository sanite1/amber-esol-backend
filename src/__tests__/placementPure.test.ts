/**
 * Pure-function tests for placement / RARPA helpers.
 *
 * Three modules covered:
 *   - calibration.service.computeOutcome
 *   - placement.service.selectAdaptiveQuestions
 *   - rarpa.service.buildStage3ObjectivesForPlacement
 *
 * All three are pure (no DB, no Gemini, no I/O). Heavy table-driven
 * coverage at this layer means the orchestration layers above can
 * stay thin — these helpers carry the load-bearing logic of Function 6.
 */

import { computeOutcome } from "../services/calibration.service";
import { selectAdaptiveQuestions } from "../services/placement.service";
import { buildStage3ObjectivesForPlacement } from "../services/rarpa.service";
import { PlacementQuestion } from "../interfaces/placementQuestion.interface";
import { AnsweredQuestion } from "../interfaces/placementAttempt.interface";
import { ALL_ILR_CODES, IlrSkillCode } from "../services/esolSkills";

const LEVELS = ["e1", "e2", "e3", "l1", "l2"] as const;
type Level = (typeof LEVELS)[number];

// ─────────────────────────────────────────────────────────────────────
// computeOutcome — every (known, assigned) pair
// ─────────────────────────────────────────────────────────────────────

describe("computeOutcome (calibration)", () => {
  it("correct when known === assigned", () => {
    for (const lvl of LEVELS) {
      expect(computeOutcome(lvl, lvl)).toBe("correct");
    }
  });

  it("one_below when assigned is exactly one rung lower", () => {
    expect(computeOutcome("e2", "e1")).toBe("one_below");
    expect(computeOutcome("l1", "e3")).toBe("one_below");
    expect(computeOutcome("l2", "l1")).toBe("one_below");
  });

  it("one_above when assigned is exactly one rung higher (over-assignment, fail signal)", () => {
    expect(computeOutcome("e1", "e2")).toBe("one_above");
    expect(computeOutcome("e3", "l1")).toBe("one_above");
    expect(computeOutcome("l1", "l2")).toBe("one_above");
  });

  it("over when assigned is two+ rungs higher", () => {
    expect(computeOutcome("e1", "e3")).toBe("over");
    expect(computeOutcome("e1", "l2")).toBe("over");
    expect(computeOutcome("e2", "l1")).toBe("over");
  });

  it("under when assigned is two+ rungs lower (recoverable but flagged)", () => {
    expect(computeOutcome("e3", "e1")).toBe("under");
    expect(computeOutcome("l2", "e2")).toBe("under");
    expect(computeOutcome("l1", "e1")).toBe("under");
  });

  // Full coverage matrix — 25 cells. Catches any off-by-one in the
  // index arithmetic.
  it("covers the full 5×5 outcome matrix consistently", () => {
    const expected: Record<string, string> = {
      // known/assigned → bucket
      "e1/e1": "correct",
      "e1/e2": "one_above",
      "e1/e3": "over",
      "e1/l1": "over",
      "e1/l2": "over",
      "e2/e1": "one_below",
      "e2/e2": "correct",
      "e2/e3": "one_above",
      "e2/l1": "over",
      "e2/l2": "over",
      "e3/e1": "under",
      "e3/e2": "one_below",
      "e3/e3": "correct",
      "e3/l1": "one_above",
      "e3/l2": "over",
      "l1/e1": "under",
      "l1/e2": "under",
      "l1/e3": "one_below",
      "l1/l1": "correct",
      "l1/l2": "one_above",
      "l2/e1": "under",
      "l2/e2": "under",
      "l2/e3": "under",
      "l2/l1": "one_below",
      "l2/l2": "correct",
    };
    for (const known of LEVELS) {
      for (const assigned of LEVELS) {
        const key = `${known}/${assigned}`;
        expect(`${key}=${computeOutcome(known, assigned)}`).toBe(
          `${key}=${expected[key]}`,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// selectAdaptiveQuestions — fixture + scenarios
// ─────────────────────────────────────────────────────────────────────

/**
 * Procedural bank — 4 questions per (level × domain) = 80 questions.
 * `id` is lexicographically sortable so the deterministic sort in
 * `selectAdaptiveQuestions` produces stable output across runs.
 */
const buildBank = (): PlacementQuestion[] => {
  const bank: PlacementQuestion[] = [];
  const domains = ["reading", "writing", "listening", "speaking"] as const;
  for (const level of LEVELS) {
    for (const domain of domains) {
      for (let i = 1; i <= 4; i++) {
        const id = `${level}-${domain}-${String(i).padStart(3, "0")}`;
        bank.push({
          id,
          level,
          skill_domain: domain,
          question_en: `Q ${id}`,
          question_ar: `Q ${id}`,
          question_so: `Q ${id}`,
          question_fa: `Q ${id}`,
          question_zh: `Q ${id}`,
          options: [
            {
              id: "a",
              text_en: "A",
              text_ar: "A",
              text_so: "A",
              text_fa: "A",
              text_zh: "A",
            },
            {
              id: "b",
              text_en: "B",
              text_ar: "B",
              text_so: "B",
              text_fa: "B",
              text_zh: "B",
            },
            {
              id: "c",
              text_en: "C",
              text_ar: "C",
              text_so: "C",
              text_fa: "C",
              text_zh: "C",
            },
            {
              id: "d",
              text_en: "D",
              text_ar: "D",
              text_so: "D",
              text_fa: "D",
              text_zh: "D",
            },
          ],
          correct_answer: "a",
          difficulty_weight: 1.0,
        });
      }
    }
  }
  return bank;
};

const answer = (q: PlacementQuestion, correct: boolean): AnsweredQuestion => ({
  question_id: q.id,
  answer: correct ? "a" : "b",
  was_correct: correct,
  answered_at: new Date(),
});

describe("selectAdaptiveQuestions (placement)", () => {
  const bank = buildBank();

  describe("pre-trigger (answered < 5)", () => {
    it("returns 20 questions, 4 per level, interleaved", () => {
      const plan = selectAdaptiveQuestions([], bank);
      expect(plan).toHaveLength(20);
      // First 5 positions: one of each level
      const firstFiveLevels = plan.slice(0, 5).map((q) => q.level);
      expect(firstFiveLevels).toEqual(["e1", "e2", "e3", "l1", "l2"]);
      // 4 of each level overall
      for (const lvl of LEVELS) {
        expect(plan.filter((q) => q.level === lvl)).toHaveLength(4);
      }
    });

    it("is deterministic — same inputs, same output", () => {
      const a = selectAdaptiveQuestions([], bank);
      const b = selectAdaptiveQuestions([], bank);
      expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
    });

    it("interleaves levels: positions cycle e1,e2,e3,l1,l2,e1,...", () => {
      const plan = selectAdaptiveQuestions([], bank);
      for (let i = 0; i < 20; i++) {
        expect(plan[i].level).toBe(LEVELS[i % 5]);
      }
    });
  });

  describe("all-wrong path (5 wrong → drop e3/l1/l2 from trailing)", () => {
    it("reshapes trailing 15 to e1/e2 only", () => {
      const initial = selectAdaptiveQuestions([], bank);
      const firstFive = initial.slice(0, 5).map((q) => answer(q, false));
      const plan = selectAdaptiveQuestions(firstFive, bank);

      // First 5 are pinned — exactly the answered questions, in order
      expect(plan.slice(0, 5).map((q) => q.id)).toEqual(
        firstFive.map((a) => a.question_id),
      );
      // Trailing 15: no e3/l1/l2 (those levels are dropped on all-wrong)
      const trailing = plan.slice(5);
      expect(trailing).toHaveLength(15);
      for (const q of trailing) {
        expect(["e1", "e2"]).toContain(q.level);
      }
    });
  });

  describe("all-correct path (5 correct → drop 5 e1, top up from l2/l1)", () => {
    it("removes e1 from trailing and fills with l2/l1 (l2 first)", () => {
      const initial = selectAdaptiveQuestions([], bank);
      const firstFive = initial.slice(0, 5).map((q) => answer(q, true));
      const plan = selectAdaptiveQuestions(firstFive, bank);

      expect(plan).toHaveLength(20);
      expect(plan.slice(0, 5).map((q) => q.id)).toEqual(
        firstFive.map((a) => a.question_id),
      );
      const trailing = plan.slice(5);
      // The first 5 already used one e1 (initial position 1), so the
      // initial trailing had 3 more e1s. All-correct drops "up to 5"
      // e1s from trailing — only 3 exist, all gone.
      expect(trailing.filter((q) => q.level === "e1")).toHaveLength(0);
      // Top-up prefers l2 over l1.
      const l2Count = trailing.filter((q) => q.level === "l2").length;
      const l1Count = trailing.filter((q) => q.level === "l1").length;
      expect(l2Count).toBeGreaterThan(0);
      expect(l2Count).toBeGreaterThanOrEqual(l1Count);
    });
  });

  describe("mixed path (1–4 correct → no reshape)", () => {
    it.each([1, 2, 3, 4])(
      "leaves the trailing 15 untouched when %s answers are correct",
      (correctCount) => {
        const initial = selectAdaptiveQuestions([], bank);
        const firstFive = initial
          .slice(0, 5)
          .map((q, i) => answer(q, i < correctCount));
        const plan = selectAdaptiveQuestions(firstFive, bank);

        // First 5 still pinned
        expect(plan.slice(0, 5).map((q) => q.id)).toEqual(
          firstFive.map((a) => a.question_id),
        );
        // Trailing 15 matches the initial selection's trailing 15
        // (sans any of the answered ids — none here since the first
        // 5 are positions 0-4 only)
        expect(plan.slice(5).map((q) => q.id)).toEqual(
          initial.slice(5).map((q) => q.id),
        );
      },
    );
  });

  describe("invariants", () => {
    it("always returns exactly 20 questions", () => {
      const initial = selectAdaptiveQuestions([], bank);
      const firstFive = initial.slice(0, 5).map((q) => answer(q, false));
      expect(selectAdaptiveQuestions([], bank)).toHaveLength(20);
      expect(selectAdaptiveQuestions(firstFive, bank)).toHaveLength(20);
    });

    it("returns no duplicate question ids", () => {
      const initial = selectAdaptiveQuestions([], bank);
      const firstFive = initial.slice(0, 5).map((q) => answer(q, true));
      const plan = selectAdaptiveQuestions(firstFive, bank);
      const ids = plan.map((q) => q.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("throws when the bank has fewer than 4 questions at any level", () => {
      const thinBank = bank.filter(
        (q) => !(q.level === "e3" && q.id.endsWith("004")),
      );
      // e3 now has 15 questions (4 reading + 4 writing + 4 listening + 3 speaking) which is still ≥ 4
      // so we need a bigger cut. Drop all speaking-domain e3 questions
      // so e3 has 12 = still ≥ 4. We need < 4 at one level — strip e3 entirely.
      const truncated = thinBank.filter((q) => q.level !== "e3");
      expect(() => selectAdaptiveQuestions([], truncated)).toThrow(
        /Placement bank has 0 e3 question/i,
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildStage3ObjectivesForPlacement (RARPA)
// ─────────────────────────────────────────────────────────────────────

describe("buildStage3ObjectivesForPlacement (RARPA)", () => {
  it("emits exactly one general objective when no weakness flags are present", () => {
    const out = buildStage3ObjectivesForPlacement("l1", []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      skill_domain: "general",
      target_level: "l1",
      set_from: "placement_assessment",
    });
    expect(out[0].description).toBe(
      "Develop functional English communication skills at Level 1",
    );
    expect(out[0].id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 shape
  });

  it("collapses Rt/Rs/Rw into one reading objective", () => {
    const out = buildStage3ObjectivesForPlacement("e2", ["Rt", "Rs", "Rw"]);
    // Reading + general = 2
    expect(out).toHaveLength(2);
    expect(out[0].skill_domain).toBe("Rt");
    expect(out[0].description).toBe(
      "Develop reading skills for everyday texts at Entry Level 2",
    );
    expect(out[1].skill_domain).toBe("general");
  });

  it("collapses Wt/Ws/Ww into one writing objective", () => {
    const out = buildStage3ObjectivesForPlacement("e3", ["Wt", "Ws", "Ww"]);
    expect(out).toHaveLength(2);
    expect(out[0].skill_domain).toBe("Wt");
    expect(out[0].description).toBe(
      "Develop writing skills for everyday tasks at Entry Level 3",
    );
  });

  it("collapses Sc/Sd into one speaking objective", () => {
    const out = buildStage3ObjectivesForPlacement("e1", ["Sc", "Sd"]);
    expect(out).toHaveLength(2);
    expect(out[0].skill_domain).toBe("Sc");
    expect(out[0].description).toBe(
      "Develop spoken English for everyday situations at Entry Level 1",
    );
  });

  it("maps Lr to its own listening objective", () => {
    const out = buildStage3ObjectivesForPlacement("l2", ["Lr"]);
    expect(out).toHaveLength(2);
    expect(out[0].skill_domain).toBe("Lr");
    expect(out[0].description).toBe(
      "Develop listening comprehension for everyday situations at Level 2",
    );
  });

  it("emits all four domain objectives + general when every code is flagged", () => {
    const out = buildStage3ObjectivesForPlacement("e2", ALL_ILR_CODES);
    expect(out).toHaveLength(5);
    // Stable order: reading, writing, listening, speaking, general
    expect(out.map((o) => o.skill_domain)).toEqual([
      "Rt",
      "Wt",
      "Lr",
      "Sc",
      "general",
    ]);
  });

  it("emits domain order independent of flag insertion order", () => {
    const reverse = buildStage3ObjectivesForPlacement("e2", [
      "Sd",
      "Wt",
      "Rs",
      "Lr",
    ] as IlrSkillCode[]);
    expect(reverse.map((o) => o.skill_domain)).toEqual([
      "Rt", // reading first (Rs maps to Rt anchor)
      "Wt",
      "Lr",
      "Sc", // speaking last (Sd maps to Sc anchor)
      "general",
    ]);
  });

  it("every objective is stamped with placement_assessment provenance + target level", () => {
    const out = buildStage3ObjectivesForPlacement("l1", ["Rt", "Wt"]);
    for (const o of out) {
      expect(o.set_from).toBe("placement_assessment");
      expect(o.target_level).toBe("l1");
      expect(o.set_at).toBeInstanceOf(Date);
      expect(o.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("uuids are unique across the emitted batch", () => {
    const out = buildStage3ObjectivesForPlacement("e2", ALL_ILR_CODES);
    const ids = out.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
