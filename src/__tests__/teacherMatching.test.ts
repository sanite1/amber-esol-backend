/**
 * Pure-function tests for the matching scorer — no DB, no network.
 * The I/O surfaces (rank/auto-assign) are thin wrappers over these
 * semantics, so this is where the matching rules are pinned down.
 */
import {
  scoreTeacherForLearner,
  levelToCode,
  MatchLearner,
  MatchTeacher,
} from "../services/teacherMatching.service";

const teacher = (profile?: MatchTeacher["teaching_profile"]): MatchTeacher => ({
  _id: "64b000000000000000000001",
  firstname: "Test",
  lastname: "Teacher",
  teaching_profile: profile ?? null,
});

const learner: MatchLearner = {
  esolLevel: "Entry 2",
  l1Language: "Arabic",
  esol_aim_type: "regulated",
  employment_status: 10,
};

describe("levelToCode", () => {
  it("accepts code and display forms", () => {
    expect(levelToCode("e1")).toBe("e1");
    expect(levelToCode("Entry 1")).toBe("e1");
    expect(levelToCode("ENTRY 3")).toBe("e3");
    expect(levelToCode("Level 2")).toBe("l2");
    expect(levelToCode("L1")).toBe("l1");
  });

  it("returns null for unknowns", () => {
    expect(levelToCode("")).toBeNull();
    expect(levelToCode(null)).toBeNull();
    expect(levelToCode("beginner")).toBeNull();
  });
});

describe("scoreTeacherForLearner — hard filters", () => {
  it("rejects a teacher at capacity, regardless of fit", () => {
    const result = scoreTeacherForLearner(
      learner,
      teacher({
        levels_taught: ["e2"],
        languages_spoken: ["Arabic"],
        specialisms: ["exam_preparation"],
      }),
      150,
      150,
    );
    expect(result.eligible).toBe(false);
    expect(result.ineligible_reason).toBe("At capacity");
  });

  it("rejects a teacher whose declared levels exclude the learner's", () => {
    const result = scoreTeacherForLearner(
      learner,
      teacher({
        levels_taught: ["l1", "l2"],
        languages_spoken: [],
        specialisms: [],
      }),
      0,
      150,
    );
    expect(result.eligible).toBe(false);
    expect(result.ineligible_reason).toContain("Entry 2");
  });

  it("keeps a teacher with an EMPTY profile eligible (unspecified ≠ excluded)", () => {
    const result = scoreTeacherForLearner(learner, teacher(), 0, 150);
    expect(result.eligible).toBe(true);
  });

  it("drops the level gate (but not capacity) when enforceLevelFilter=false", () => {
    const wrongLevel = teacher({
      levels_taught: ["l2"],
      languages_spoken: [],
      specialisms: [],
    });
    expect(
      scoreTeacherForLearner(learner, wrongLevel, 0, 150, false).eligible,
    ).toBe(true);
    expect(
      scoreTeacherForLearner(learner, wrongLevel, 150, 150, false).eligible,
    ).toBe(false);
  });
});

describe("scoreTeacherForLearner — scoring + reasons", () => {
  it("scores L1 (+3), explicit level (+2) and exam specialism (+2) with reasons", () => {
    const result = scoreTeacherForLearner(
      learner,
      teacher({
        levels_taught: ["e2"],
        languages_spoken: ["arabic"], // case-insensitive
        specialisms: ["exam_preparation"],
      }),
      0,
      150,
    );
    expect(result.eligible).toBe(true);
    // 3 + 2 + 2 + employability(0, not in specialisms) + load bonus 1.0
    expect(result.score).toBeCloseTo(8, 5);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        "Speaks Arabic",
        "Teaches Entry 2",
        "Exam preparation specialist",
      ]),
    );
  });

  it("a full signal always beats any load difference", () => {
    // Busy L1-speaker vs idle non-speaker: language must win.
    const busySpeaker = scoreTeacherForLearner(
      learner,
      teacher({
        levels_taught: [],
        languages_spoken: ["Arabic"],
        specialisms: [],
      }),
      149,
      150,
    );
    const idleNonSpeaker = scoreTeacherForLearner(
      learner,
      teacher({ levels_taught: [], languages_spoken: [], specialisms: [] }),
      0,
      150,
    );
    expect(busySpeaker.score).toBeGreaterThan(idleNonSpeaker.score);
  });

  it("equal fits: lower load scores higher", () => {
    const profile = {
      levels_taught: ["e2"],
      languages_spoken: [],
      specialisms: [],
    };
    const idle = scoreTeacherForLearner(learner, teacher(profile), 10, 150);
    const busy = scoreTeacherForLearner(learner, teacher(profile), 100, 150);
    expect(idle.score).toBeGreaterThan(busy.score);
  });

  it("no employability bonus when the learner has no employment status", () => {
    const noStatus: MatchLearner = { ...learner, employment_status: null };
    const result = scoreTeacherForLearner(
      noStatus,
      teacher({
        levels_taught: [],
        languages_spoken: [],
        specialisms: ["employability"],
      }),
      0,
      150,
    );
    expect(result.reasons).not.toContain("Employability specialist");
  });
});
