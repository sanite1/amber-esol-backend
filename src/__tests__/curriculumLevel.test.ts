/**
 * Pure tests for NQF level normalisation. The ESOL codebase stores
 * levels in both display ("Entry 1") and code ("e1") forms across
 * User, AISession, scenarios and the curriculum — this helper is the
 * single reconciliation point, so its behaviour is pinned here.
 */
import CurriculumLevelService, {
  normaliseNqfLevel,
} from "../services/curriculumLevel.service";

describe("normaliseNqfLevel", () => {
  it("accepts code form, any case", () => {
    expect(normaliseNqfLevel("e1")).toBe("E1");
    expect(normaliseNqfLevel("E3")).toBe("E3");
    expect(normaliseNqfLevel("l2")).toBe("L2");
  });

  it("accepts display form", () => {
    expect(normaliseNqfLevel("Entry 1")).toBe("E1");
    expect(normaliseNqfLevel("entry 3")).toBe("E3");
    expect(normaliseNqfLevel("Level 1")).toBe("L1");
    expect(normaliseNqfLevel("LEVEL 2")).toBe("L2");
  });

  it("returns null for unknown / non-string", () => {
    expect(normaliseNqfLevel("beginner")).toBeNull();
    expect(normaliseNqfLevel("")).toBeNull();
    expect(normaliseNqfLevel(null)).toBeNull();
    expect(normaliseNqfLevel(undefined)).toBeNull();
    expect(normaliseNqfLevel(3)).toBeNull();
  });
});

/**
 * F27 curriculum helpers — degraded-cache safety. With no level docs
 * loaded (the unit-test process never calls loadAll), these must return
 * safe nulls/empties so the vocab ledger + prompt builder fall back to
 * their defaults rather than throwing.
 */
describe("F27 curriculum helpers (empty cache)", () => {
  beforeAll(() => CurriculumLevelService.__resetForTests());

  it("getRetentionMinEncounters returns null when the level isn't seeded", () => {
    expect(CurriculumLevelService.getRetentionMinEncounters("e1")).toBeNull();
    expect(
      CurriculumLevelService.getRetentionMinEncounters("bogus"),
    ).toBeNull();
  });

  it("getLongHorizonForms returns [] when the level isn't seeded", () => {
    expect(CurriculumLevelService.getLongHorizonForms("e2")).toEqual([]);
  });

  it("isLongHorizonForm is false for empty input and unseeded levels", () => {
    expect(CurriculumLevelService.isLongHorizonForm("e2", "")).toBe(false);
    expect(CurriculumLevelService.isLongHorizonForm("e2", "3SG-s")).toBe(false);
  });
});
