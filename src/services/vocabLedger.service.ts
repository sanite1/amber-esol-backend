import { Types } from "mongoose";

import VocabLedger from "../models/VocabLedger";
import logger from "../config/logger";
import CurriculumLevelService from "./curriculumLevel.service";

/**
 * Vocabulary ledger writer + reinforcement-target reader — brief
 * Function 9 To-Do 1 + To-Do 2.
 *
 * Two surfaces:
 *
 *   updateLedgerForTurn — called by the `esol-session` worker AFTER a
 *     Gemini turn returns. One upsert per word in
 *     `vocabulary_items_used`. Atomic via an aggregation-pipeline
 *     update (no read-modify-write) so concurrent turns from the same
 *     learner don't lose increments.
 *
 *   getReinforcementTargets — called by the prompt assembler (Layer 5)
 *     before a turn. Surfaces up to N un-retained words ordered by
 *     "due-ness" (least-encountered first, then oldest-seen first) so
 *     Gemini can weave them back into the conversation.
 *
 * Retention rule (Function 9 To-Do 1, step 3):
 *   retained = (times_encountered ≥ 5) AND (turn_score ≥ 0.70 on the
 *   most-recent turn that featured the word). Sticky — once true, stays
 *   true regardless of subsequent low-score turns.
 */

// ─────────────────────────────────────────────────────────────────────
// Tunables
// ─────────────────────────────────────────────────────────────────────

/** Encounters required before retention becomes possible — the
 *  fallback when the learner's level isn't seeded in CurriculumLevel.
 *  The live value is the level's `retentionEncounters.min` (F27). */
const RETENTION_MIN_ENCOUNTERS = 5;
/** Minimum turn_score on the retention-trigger turn. */
const RETENTION_MIN_TURN_SCORE = 0.7;
/** Default cap for getReinforcementTargets. */
const REINFORCEMENT_DEFAULT_LIMIT = 6;

// ─────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────

export interface VocabReinforcementTarget {
  word: string;
  /** English definition if the introducing flow populated it; null
   *  until the vocab-introduction worker lands. */
  definition_en: string | null;
  times_encountered: number;
  last_seen_at: Date | null;
}

export interface UpdateLedgerForTurnArgs {
  learner_id: string | Types.ObjectId;
  vocabulary_items_used: string[];
  current_turn_score: number;
  scenario_id: string | null;
  stage3_objective_id: string | null;
  /** Insert-only enrichment — lets the learner vocabulary page show
   *  topic / level and lets org admins scope by orgId. Existing rows
   *  keep their values ($ifNull). */
  context?: VocabLedgerContext;
  /** Encounters required before `retained` can flip true. Resolved by
   *  the caller from the learner's level (F27); falls back to
   *  RETENTION_MIN_ENCOUNTERS when absent. */
  retention_min_encounters?: number;
}

