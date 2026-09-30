/**
 * Silk bug brief section 3 — the offline half of the eval harness.
 *
 * Guards the case file and the pure checkers so a bad edit fails here
 * rather than during a live run. The live run is `npm run eval:tutor`.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  bannedWordsIn,
  checkStability,
  checkTurnOutput,
  englishShare,
  validateCases,
  type TutorEvalCase,
} from "../eval/tutorEvalChecks";
import {
  deterministicTurnScore,
  resolveTurnScore,
} from "../services/turnScore.service";
import { validateRecast } from "../services/recast.service";
import { decideMode } from "../services/modeController.service";
import { tutorTemperature } from "../services/aiSession.service";

const cases = JSON.parse(
  readFileSync(join(__dirname, "..", "eval", "tutorEvalCases.json"), "utf8"),
) as TutorEvalCase[];

describe("eval case file", () => {
  it("is valid and covers every level", () => {
    expect(validateCases(cases)).toEqual([]);
    const levels = new Set(cases.map((c) => c.level));
    expect([...levels].sort()).toEqual(["e1", "e2", "e3", "l1", "l2"]);
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it("marks every grammar sensitive case for specialist review", () => {
    const grammar = cases.filter((c) => c.expect.recastApplied === true);
    expect(grammar.length).toBeGreaterThan(5);
    expect(grammar.every((c) => c.specialist_review)).toBe(true);
  });

  it("rejects a malformed case", () => {
    expect(validateCases([{ id: "x" }])).not.toEqual([]);
  });
});

describe("englishShare", () => {
  it("counts a Turkish reply as first language", () => {
    expect(
      englishShare("Harika bir başlangıç! Adınız neydi?"),
    ).toBeLessThanOrEqual(0.25);
  });
  it("counts Arabic and Chinese script as first language", () => {
    expect(englishShare("أريد موعد مع الطبيب")).toBe(0);
    expect(englishShare("你好，today we practise")).toBeCloseTo(0.75, 1);
  });
  it("reads a mixed reply roughly by words", () => {
    const share = englishShare("Harika! Let's look at your payslip together.");
    expect(share).toBeGreaterThan(0.8);
  });
});

describe("checks", () => {
  const c: TutorEvalCase = {
    id: "t",
    purpose: "t",
    level: "e3",
    l1Language: "Turkish",
    scenarioId: "s1_gp_appointment",
    history: [],
    learnerInput: "I have pain in my back since two weeks.",
    expect: {
      minEnglishShare: 0.7,
      recastApplied: true,
      mustMatch: ["have had .* for two weeks"],
      mustNotMatch: ["I have back pain for two weeks"],
      scoreMin: 0.5,
    },
  };

  it("passes a correct recast in English", () => {
    const f = checkTurnOutput(c, {
      reply:
        "I understood you. You have had pain in your back for two weeks. Where exactly does it hurt?",
      mode: "bridge",
      turn_score: 0.7,
      recastApplied: true,
    });
    expect(f.filter((x) => !x.passed)).toEqual([]);
  });

  it("fails the wrong recast from the live test and the banned words", () => {
    const f = checkTurnOutput(c, {
      reply:
        "Great job! I have back pain for two weeks. Just tell me more, it's easy.",
      mode: "bridge",
      turn_score: 0.9,
      recastApplied: false,
    });
    const failed = f.filter((x) => !x.passed).map((x) => x.check);
    expect(failed).toEqual(
      expect.arrayContaining([
        "must_match",
        "must_not_match",
        "banned_words",
        "recast_applied",
      ]),
    );
    expect(bannedWordsIn("Great job! Just do it, it's easy.")).toEqual(
      expect.arrayContaining(["just", "easy", "great job"]),
    );
  });

  it("flags unstable scores and inconsistent recasts across runs", () => {
    const f = checkStability(c, [
      { reply: "a", mode: "bridge", turn_score: 0.9, recastApplied: true },
      { reply: "b", mode: "bridge", turn_score: 0.5, recastApplied: false },
    ]);
    expect(f.map((x) => x.passed)).toEqual([false, false]);
  });
});

describe("deterministic turn score (proposal)", () => {
  it("scores 'ok' low and a real answer high, reproducibly", () => {
    const ok = deterministicTurnScore({ learnerMessage: "ok", level: "e2" });
    const real = deterministicTurnScore({
      learnerMessage:
        "Could I have an appointment on Thursday afternoon, please? My back hurts when I sit for a long time.",
      level: "e3",
    });
    expect(ok.score).toBeLessThan(0.4);
    expect(real.score).toBeGreaterThan(0.8);
    expect(
      deterministicTurnScore({ learnerMessage: "ok", level: "e2" }).score,
    ).toBe(ok.score);
  });

  it("caps a distress turn so ANCHOR triggers and scores L1 only low", () => {
    expect(
      deterministicTurnScore({
        learnerMessage: "I don't understand this at all please help",
        level: "e3",
        distress: true,
      }).score,
    ).toBeLessThanOrEqual(0.35);
    expect(
      deterministicTurnScore({
        learnerMessage: "أريد موعد مع الطبيب",
        level: "e1",
      }).score,
    ).toBeLessThan(0.4);
  });

  it("resolveTurnScore keeps the model score by default", () => {
    expect(resolveTurnScore(0.9, 0.3, "model")).toBe(0.9);
    expect(resolveTurnScore(0.9, 0.3, "deterministic")).toBe(0.3);
    expect(resolveTurnScore(0.9, 0.3, "blend")).toBe(0.6);
  });
});

describe("recast validation (proposal)", () => {
  it("accepts a minimal English correction", () => {
    expect(
      validateRecast("I have pain in my back since two weeks.", {
        has_error: true,
        corrected: "I have had pain in my back for two weeks.",
        error_type: "present perfect for duration",
        note_en: null,
      }),
    ).toMatchObject({
      has_error: true,
      corrected: "I have had pain in my back for two weeks.",
    });
  });
  it("rejects a rewrite, a non English answer, and a no-op claimed as an error", () => {
    const s = "I want appointment in Monday.";
    expect(validateRecast(s, { has_error: true, corrected: s })).toBeNull();
    expect(
      validateRecast(s, {
        has_error: true,
        corrected: "Pazartesi randevu istiyorum",
      }),
    ).toBeNull();
    expect(
      validateRecast(s, {
        has_error: true,
        corrected:
          "I would very much like to arrange an appointment with the doctor for Monday morning if at all possible, thank you.",
      }),
    ).toBeNull();
  });
});

describe("settings", () => {
  afterEach(() => {
    delete process.env.TUTOR_TEMPERATURE;
  });
  it("tutor turn defaults to a low temperature and honours the override", () => {
    expect(tutorTemperature()).toBe(0.3);
    process.env.TUTOR_TEMPERATURE = "0.7";
    expect(tutorTemperature()).toBe(0.7);
  });
  it("the ratio directive carries a hard English floor and the stretch rule", () => {
    const d = decideMode({
      level: "e3",
      message:
        "Hello, I would like to book an appointment with the doctor please.",
      recentScores: [],
      recentModes: [],
    });
    expect(d.l1RatioGuidance).toMatch(/HARD FLOOR: at least \d+% of the WORDS/);
    expect(d.modeDirective).toMatch(/i\+1/);
  });
});
