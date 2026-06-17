import {
  advanceBeat,
  initialBeatState,
  microStageLabel,
  MICRO_STAGE_COUNT,
  DEFAULT_MICRO_STAGES,
} from "../services/sessionBeat.service";

/**
 * F25 three-beat scenario engine — pure state-machine tests. No Gemini,
 * no Mongo. Covers the PREPARE→ROLEPLAY→COMPLETE arc, the four-dot
 * micro-stage progression, the no-gating rule, and defensive coercion
 * of malformed stored state.
 */
describe("F25 sessionBeat state machine", () => {
  it("starts in PREPARE with four empty dots", () => {
    const s = initialBeatState();
    expect(s.beat).toBe("prepare");
    expect(s.microStageIndex).toBe(0);
    expect(s.microStagesCompleted).toEqual([false, false, false, false]);
  });

  it("first turn moves PREPARE → ROLEPLAY even with no micro-stage signal", () => {
    const next = advanceBeat(initialBeatState(), {
      microStageComplete: false,
      sessionComplete: false,
    });
    expect(next.beat).toBe("roleplay");
    expect(next.microStageIndex).toBe(0);
    expect(next.microStagesCompleted).toEqual([false, false, false, false]);
  });

  it("microStageComplete fills the current dot and advances the index", () => {
    let s = advanceBeat(initialBeatState(), {
      microStageComplete: true,
      sessionComplete: false,
    });
    expect(s.beat).toBe("roleplay");
    expect(s.microStagesCompleted).toEqual([true, false, false, false]);
    expect(s.microStageIndex).toBe(1);

    s = advanceBeat(s, { microStageComplete: true, sessionComplete: false });
    expect(s.microStagesCompleted).toEqual([true, true, false, false]);
    expect(s.microStageIndex).toBe(2);
  });

  it("index never advances past the last dot", () => {
    let s = initialBeatState();
    for (let i = 0; i < 10; i += 1) {
      s = advanceBeat(s, { microStageComplete: true, sessionComplete: false });
    }
    expect(s.microStageIndex).toBe(MICRO_STAGE_COUNT - 1);
    expect(s.microStagesCompleted).toEqual([true, true, true, true]);
  });

  it("session_complete moves to COMPLETE and fills every dot", () => {
    const s = advanceBeat(
      {
        beat: "roleplay",
        microStageIndex: 1,
        microStagesCompleted: [true, false, false, false],
      },
      { microStageComplete: false, sessionComplete: true },
    );
    expect(s.beat).toBe("complete");
    expect(s.microStagesCompleted).toEqual([true, true, true, true]);
    expect(s.microStageIndex).toBe(MICRO_STAGE_COUNT - 1);
  });

  it("no gating: a turn with neither signal keeps the learner on the same dot", () => {
    const start = {
      beat: "roleplay" as const,
      microStageIndex: 2,
      microStagesCompleted: [true, true, false, false],
    };
    const s = advanceBeat(start, {
      microStageComplete: false,
      sessionComplete: false,
    });
    expect(s.microStageIndex).toBe(2);
    expect(s.microStagesCompleted).toEqual([true, true, false, false]);
  });

  it("coerces malformed/short stored state without throwing", () => {
    const s = advanceBeat(
      // index out of range, completed array too short, beat undefined
      { microStageIndex: 99, microStagesCompleted: [true] as boolean[] },
      { microStageComplete: false, sessionComplete: false },
    );
    expect(s.beat).toBe("roleplay");
    expect(s.microStageIndex).toBe(MICRO_STAGE_COUNT - 1);
    expect(s.microStagesCompleted).toHaveLength(MICRO_STAGE_COUNT);
    expect(s.microStagesCompleted[0]).toBe(true);
  });

  it("microStageLabel uses scenario labels when exactly four, else the default arc", () => {
    const stages = ["A", "B", "C", "D"];
    expect(microStageLabel(stages, 2)).toBe("C");
    // wrong length → default arc
    expect(microStageLabel(["only-one"], 0)).toBe(DEFAULT_MICRO_STAGES[0]);
    // undefined → default arc
    expect(microStageLabel(undefined, 1)).toBe(DEFAULT_MICRO_STAGES[1]);
    // out-of-range index clamps
    expect(microStageLabel(stages, 99)).toBe("D");
  });
});
