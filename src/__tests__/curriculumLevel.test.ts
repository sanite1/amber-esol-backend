/**
 * Pure tests for NQF level normalisation. The ESOL codebase stores
 * levels in both display ("Entry 1") and code ("e1") forms across
 * User, AISession, scenarios and the curriculum — this helper is the
 * single reconciliation point, so its behaviour is pinned here.
 */
import { normaliseNqfLevel } from "../services/curriculumLevel.service";

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
