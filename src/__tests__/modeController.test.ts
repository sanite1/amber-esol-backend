import {
  decideMode,
  reconcileMode,
  matchesConfusion,
  l1RatioForLevel,
  getModeThresholds,
  DEFAULT_MODE_THRESHOLDS,
} from "../services/modeController.service";

/**
 * F26 Bridge-Method mode controller — pure decision tests.
 *
 * No DB: with the CurriculumLevel + ComplianceConfig caches unloaded,
 * the controller falls back to DEFAULT_MODE_THRESHOLDS and the
 * per-level L1 fallback table, which is exactly the degraded path we
 * want to pin down.
 */
describe("F26 mode controller", () => {
  describe("getModeThresholds", () => {
    it("returns the brief defaults when no bridge-mode config is seeded", () => {
      expect(getModeThresholds()).toEqual(DEFAULT_MODE_THRESHOLDS);
    });
  });

  describe("l1RatioForLevel (fallback table)", () => {
    it("E1 leans heavily on L1, L2 barely at all", () => {
      expect(l1RatioForLevel("e1").min).toBeGreaterThan(
        l1RatioForLevel("l2").min,
      );
      expect(l1RatioForLevel("l2").max).toBeLessThanOrEqual(0.1);
    });
  });

  describe("matchesConfusion", () => {
    it("detects English confusion markers", () => {
      expect(matchesConfusion("sorry, I don't understand")).toBe(true);
      expect(matchesConfusion("this is too hard")).toBe(true);
    });
    it("detects MVP-language markers (ar / yue / tr)", () => {
      expect(matchesConfusion("لا أفهم")).toBe(true);
      expect(matchesConfusion("我唔明")).toBe(true);
      expect(matchesConfusion("anlamıyorum")).toBe(true);
    });
    it("does not fire on an ordinary confident reply", () => {
      expect(
        matchesConfusion("Yes, I would like to book an appointment please"),
      ).toBe(false);
    });
  });

  describe("decideMode signals", () => {
    const base = {
      level: "e2" as const,
      recentScores: [],
      recentModes: [],
    };

    it("confusion forces ANCHOR + distress + widened L1", () => {
      const d = decideMode({ ...base, message: "I don't understand" });
      expect(d.mode).toBe("anchor");
      expect(d.distress).toBe(true);
      // distress widens the upper L1 bound to full L1
      expect(d.l1Ratio.max).toBe(1);
    });

    it("a very short response drops to ANCHOR", () => {
      const d = decideMode({ ...base, message: "yes ok" });
      expect(d.mode).toBe("anchor");
      expect(d.distress).toBe(false);
    });

    it("a low previous score drops to ANCHOR", () => {
      const d = decideMode({
        ...base,
        message: "I went to the shop and bought some bread for my family",
        recentScores: [0.2],
      });
      expect(d.mode).toBe("anchor");
    });

    it("a healthy mid-length turn stays in BRIDGE", () => {
      const d = decideMode({
        ...base,
        message: "I would like to ask the receptionist for an appointment",
        recentScores: [0.6, 0.65],
      });
      expect(d.mode).toBe("bridge");
    });

    it("three consecutive high scores promote to IMMERSION", () => {
      const d = decideMode({
        ...base,
        message: "I called the surgery and explained my symptoms clearly",
        recentScores: [0.85, 0.9, 0.82],
        recentModes: ["bridge", "bridge", "bridge"],
      });
      expect(d.mode).toBe("immersion");
    });

    it("does NOT promote to IMMERSION if ANCHOR fired earlier this session", () => {
      const d = decideMode({
        ...base,
        message: "I called the surgery and explained my symptoms clearly",
        recentScores: [0.85, 0.9, 0.82],
        recentModes: ["anchor", "bridge", "bridge"],
      });
      expect(d.mode).toBe("bridge");
    });
  });

  describe("reconcileMode — more-supportive wins", () => {
    it("anchor beats bridge and immersion", () => {
      expect(reconcileMode("bridge", "anchor")).toBe("anchor");
      expect(reconcileMode("anchor", "immersion")).toBe("anchor");
    });
    it("bridge beats immersion", () => {
      expect(reconcileMode("immersion", "bridge")).toBe("bridge");
    });
    it("agreement is a no-op", () => {
      expect(reconcileMode("immersion", "immersion")).toBe("immersion");
    });
  });
});
