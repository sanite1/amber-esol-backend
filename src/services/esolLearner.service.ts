import { Types } from "mongoose";

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import VocabLedger from "../models/VocabLedger";
import AISession from "../models/AISession";

/* ── List Learners (scoped to org) ── */

export const listLearnersService = async (
  callerOrgId: string | null | undefined,
  callerRole: string,
  options: {
    orgId?: string;
    page?: string;
    limit?: string;
    search?: string;
    esolLevel?: string;
    fundingStatus?: string;
  }
) => {
  const page = parseInt(options.page || "1", 10);
  const limit = parseInt(options.limit || "20", 10);
  const skip = (page - 1) * limit;

  const resolvedOrgId =
    callerRole === "org_admin" ? callerOrgId : options.orgId;

  if (!resolvedOrgId) {
    throw new ApiError(400, "Organisation ID is required");
  }

  const query: any = {
    role: "student",
    orgId: resolvedOrgId,
  };

  if (options.search) {
    const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(escaped, "i");
    query.$or = [{ firstname: regex }, { lastname: regex }, { email: regex }];
  }
  if (options.esolLevel) {
    query.esolLevel = options.esolLevel;
  }
  if (options.fundingStatus) {
    query.fundingStatus = options.fundingStatus;
  }

  const [learners, total] = await Promise.all([
    User.find(query)
      .select(
        "firstname lastname email phoneNumber esolLevel l1Language uln ulnStatus fundingStatus esolOnboardedAt verified isActive status createdAt"
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(query),
  ]);

  return new ApiResponse(200, "Learners retrieved successfully", {
    learners,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

/* ── Get Learner ESOL Profile ── */

export const getLearnerService = async (
  orgId: string,
  learnerId: string,
  callerRole: string,
  callerOrgId?: string | null
) => {
  const learner = await User.findOne({
    _id: learnerId,
    role: "student",
    orgId,
  }).select(
    "-password -verificationToken -resetToken -resetTokenExpires -googleAccessToken -googleRefreshToken -tokenExpiryDate"
  );

  if (!learner) {
    throw new ApiError(404, "Learner not found in this organisation");
  }

  if (callerRole === "org_admin" && callerOrgId !== orgId) {
    throw new ApiError(403, "Access denied to this organisation's learners");
  }

  return new ApiResponse(200, "Learner retrieved successfully", learner.toJSON());
};

/* ── Update Learner ESOL Data ── */

export const updateLearnerService = async (
  orgId: string,
  learnerId: string,
  data: {
    esolLevel?: string;
    l1Language?: string;
    uln?: string;
    ulnStatus?: string;
    fundingStatus?: string;
  }
) => {
  const learner = await User.findOneAndUpdate(
    { _id: learnerId, role: "student", orgId },
    data,
    { new: true, runValidators: true }
  ).select(
    "-password -verificationToken -resetToken -resetTokenExpires -googleAccessToken -googleRefreshToken -tokenExpiryDate"
  );

  if (!learner) {
    throw new ApiError(404, "Learner not found in this organisation");
  }

  return new ApiResponse(200, "Learner updated successfully", learner.toJSON());
};

// ─────────────────────────────────────────────────────────────────────
// Shared ACL helper (org_admin must match learner's org; admin bypasses)
// ─────────────────────────────────────────────────────────────────────

/**
 * Common ownership check for learner-scoped endpoints. Returns the
 * loaded learner _id if access is granted; throws 403/404 otherwise.
 *
 * - `admin` (Amber platform admin): no org check, any learner OK
 * - `org_admin`: learner.orgId MUST match callerOrgId, else 403
 * - any other role: middleware already rejected, this is defence-in-depth
 *
 * The distinct 404 vs 403 matters:
 *   - 404 = no such learner at all
 *   - 403 = learner exists but caller can't see them
 * …so an org_admin probing for learner IDs gets the same shape whether
 * the id is wrong OR belongs to another org.
 */
export const assertLearnerAccess = async (
  learnerId: string,
  callerRole: string,
  callerOrgId: string | null | undefined
): Promise<{ learnerObjectId: Types.ObjectId; learnerOrgId: Types.ObjectId }> => {
  if (!Types.ObjectId.isValid(learnerId)) {
    throw new ApiError(400, "Invalid learner id");
  }
  const learner = await User.findOne({
    _id: learnerId,
    role: "student",
  }).select("_id orgId");
  if (!learner) {
    throw new ApiError(404, "Learner not found");
  }
  if (callerRole !== "admin") {
    if (
      callerRole !== "org_admin" ||
      learner.orgId?.toString() !== callerOrgId
    ) {
      // org_admin from a different org, OR any non-admin role that
      // slipped past the route guard.
      throw new ApiError(
        403,
        "Access denied — learner belongs to a different organisation"
      );
    }
  }
  return {
    learnerObjectId: learner._id as Types.ObjectId,
    learnerOrgId: learner.orgId as Types.ObjectId,
  };
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/esol/learners/:id/vocab-ledger
// ─────────────────────────────────────────────────────────────────────

/**
 * Full VocabLedger for one learner, grouped by retention state.
 *
 * Two arrays:
 *   - `retained`    — words the learner has demonstrably mastered
 *                     (times_encountered ≥ 5 AND a turn ≥ 0.7)
 *   - `in_progress` — everything else (introduced but not yet retained)
 *
 * Each row carries: word, definition_en (when populated), counts,
 * scenario_first_seen, stage3_objective_id, last_seen_at, introducedAt.
 * The dashboard's learner-detail view shows the in_progress list
 * inline; the retained list is collapsible. Both feed the evidence
 * report at session/cohort review time.
 *
 * Sorting inside each group:
 *   - retained:    by introducedAt ASC (oldest first — "how long has
 *                  this learner known X?")
 *   - in_progress: by last_seen_at ASC then times_encountered ASC
 *                  (oldest unseen first — matches the
 *                  getReinforcementTargets selection order)
 */
export const getLearnerVocabLedgerService = async (
  learnerId: string,
  callerRole: string,
  callerOrgId: string | null | undefined
) => {
  const { learnerObjectId } = await assertLearnerAccess(
    learnerId,
    callerRole,
    callerOrgId
  );

  const rows = await VocabLedger.find({ learnerId: learnerObjectId })
    .select(
      "word definition_en times_encountered retained scenario_first_seen stage3_objective_id last_seen_at introducedAt"
    )
    .lean();

  const retained = rows
    .filter((r) => (r as { retained?: boolean }).retained === true)
    .sort(
      (a, b) =>
        new Date((a as { introducedAt?: Date }).introducedAt ?? 0).getTime() -
        new Date((b as { introducedAt?: Date }).introducedAt ?? 0).getTime()
    );

  const inProgress = rows
    .filter((r) => (r as { retained?: boolean }).retained !== true)
    .sort((a, b) => {
      const ax = a as { last_seen_at?: Date | null; times_encountered?: number };
      const bx = b as { last_seen_at?: Date | null; times_encountered?: number };
      const at = ax.last_seen_at ? new Date(ax.last_seen_at).getTime() : 0;
      const bt = bx.last_seen_at ? new Date(bx.last_seen_at).getTime() : 0;
      if (at !== bt) return at - bt;
      return (ax.times_encountered ?? 0) - (bx.times_encountered ?? 0);
    });

  return new ApiResponse(200, "Vocab ledger retrieved", {
    retained,
    in_progress: inProgress,
    totals: {
      retained: retained.length,
      in_progress: inProgress.length,
      total: rows.length,
    },
  });
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/esol/learners/:id/sessions
// ─────────────────────────────────────────────────────────────────────

interface LearnerSessionsOptions {
  page?: number;
  limit?: number;
}

const SESSION_LIST_DEFAULT_LIMIT = 20;
const SESSION_LIST_MAX_LIMIT = 100;

/**
 * Paginated session list for one learner, most-recent first.
 *
 * Heavyweight fields (full `turns[]` transcript, `vocabIntroduced`,
 * `safeguardingAlertId`) are projected OUT — the dashboard listing
 * doesn't need them and they dominate the payload. A future
 * `/sessions/:id` endpoint can serve the full transcript when the
 * org admin drills into one session.
 */
export const getLearnerSessionsService = async (
  learnerId: string,
  callerRole: string,
  callerOrgId: string | null | undefined,
  options: LearnerSessionsOptions = {}
) => {
  const { learnerObjectId } = await assertLearnerAccess(
    learnerId,
    callerRole,
    callerOrgId
  );

  const page = Math.max(1, Math.floor(options.page ?? 1));
  const limit = Math.max(
    1,
    Math.min(SESSION_LIST_MAX_LIMIT, Math.floor(options.limit ?? SESSION_LIST_DEFAULT_LIMIT))
  );
  const skip = (page - 1) * limit;

  // Sort by createdAt DESC (recent first). For pre-platform imports
  // the createdAt was overwritten to session_date, so this stays
  // honest across both live and historical rows.
  const [sessions, total] = await Promise.all([
    AISession.find({ learnerId: learnerObjectId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select(
        // Summary fields for the dashboard listing.
        "scenario_id esolLevel nqf_level_at_start sessionMode " +
          "start_time end_time completedAt duration_mins " +
          "final_score passed esol_aim_type " +
          "skill_codes_covered stage3_objective_ids " +
          "turn_scores teaching_mode_sequence " +
          "session_source safeguardingFlagged createdAt updatedAt"
      )
      .lean(),
    AISession.countDocuments({ learnerId: learnerObjectId }),
  ]);

  return new ApiResponse(200, "Sessions retrieved", {
    sessions,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
};
