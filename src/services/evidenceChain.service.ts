import { Types } from "mongoose";

import EvidenceRecord, { EvidenceBeat } from "../models/EvidenceRecord";
import { PronunciationAssessment } from "../interfaces/pronunciation.interface";
import {
  getEvidenceMapping,
  getEvidenceMappingVersion,
} from "./evidenceMapping.service";
import logger from "../config/logger";

/**
 * Evidence-chain writer — AI Tutor Build Brief F29.
 *
 * Writes one structured, append-only EvidenceRecord per captured data
 * point, stamping it with the ILR fields / RARPA stage / human-confirm
 * requirement from evidence_mapping.json. Called at CAPTURE TIME — the
 * per-turn worker (beat_2_roleplay) and the session-complete path
 * (beat_3_complete) — so the chain is built as learning happens.
 *
 * Best-effort by design: evidence is supporting, not load-bearing for
 * the learner's reply, so a write failure logs and swallows rather than
 * breaking the turn. The records are upserted on
 * (sessionId, beat, data_point, turnIndex) so a reprocessed turn
 * doesn't duplicate rows.
 */

const toObjectId = (
  id: string | Types.ObjectId | null | undefined,
): Types.ObjectId | null => {
  if (!id) return null;
  if (id instanceof Types.ObjectId) return id;
  return Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : null;
};

export interface RecordEvidenceArgs {
  learnerId: string | Types.ObjectId;
  orgId?: string | Types.ObjectId | null;
  sessionId?: string | Types.ObjectId | null;
  beat: EvidenceBeat;
  data_point: string;
  value?: unknown;
  turnIndex?: number | null;
}

/**
 * Write (idempotently) one evidence record. Returns true on success.
 * An unmapped (beat, data_point) is still written — with empty
 * ilr_fields and human_confirm=false — so the chain captures the data
 * point and a later mapping update can backfill semantics; we log the
 * gap so it's visible.
 */
export const recordEvidence = async (
  args: RecordEvidenceArgs,
): Promise<boolean> => {
  const learnerId = toObjectId(args.learnerId);
  if (!learnerId) {
    logger.warn({ args }, "recordEvidence: invalid learnerId — skipped");
    return false;
  }

  const mapping = getEvidenceMapping(args.beat, args.data_point);
  if (!mapping) {
    logger.warn(
      { beat: args.beat, data_point: args.data_point },
      "recordEvidence: no evidence_mapping entry — writing with blank fields",
    );
  }

  const turnIndex = typeof args.turnIndex === "number" ? args.turnIndex : null;
  const sessionId = toObjectId(args.sessionId);

  try {
    await EvidenceRecord.updateOne(
      {
        sessionId,
        beat: args.beat,
        data_point: args.data_point,
        turnIndex,
      },
      {
        // Capture fields are set on insert only (immutable thereafter).
        $setOnInsert: {
          learnerId,
          orgId: toObjectId(args.orgId),
          ilr_fields: mapping?.ilr_fields ?? [],
          rarpa_stage: mapping?.rarpa_stage ?? "",
          human_confirm: mapping?.human_confirm ?? false,
          human_confirmed: false,
          human_confirmed_by: null,
          human_confirmed_at: null,
          value: args.value ?? null,
          mapping_version: getEvidenceMappingVersion(),
          captured_at: new Date(),
        },
      },
      { upsert: true },
    );
    return true;
  } catch (err) {
    logger.error(
      { err, beat: args.beat, data_point: args.data_point },
      "recordEvidence: write failed (turn unaffected)",
    );
    return false;
  }
};

export interface TurnEvidenceArgs {
  learnerId: string | Types.ObjectId;
  orgId?: string | Types.ObjectId | null;
  sessionId?: string | Types.ObjectId | null;
  turnIndex: number;
  turnScore?: number;
  skillCodesUsed?: string[];
  vocabularyItemsUsed?: string[];
  mode?: string;
  recastApplied?: boolean;
  // ── F32 speaking turns ─────────────────────────────────────────────
  /** "voice" only when audio went through /turn-voice. */
  inputMode?: "text" | "voice";
  /** Pronunciation assessment of the spoken turn (voice only). */
  pronunciation?: PronunciationAssessment | null;
  /** Phrase the tutor asked for, if any (pending speaking target). */
  targetPhrase?: string | null;
}

/**
 * Capture the beat_2_roleplay evidence for one AI turn — turn_score,
 * skill_codes, vocabulary_items_used, teaching mode/transition and
 * recast uptake. Each becomes one mapped EvidenceRecord. `turn_score`
 * carries human_confirm=true (self-scored by the model — supporting
 * evidence only, moderated at Stage 5); the rest are formative signals.
 *
 * F32: `input_mode` is written for every turn that declares one, and
 * `pronunciation_score` (human_confirm=true) only for spoken turns
 * that carry an assessment. No audio is ever written.
 */
export const recordTurnEvidence = async (
  args: TurnEvidenceArgs,
): Promise<void> => {
  const base = {
    learnerId: args.learnerId,
    orgId: args.orgId,
    sessionId: args.sessionId,
    beat: "beat_2_roleplay" as const,
    turnIndex: args.turnIndex,
  };

  const points: Array<{ data_point: string; value: unknown }> = [];
  if (typeof args.turnScore === "number")
    points.push({ data_point: "turn_score", value: args.turnScore });
  if (args.skillCodesUsed && args.skillCodesUsed.length)
    points.push({ data_point: "skill_codes", value: args.skillCodesUsed });
  if (args.vocabularyItemsUsed && args.vocabularyItemsUsed.length)
    points.push({
      data_point: "vocabulary_items_used",
      value: args.vocabularyItemsUsed,
    });
  if (args.mode)
    points.push({
      data_point: "teaching_mode_and_transitions",
      value: args.mode,
    });
  if (typeof args.recastApplied === "boolean")
    points.push({ data_point: "recast_uptake", value: args.recastApplied });
  // F32 — honest evidence: input_mode on every declared turn; the
  // pronunciation_score only when the turn was actually spoken.
  if (args.inputMode === "text" || args.inputMode === "voice")
    points.push({ data_point: "input_mode", value: args.inputMode });
  if (args.inputMode === "voice" && args.pronunciation) {
    const p = args.pronunciation;
    points.push({
      data_point: "pronunciation_score",
      value: {
        score: p.score,
        clarity: p.clarity,
        method: p.method,
        target_phrase: p.target_phrase ?? args.targetPhrase ?? null,
        unclear_words: p.unclear_words ?? [],
      },
    });
  }

  for (const p of points) {
    await recordEvidence({ ...base, data_point: p.data_point, value: p.value });
  }
};

export interface SessionCompleteEvidenceArgs {
  learnerId: string | Types.ObjectId;
  orgId?: string | Types.ObjectId | null;
  sessionId?: string | Types.ObjectId | null;
  sessionSummary?: string | null;
}

/**
 * Capture the beat_3_complete evidence when a session finishes —
 * the completion marker and the plain-language distance-travelled
 * summary that feeds Stage 5.
 */
export const recordSessionCompleteEvidence = async (
  args: SessionCompleteEvidenceArgs,
): Promise<void> => {
  const base = {
    learnerId: args.learnerId,
    orgId: args.orgId,
    sessionId: args.sessionId,
    beat: "beat_3_complete" as const,
    turnIndex: null,
  };
  await recordEvidence({
    ...base,
    data_point: "session_complete",
    value: true,
  });
  if (args.sessionSummary) {
    await recordEvidence({
      ...base,
      data_point: "session_summary",
      value: args.sessionSummary,
    });
  }
};
