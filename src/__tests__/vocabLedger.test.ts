/**
 * Vocab ledger writer + reader tests — brief Function 9 To-Do 1 + 2.
 *
 *   updateLedgerForTurn
 *     U1  Fresh word → insert with times_encountered=1, retained=false
 *     U2  Existing word → increment, keep scenario_first_seen + stage3
 *     U3  Retention flips at 5+ encounters with score ≥ 0.7
 *     U4  Retention is sticky — low-score turn after retained=true
 *         does NOT flip it back
 *     U5  Multiple words in one turn each get one upsert
 *     U6  Repeated word inside a single turn counts as ONE encounter
 *     U7  Concurrent updates against the same word don't lose counts
 *
 *   getReinforcementTargets
 *     R1  Returns up to N un-retained words
 *     R2  Sorts by times_encountered ASC then last_seen_at ASC
 *     R3  Excludes retained=true
 *     R4  Empty when learner has no rows
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import VocabLedger from "../models/VocabLedger";
import {
  updateLedgerForTurn,
  getReinforcementTargets,
} from "../services/vocabLedger.service";

const learnerId = () => new Types.ObjectId();

const withSeenAt = async (
  learner: Types.ObjectId,
  word: string,
  seenAt: Date,
): Promise<void> => {
  // Direct write — for tests that need to backdate last_seen_at.
  await VocabLedger.updateOne(
    { learnerId: learner, word },
    { $set: { last_seen_at: seenAt } },
  );
};

// ═════════════════════════════════════════════════════════════════════
// updateLedgerForTurn
// ═════════════════════════════════════════════════════════════════════

describe("updateLedgerForTurn", () => {
  it("U1 — fresh word inserts with times_encountered=1, retained=false", async () => {
    const learner = learnerId();
    await updateLedgerForTurn(
      learner,
      ["appointment"],
      0.8,
      "s1_gp_appointment",
      "obj-Sc",
    );

    const row = await VocabLedger.findOne({
      learnerId: learner,
      word: "appointment",
    }).lean();
    expect(row).toBeTruthy();
    expect((row as any).times_encountered).toBe(1);
    expect((row as any).retained).toBe(false);
    expect((row as any).scenario_first_seen).toBe("s1_gp_appointment");
    expect((row as any).stage3_objective_id).toBe("obj-Sc");
    expect((row as any).last_seen_at).toBeInstanceOf(Date);
  });

  it("U2 — existing word increments, scenario_first_seen + stage3_objective_id are immutable", async () => {
    const learner = learnerId();
    await updateLedgerForTurn(
      learner,
      ["payslip"],
      0.5,
      "s1_gp_appointment",
      "obj-A",
    );
    await updateLedgerForTurn(learner, ["payslip"], 0.5, "s2_payslip", "obj-B");
    await updateLedgerForTurn(
      learner,
      ["payslip"],
      0.5,
      "s3_housing_rights",
      "obj-C",
    );

    const row = await VocabLedger.findOne({
      learnerId: learner,
      word: "payslip",
    }).lean();
    expect((row as any).times_encountered).toBe(3);
    // First-seen values are pinned from the insert call
    expect((row as any).scenario_first_seen).toBe("s1_gp_appointment");
    expect((row as any).stage3_objective_id).toBe("obj-A");
  });

  it("U3 — retention flips at 5+ encounters with score ≥ 0.7", async () => {
    const learner = learnerId();
    // 4 low-score encounters — not retained yet
    for (let i = 0; i < 4; i++) {
      await updateLedgerForTurn(
        learner,
        ["tenancy"],
        0.4,
        "s3_housing_rights",
        "obj-Rt",
      );
    }
    let row = await VocabLedger.findOne({
      learnerId: learner,
      word: "tenancy",
    }).lean();
    expect((row as any).times_encountered).toBe(4);
    expect((row as any).retained).toBe(false);

    // 5th encounter, score ≥ 0.7 — flips to retained
    await updateLedgerForTurn(
      learner,
      ["tenancy"],
      0.75,
      "s3_housing_rights",
      "obj-Rt",
    );
    row = await VocabLedger.findOne({
      learnerId: learner,
      word: "tenancy",
    }).lean();
    expect((row as any).times_encountered).toBe(5);
    expect((row as any).retained).toBe(true);
  });

  it("U3.b — 5+ encounters but low score → NOT retained yet", async () => {
    const learner = learnerId();
    for (let i = 0; i < 6; i++) {
      await updateLedgerForTurn(
        learner,
        ["deposit"],
        0.5,
        "s3_housing_rights",
        "obj-Rt",
      );
    }
    const row = await VocabLedger.findOne({
      learnerId: learner,
      word: "deposit",
    }).lean();
    expect((row as any).times_encountered).toBe(6);
    expect((row as any).retained).toBe(false); // never crossed the 0.7 threshold
  });

  it("U4 — retention is sticky (a later low-score turn does NOT flip it back)", async () => {
    const learner = learnerId();
    // Get to retained
    for (let i = 0; i < 5; i++) {
      await updateLedgerForTurn(
        learner,
        ["landlord"],
        0.8,
        "s3_housing_rights",
        "obj-Sc",
      );
    }
    let row = await VocabLedger.findOne({
      learnerId: learner,
      word: "landlord",
    }).lean();
    expect((row as any).retained).toBe(true);

    // Subsequent low-score turn — retained stays true
    await updateLedgerForTurn(
      learner,
      ["landlord"],
      0.2,
      "s3_housing_rights",
      "obj-Sc",
    );
    row = await VocabLedger.findOne({
      learnerId: learner,
      word: "landlord",
    }).lean();
    expect((row as any).retained).toBe(true);
    expect((row as any).times_encountered).toBe(6);
  });

  it("U5 — multiple words in one turn each get one upsert", async () => {
    const learner = learnerId();
    await updateLedgerForTurn(
      learner,
      ["GP", "appointment", "prescription"],
      0.8,
      "s1_gp_appointment",
      "obj-Sc",
    );
    const rows = await VocabLedger.find({ learnerId: learner }).lean();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => (r as any).times_encountered === 1)).toBe(true);
  });

  it("U6 — a word repeated inside one turn counts as ONE encounter", async () => {
    const learner = learnerId();
    await updateLedgerForTurn(
      learner,
      ["doctor", "doctor", "doctor"],
      0.6,
      "s1_gp_appointment",
      "obj-Sc",
    );
    const row = await VocabLedger.findOne({
      learnerId: learner,
      word: "doctor",
    }).lean();
    expect((row as any).times_encountered).toBe(1);
  });

  it("U7 — concurrent updates against the same word don't lose counts", async () => {
    const learner = learnerId();
    // 10 parallel turns each incrementing the same word.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        updateLedgerForTurn(
          learner,
          ["arrears"],
          0.5,
          "s3_housing_rights",
          "obj-Rt",
        ),
      ),
    );
    const row = await VocabLedger.findOne({
      learnerId: learner,
      word: "arrears",
    }).lean();
    // All 10 increments landed — no lost updates.
    expect((row as any).times_encountered).toBe(10);
  });
});

// ═════════════════════════════════════════════════════════════════════
// getReinforcementTargets
// ═════════════════════════════════════════════════════════════════════

describe("getReinforcementTargets", () => {
  it("R1 — returns up to N un-retained words", async () => {
    const learner = learnerId();
    // 8 words; default limit is 6
    for (const w of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      await updateLedgerForTurn(learner, [w], 0.4, "s1", "obj-X");
    }
    const targets = await getReinforcementTargets(learner);
    expect(targets).toHaveLength(6);
    expect(targets.every((t) => t.times_encountered === 1)).toBe(true);
  });

  it("R2 — sorts by times_encountered ASC then last_seen_at ASC", async () => {
    const learner = learnerId();

    // Bump "common" to 3 encounters, fresh single-encounter words for
    // the rest. Override last_seen_at explicitly to fixed dates so the
    // sort is reproducible regardless of when the test runs.
    await updateLedgerForTurn(learner, ["common"], 0.4, "s1", "obj-X");
    await updateLedgerForTurn(learner, ["common"], 0.4, "s1", "obj-X");
    await updateLedgerForTurn(learner, ["common"], 0.4, "s1", "obj-X");

    await updateLedgerForTurn(learner, ["middle"], 0.4, "s1", "obj-X");
    await withSeenAt(learner, "middle", new Date("2024-06-15"));

    await updateLedgerForTurn(learner, ["older"], 0.4, "s1", "obj-X");
    await withSeenAt(learner, "older", new Date("2024-01-01"));

    await updateLedgerForTurn(learner, ["newer"], 0.4, "s1", "obj-X");
    await withSeenAt(learner, "newer", new Date("2024-12-31"));

    // common (3 enc): set its last_seen_at far enough in the future that
    // it sorts last regardless of the tier-2 sort.
    await withSeenAt(learner, "common", new Date("2024-12-01"));

    const targets = await getReinforcementTargets(learner, 6);
    // First three: the times_encountered=1 group, ordered by last_seen_at ASC.
    expect(targets.slice(0, 3).map((t) => t.word)).toEqual([
      "older",
      "middle",
      "newer",
    ]);
    // Last: times_encountered=3 (common).
    expect(targets[targets.length - 1].word).toBe("common");
  });

  it("R3 — retained=true rows are excluded", async () => {
    const learner = learnerId();
    // Get "remembered" retained
    for (let i = 0; i < 5; i++) {
      await updateLedgerForTurn(learner, ["remembered"], 0.8, "s1", "obj-X");
    }
    // Add a fresh unretained word
    await updateLedgerForTurn(learner, ["forgotten"], 0.4, "s1", "obj-X");

    const targets = await getReinforcementTargets(learner);
    expect(targets.map((t) => t.word)).toEqual(["forgotten"]);
  });

  it("R4 — empty array when learner has no rows", async () => {
    const targets = await getReinforcementTargets(learnerId());
    expect(targets).toEqual([]);
  });

  it("R5 — limit cap is enforced", async () => {
    const learner = learnerId();
    for (let i = 0; i < 8; i++) {
      await updateLedgerForTurn(learner, [`word${i}`], 0.4, "s1", "obj-X");
    }
    expect(await getReinforcementTargets(learner, 3)).toHaveLength(3);
  });
});
