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

export const listVocabService = async (
  options: ListVocabOptions,
  caller: CallerContext
) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "50", 10);
  const skip = (page - 1) * limit;

  const query: any = {};

  // Authorisation
  if (caller.callerRole === "student") {
    query.learnerId = caller.callerId;
  } else if (caller.callerRole === "org_admin") {
    if (!caller.callerOrgId) {
      throw new ApiError(400, "Organisation context required");
    }
    query.orgId = caller.callerOrgId;
    if (options.learnerId) query.learnerId = options.learnerId;
  } else if (caller.callerRole === "admin") {
    if (options.learnerId) query.learnerId = options.learnerId;
  } else {
    throw new ApiError(403, "Access denied");
  }

  if (options.esolLevel) query.esolLevel = options.esolLevel;
  if (options.topic) query.topic = options.topic;
  if (options.search) {
    const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.word = new RegExp(escaped, "i");
  }

  // Deduplicate by word — keep the most recently introduced instance
  const [vocab, total] = await Promise.all([
    VocabLedger.aggregate([
      { $match: query },
      { $sort: { introducedAt: -1 } },
      {
        $group: {
          _id: "$word",
          doc: { $first: "$$ROOT" },
        },
      },
      { $replaceRoot: { newRoot: "$doc" } },
      { $sort: { introducedAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]),
    VocabLedger.aggregate([
      { $match: query },
      { $group: { _id: "$word" } },
      { $count: "total" },
    ]).then((res) => res[0]?.total ?? 0),
  ]);

  return new ApiResponse(200, "Vocabulary retrieved", {
    vocab,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Update mastery ── */

export const updateMasteryService = async (
  vocabId: string,
  data: { masteryScore: number },
  caller: CallerContext
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
