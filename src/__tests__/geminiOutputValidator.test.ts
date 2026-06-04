/**
 * Unit tests for the Gemini turn output validator (brief Function 7
 * To-Do 4). Pure function — no DB, no network.
 */

import {
  geminiTurnOutputSchema,
  validateGeminiTurnOutput,
} from "../utils/geminiOutputValidator";

const VALID = {
  reply: "Great work — you used 'appointment' correctly. Try again with 'I have an appointment at 3pm'.",
  mode: "bridge" as const,
  skill_codes_used: ["Sc", "Lr"],
  turn_score: 0.78,
  vocabulary_items_used: ["appointment"],
  safeguarding_flag: false,
  safeguarding_category: null,
  session_complete: false,
  session_summary: null,
};

describe("validateGeminiTurnOutput — happy path", () => {
  it("accepts a fully-valid turn output", () => {
    const out = validateGeminiTurnOutput(VALID);
    expect(out).toMatchObject(VALID);
  });

  it("accepts every mode value", () => {
    for (const mode of ["anchor", "bridge", "immersion"] as const) {
      expect(() => validateGeminiTurnOutput({ ...VALID, mode })).not.toThrow();
    }
  });

  it("accepts every safeguarding category when flag is true", () => {
    for (const cat of [
      "self_harm",
      "domestic_abuse",
      "radicalisation",
      "child_protection",
      "exploitation",
      "mental_health_crisis",
    ] as const) {
      expect(() =>
        validateGeminiTurnOutput({
          ...VALID,
          safeguarding_flag: true,
          safeguarding_category: cat,
        })
      ).not.toThrow();
    }
  });

  it("accepts a session-complete payload with a summary", () => {
    expect(() =>
      validateGeminiTurnOutput({
        ...VALID,
        session_complete: true,
        session_summary:
          "أحسنت — You learned how to book a GP appointment today. Next time we will practise repeat prescriptions.",
      })
    ).not.toThrow();
  });
});

describe("validateGeminiTurnOutput — field-level rejections", () => {
  it("rejects empty reply", () => {
    expect(() =>
      validateGeminiTurnOutput({ ...VALID, reply: "" })
    ).toThrow(/reply/);
  });

  it("rejects invalid mode", () => {
    expect(() =>
      validateGeminiTurnOutput({ ...VALID, mode: "DEEP_IMMERSION" })
    ).toThrow(/mode/);
  });

  it.each([-0.1, 1.1, 5, -2])(
    "rejects turn_score out of [0, 1] (%s)",
    (score) => {
      expect(() =>
        validateGeminiTurnOutput({ ...VALID, turn_score: score })
      ).toThrow(/turn_score/);
    }
  );

  it("rejects an unknown safeguarding_category", () => {
    expect(() =>
      validateGeminiTurnOutput({
        ...VALID,
        safeguarding_flag: true,
        safeguarding_category: "vague_distress",
      })
    ).toThrow(/safeguarding_category/);
  });

  it("rejects extra fields (.strict)", () => {
    expect(() =>
      validateGeminiTurnOutput({ ...VALID, mood: "happy" } as any)
    ).toThrow(/unexpected|unrecognized|strict/i);
  });

  it("rejects missing fields", () => {
    const { reply: _omit, ...rest } = VALID;
    expect(() => validateGeminiTurnOutput(rest)).toThrow();
  });

  it("rejects wrong-typed fields", () => {
    expect(() =>
      validateGeminiTurnOutput({ ...VALID, turn_score: "0.5" } as any)
    ).toThrow();
    expect(() =>
      validateGeminiTurnOutput({ ...VALID, skill_codes_used: "Sc" } as any)
    ).toThrow();
  });
});

describe("validateGeminiTurnOutput — cross-field invariants", () => {
  it("rejects safeguarding_flag=true with null category", () => {
    expect(() =>
      validateGeminiTurnOutput({
        ...VALID,
        safeguarding_flag: true,
        safeguarding_category: null,
      })
    ).toThrow(/safeguarding_category is required/);
  });

  it("rejects safeguarding_flag=false with a category set", () => {
    expect(() =>
      validateGeminiTurnOutput({
        ...VALID,
        safeguarding_flag: false,
        safeguarding_category: "self_harm",
      })
    ).toThrow(/must be null/);
  });

  it("rejects session_complete=true with null summary", () => {
    expect(() =>
      validateGeminiTurnOutput({
        ...VALID,
        session_complete: true,
        session_summary: null,
      })
    ).toThrow(/session_summary is required/);
  });

  it("rejects session_complete=false with a summary set", () => {
    expect(() =>
      validateGeminiTurnOutput({
        ...VALID,
        session_complete: false,
        session_summary: "Nice work today.",
      })
    ).toThrow(/must be null/);
  });
});

describe("validateGeminiTurnOutput — error message shape", () => {
  it("includes the failing field path in the message (for log greppability)", () => {
    try {
      validateGeminiTurnOutput({ ...VALID, turn_score: 5 });
      fail("expected throw");
    } catch (err) {
      expect((err as Error).message).toMatch(/turn_score/);
    }
  });

  it("reports multiple issues in one message (Zod safeParse aggregates)", () => {
    try {
      validateGeminiTurnOutput({
        ...VALID,
        mode: "wrong",
        turn_score: 99,
      });
      fail("expected throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/mode/);
      expect(msg).toMatch(/turn_score/);
    }
  });
});

describe("geminiTurnOutputSchema — safeParse surface", () => {
  it("returns success: true on valid input", () => {
    const r = geminiTurnOutputSchema.safeParse(VALID);
    expect(r.success).toBe(true);
  });

  it("returns success: false with structured issues on invalid input", () => {
    const r = geminiTurnOutputSchema.safeParse({ ...VALID, turn_score: 2 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("turn_score"))).toBe(true);
    }
  });
});