export interface VocabLedgerContext {
  orgId?: string | Types.ObjectId | null;
  sessionId?: string | Types.ObjectId | null;
  esolLevel?: string | null;
  topic?: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// updateLedgerForTurn — brief Function 9 To-Do 1
// ─────────────────────────────────────────────────────────────────────

const toObjectId = (id: string | Types.ObjectId): Types.ObjectId =>
  id instanceof Types.ObjectId ? id : new Types.ObjectId(id);

/**
 * Single-word upsert using an aggregation-pipeline update. Pipeline
 * updates are the only way to compute a conditional `retained`
 * (depends on the POST-increment count) atomically — classic update
 * operators can't reference the new value of `$inc` in the same op.
 *
 * Expression semantics:
 *   - times_encountered : (existing ?? 0) + 1
 *   - last_seen_at      : now (always)
 *   - retained          : already-true  OR
 *                         (new count ≥ 5 AND this turn's score ≥ 0.7)
 *   - scenario_first_seen, stage3_objective_id : set on insert only
 *     via $ifNull (keeps the existing value on update)
 *
 * Filter is `{ learnerId, word }`; the unique index on this pair
 * guarantees one row per learner+word. Upsert auto-applies the filter
 * fields as initial values on insert.
 */
const upsertWord = async (
  word: string,
  args: UpdateLedgerForTurnArgs,
): Promise<void> => {
  const learnerObjectId = toObjectId(args.learner_id);
  const now = new Date();
  const ctx = args.context ?? {};
  const retentionMin =
    typeof args.retention_min_encounters === "number" &&
    args.retention_min_encounters > 0
      ? args.retention_min_encounters
      : RETENTION_MIN_ENCOUNTERS;

  await VocabLedger.updateOne(
    { learnerId: learnerObjectId, word },
    [
      {
        $set: {
          times_encountered: {
            $add: [{ $ifNull: ["$times_encountered", 0] }, 1],
          },
          last_seen_at: now,
          scenario_first_seen: {
            $ifNull: ["$scenario_first_seen", args.scenario_id],
          },
          stage3_objective_id: {
            $ifNull: ["$stage3_objective_id", args.stage3_objective_id],
          },
          // Insert-only context — keep existing values on update.
          orgId: {
            $ifNull: ["$orgId", ctx.orgId ? toObjectId(ctx.orgId) : null],
          },
          sessionId: {
            $ifNull: [
              "$sessionId",
              ctx.sessionId ? toObjectId(ctx.sessionId) : null,
            ],
          },
          esolLevel: { $ifNull: ["$esolLevel", ctx.esolLevel ?? null] },
          topic: { $ifNull: ["$topic", ctx.topic ?? null] },
          retained: {
            $let: {
              vars: {
                newCount: {
                  $add: [{ $ifNull: ["$times_encountered", 0] }, 1],
                },
              },
              in: {
                $or: [
                  // Sticky — once retained, stays retained.
                  { $eq: ["$retained", true] },
                  {
                    $and: [
                      { $gte: ["$$newCount", retentionMin] },
                      {
                        $gte: [
                          args.current_turn_score,
                          RETENTION_MIN_TURN_SCORE,
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
          // Initial-only fields — keep the existing value when present.
          introducedAt: { $ifNull: ["$introducedAt", now] },
        },
      },
    ],
    { upsert: true },
  );
};

/**
 * Process the vocabulary list from one Gemini turn. Each word becomes
 * one upsert. Words are de-duplicated within the list so the same word
 * appearing twice in a single turn counts as one encounter.
 *
 * Errors per-word are logged and swallowed so a single bad word
 * (e.g. an empty string) doesn't drop the rest of the list.
 */
export const updateLedgerForTurn = async (
  learner_id: string | Types.ObjectId,
  vocabulary_items_used: string[],
  current_turn_score: number,
  scenario_id: string | null,
  stage3_objective_id: string | null,
  context?: VocabLedgerContext,
): Promise<{ updated: number; skipped: number }> => {
  if (
    !Array.isArray(vocabulary_items_used) ||
    vocabulary_items_used.length === 0
  ) {
    return { updated: 0, skipped: 0 };
  }

  // De-dupe + trim within this turn so a word repeated twice in one
  // reply counts as one encounter.
  const words = Array.from(
    new Set(
      vocabulary_items_used
        .map((w) => (typeof w === "string" ? w.trim() : ""))
        .filter((w) => w.length > 0),
    ),
  );

  // Resolve the level's retention threshold ONCE for the turn (F27).
  // `context.esolLevel` carries the learner's level on the queue
  // payload; null/unseeded → the function falls back to the default.
  const retention_min_encounters =
    CurriculumLevelService.getRetentionMinEncounters(context?.esolLevel) ??
    undefined;

  let updated = 0;
  let skipped = 0;
  for (const word of words) {
    try {
      await upsertWord(word, {
        learner_id,
        vocabulary_items_used: [word],
        current_turn_score,
        scenario_id,
        stage3_objective_id,
        context,
        retention_min_encounters,
      });
      updated += 1;
    } catch (err) {
      skipped += 1;
      logger.error(
        {
          err,
          learnerId: String(learner_id),
          word,
          scenarioId: scenario_id,
        },
        "VocabLedger upsert failed for word — continuing with the rest of the turn",
      );
    }
  }

  logger.info(
    {
      learnerId: String(learner_id),
      scenarioId: scenario_id,
      turnScore: current_turn_score,
      updated,
      skipped,
    },
    "Vocab ledger updated for turn",
  );

  return { updated, skipped };
};

// ─────────────────────────────────────────────────────────────────────
// getReinforcementTargets — brief Function 9 To-Do 2
// ─────────────────────────────────────────────────────────────────────

/**
 * Up to N vocabulary items the learner is "most due" to revisit.
 *
 * Selection:
 *   - filter: learnerId matches, retained=false
 *   - sort: times_encountered ASC (rare words first — those most at
 *           risk of being forgotten), then last_seen_at ASC (oldest
 *           first — break ties toward items the learner hasn't seen
 *           recently)
 *   - limit: up to `limit` (default 6)
 *
 * The richer return (word + definition_en + counts) lets the prompt
 * assembler use the definition in Layer 5 if it's populated, or fall
 * back to just the word if it's null. The brief recommended this
 * shape over the bare-string alternative.
 *
 * Empty array is a valid outcome — a learner with no recorded vocab
 * (fresh placement, no sessions yet) reasonably gets nothing to
 * reinforce. Caller doesn't need a special case.
 */
export const getReinforcementTargets = async (
  learner_id: string | Types.ObjectId,
  limit: number = REINFORCEMENT_DEFAULT_LIMIT,
): Promise<VocabReinforcementTarget[]> => {
  const learnerObjectId = toObjectId(learner_id);
  const rows = await VocabLedger.find({
    learnerId: learnerObjectId,
    retained: false,
  })
    .sort({ times_encountered: 1, last_seen_at: 1 })
    .limit(Math.max(1, Math.min(limit, 50))) // hard ceiling at 50 — Layer 5 would balloon otherwise
    .select("word definition_en times_encountered last_seen_at")
    .lean();

  return rows.map((r) => ({
    word: r.word,
    definition_en:
      (r as { definition_en?: string | null }).definition_en ?? null,
    times_encountered:
      (r as { times_encountered?: number }).times_encountered ?? 0,
    last_seen_at: (r as { last_seen_at?: Date | null }).last_seen_at ?? null,
  }));
};
