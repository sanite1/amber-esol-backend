import {
  buildStage3ObjectivesForPlacement,
  buildStage3NegotiationScript,
} from "../services/rarpa.service";
import { IStage3Objective } from "../interfaces/user.interface";

/**
 * F30 Stage 3 — pure tests for the placement objective builder and the
 * L1 negotiation script. The CurriculumLevel cache is unloaded in the
 * test process, so `buildStage3ObjectivesForPlacement` exercises the
 * template-fallback path; the curriculum-sourced path is covered by the
 * integration suite where the level docs are seeded.
 */
describe("F30 buildStage3ObjectivesForPlacement (template fallback)", () => {
  it("dedupes weakness flags to one objective per parent domain", () => {
    // Rt + Rs + Rw are all reading sub-codes → ONE reading objective.
    const objs = buildStage3ObjectivesForPlacement("e2", ["Rt", "Rs", "Rw"]);
    const reading = objs.filter((o) => o.skill_domain === "Rt");
    expect(reading).toHaveLength(1);
  });

  it("always appends exactly one general objective", () => {
    const none = buildStage3ObjectivesForPlacement("e1", []);
    expect(none).toHaveLength(1);
    expect(none[0].skill_domain).toBe("general");

    const some = buildStage3ObjectivesForPlacement("e3", ["Sc", "Wt"]);
    const general = some.filter((o) => o.skill_domain === "general");
    expect(general).toHaveLength(1);
  });

  it("emits domains in a stable reading→writing→listening→speaking order", () => {
    const objs = buildStage3ObjectivesForPlacement("l1", [
      "Sc",
      "Wt",
      "Rt",
      "Lr",
    ]);
    const domains = objs
      .filter((o) => o.skill_domain !== "general")
      .map((o) => o.skill_domain);
    expect(domains).toEqual(["Rt", "Wt", "Lr", "Sc"]);
  });

  it("stamps every objective with set_from=placement_assessment + target_level", () => {
    const objs = buildStage3ObjectivesForPlacement("e2", ["Rt"]);
    for (const o of objs) {
      expect(o.set_from).toBe("placement_assessment");
      expect(o.target_level).toBe("e2");
      expect(o.id).toBeTruthy();
      expect(o.description.length).toBeGreaterThan(0);
    }
  });
});

describe("F30 buildStage3NegotiationScript", () => {
  const objs: IStage3Objective[] = [
    {
      id: "1",
      skill_domain: "Rt",
      description: "Read everyday texts at Entry Level 2",
      set_at: new Date(),
    },
    {
      id: "2",
      skill_domain: "general",
      description: "Develop functional English communication",
      set_at: new Date(),
    },
  ];

  it("renders each objective as a bullet in every MVP language", () => {
    for (const lang of ["english", "arabic", "cantonese", "turkish"]) {
      const script = buildStage3NegotiationScript(objs, lang);
      expect(script).toContain("• Read everyday texts at Entry Level 2");
      expect(script).toContain("• Develop functional English communication");
    }
  });

  it("uses the L1 invitation line per language", () => {
    expect(buildStage3NegotiationScript(objs, "arabic")).toContain("أهدافك");
    expect(buildStage3NegotiationScript(objs, "turkish")).toContain("hedefler");
    expect(buildStage3NegotiationScript(objs, "cantonese")).toContain(
      "學習目標",
    );
  });

  it("falls back to English for an unknown / non-MVP language", () => {
    const script = buildStage3NegotiationScript(objs, "klingon");
    expect(script).toContain("These are your learning goals");
  });
});
