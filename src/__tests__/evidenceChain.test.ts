/**
 * F29 evidence-chain writer tests.
 *
 *   E1  recordTurnEvidence writes one mapped row per data point
 *   E2  turn_score row carries human_confirm=true, human_confirmed=false
 *   E3  re-processing the same turn is idempotent (upsert, no dupes)
 *   E4  recordSessionCompleteEvidence writes beat_3 rows
 *   E5  ilr_fields are stamped from evidence_mapping.json
 */

process.env.REFERRAL_JWT_SECRET =
  process.env.REFERRAL_JWT_SECRET ?? "test-secret";

import { Types } from "mongoose";
import EvidenceRecord from "../models/EvidenceRecord";
import {
  recordTurnEvidence,
  recordSessionCompleteEvidence,
} from "../services/evidenceChain.service";

const ids = () => ({
  learnerId: new Types.ObjectId(),
  orgId: new Types.ObjectId(),
  sessionId: new Types.ObjectId(),
});

describe("F29 recordTurnEvidence", () => {
  it("E1 — writes one mapped row per supplied data point", async () => {
    const { learnerId, orgId, sessionId } = ids();
    await recordTurnEvidence({
      learnerId,
      orgId,
      sessionId,
      turnIndex: 0,
      turnScore: 0.8,
      skillCodesUsed: ["Sc", "Lr"],
      vocabularyItemsUsed: ["appointment"],
      mode: "bridge",
      recastApplied: true,
    });

    const rows = await EvidenceRecord.find({ sessionId }).lean();
    const dataPoints = rows.map((r) => r.data_point).sort();
    expect(dataPoints).toEqual(
      [
        "recast_uptake",
        "skill_codes",
        "teaching_mode_and_transitions",
        "turn_score",
        "vocabulary_items_used",
      ].sort(),
    );
    expect(rows.every((r) => r.beat === "beat_2_roleplay")).toBe(true);
  });

  it("E2 — turn_score is human_confirm=true but starts unconfirmed (honesty gate)", async () => {
    const { learnerId, orgId, sessionId } = ids();
    await recordTurnEvidence({
      learnerId,
      orgId,
      sessionId,
      turnIndex: 0,
      turnScore: 0.9,
    });
    const row = await EvidenceRecord.findOne({
      sessionId,
      data_point: "turn_score",
    }).lean();
    expect(row!.human_confirm).toBe(true);
    expect(row!.human_confirmed).toBe(false);
    expect(row!.value).toBe(0.9);
  });

  it("E3 — reprocessing the same turn does not duplicate rows", async () => {
    const { learnerId, orgId, sessionId } = ids();
    const args = {
      learnerId,
      orgId,
      sessionId,
      turnIndex: 2,
      turnScore: 0.5,
      skillCodesUsed: ["Sc"],
    };
    await recordTurnEvidence(args);
    await recordTurnEvidence(args);
    const count = await EvidenceRecord.countDocuments({
      sessionId,
      turnIndex: 2,
    });
    // turn_score + skill_codes = 2 rows, not 4.
    expect(count).toBe(2);
  });

  it("E5 — vocabulary_items_used is formative (human_confirm=false)", async () => {
    const { learnerId, orgId, sessionId } = ids();
    await recordTurnEvidence({
      learnerId,
      orgId,
      sessionId,
      turnIndex: 0,
      vocabularyItemsUsed: ["payslip", "tax"],
    });
    const row = await EvidenceRecord.findOne({
      sessionId,
      data_point: "vocabulary_items_used",
    }).lean();
    expect(row!.human_confirm).toBe(false);
    expect(row!.value).toEqual(["payslip", "tax"]);
  });
});

describe("F29 recordSessionCompleteEvidence", () => {
  it("E4 — writes session_complete + session_summary beat_3 rows", async () => {
    const { learnerId, orgId, sessionId } = ids();
    await recordSessionCompleteEvidence({
      learnerId,
      orgId,
      sessionId,
      sessionSummary: "You asked for an appointment clearly today.",
    });
    const rows = await EvidenceRecord.find({
      sessionId,
      beat: "beat_3_complete",
    }).lean();
    const dataPoints = rows.map((r) => r.data_point).sort();
    expect(dataPoints).toEqual(["session_complete", "session_summary"]);
  });

  it("E4b — omits session_summary row when summary is null", async () => {
    const { learnerId, orgId, sessionId } = ids();
    await recordSessionCompleteEvidence({
      learnerId,
      orgId,
      sessionId,
      sessionSummary: null,
    });
    const rows = await EvidenceRecord.find({
      sessionId,
      beat: "beat_3_complete",
    }).lean();
    expect(rows.map((r) => r.data_point)).toEqual(["session_complete"]);
  });
});
