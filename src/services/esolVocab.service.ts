import { Types } from "mongoose";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import VocabLedger from "../models/VocabLedger";

interface CallerContext {
  callerId: string;
  callerRole: string;
  callerOrgId?: string | null;
}

interface ListVocabOptions {
  page?: string;
  limit?: string;
  learnerId?: string;
  esolLevel?: string;
  topic?: string;
  search?: string;
}

/* ── List vocab ── */

// IMPORTANT: this service queries via .aggregate(), and aggregation
// pipelines BYPASS Mongoose schema casting — a string learnerId in
// $match silently matches nothing against the ObjectId field. Every
// id that reaches a $match below must be cast explicitly. (This was
// the bug that made the learner vocabulary page permanently empty.)
const oid = (id: string): Types.ObjectId | string =>
  Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : id;

export const listVocabService = async (
  options: ListVocabOptions,
  caller: CallerContext,
) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "50", 10);
  const skip = (page - 1) * limit;

  // Authorisation scope — id filters only. Kept separate from the
  // user-chosen filters so the stat counts below reflect the
  // learner's WHOLE ledger, not the current search/filter view.
  const baseQuery: Record<string, unknown> = {};

  if (caller.callerRole === "student") {
    baseQuery.learnerId = oid(caller.callerId);
  } else if (caller.callerRole === "org_admin") {
    if (!caller.callerOrgId) {
      throw new ApiError(400, "Organisation context required");
    }
    baseQuery.orgId = oid(caller.callerOrgId);
    if (options.learnerId) baseQuery.learnerId = oid(options.learnerId);
  } else if (caller.callerRole === "admin") {
    if (options.learnerId) baseQuery.learnerId = oid(options.learnerId);
  } else {
    throw new ApiError(403, "Access denied");
  }

  const query: Record<string, unknown> = { ...baseQuery };
  if (options.esolLevel) {
    // Ledger rows store the code form ("e1"…"l2"); the frontend filter
    // sends the display form ("Entry 1"…"Level 2"). Accept both.
    const m = options.esolLevel
      .trim()
      .toLowerCase()
      .match(/^(entry|level)\s*(\d)$/);
    query.esolLevel = m
      ? `${m[1] === "entry" ? "e" : "l"}${m[2]}`
      : options.esolLevel.trim().toLowerCase();
  }
  if (options.topic) query.topic = options.topic;
  if (options.search) {
    const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.word = new RegExp(escaped, "i");
  }

  // Deduplicate by word — keep the most recently introduced instance
  const dedupeByWord = [
    { $sort: { introducedAt: -1 as const } },
    { $group: { _id: "$word", doc: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$doc" } },
  ];

  const [vocab, total, statsRow] = await Promise.all([
    VocabLedger.aggregate([
      { $match: query },
      ...dedupeByWord,
      { $sort: { introducedAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]),
    VocabLedger.aggregate([
      { $match: query },
      { $group: { _id: "$word" } },
      { $count: "total" },
    ]).then((res) => res[0]?.total ?? 0),
    // Learner-wide stats (auth scope only — ignores search/filters) so
    // the page's stat cards stay stable while the list is filtered.
    VocabLedger.aggregate([
      { $match: baseQuery },
      ...dedupeByWord,
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          mastered: {
            $sum: {
              $cond: [
                {
                  $or: [
                    { $gte: [{ $ifNull: ["$masteryScore", 0] }, 0.7] },
                    { $eq: ["$retained", true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          retained: {
            $sum: { $cond: [{ $eq: ["$retained", true] }, 1, 0] },
          },
        },
      },
    ]).then((res) => res[0] ?? { total: 0, mastered: 0, retained: 0 }),
  ]);

  return new ApiResponse(200, "Vocabulary retrieved", {
    vocab,
    stats: {
      total: statsRow.total,
      mastered: statsRow.mastered,
      retained: statsRow.retained,
      needs_practice: Math.max(0, statsRow.total - statsRow.mastered),
    },
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Update mastery ── */

export const updateMasteryService = async (
  vocabId: string,
  data: { masteryScore: number },
  caller: CallerContext,
) => {
  const item = await VocabLedger.findById(vocabId);
  if (!item) {
    throw new ApiError(404, "Vocabulary item not found");
  }

  if (
    caller.callerRole === "student" &&
    item.learnerId.toString() !== caller.callerId
  ) {
    throw new ApiError(403, "You can only update your own vocabulary");
  }

  item.masteryScore = data.masteryScore;
  item.revisedAt = new Date();
  await item.save();

  return new ApiResponse(200, "Mastery updated", item.toJSON());
};
