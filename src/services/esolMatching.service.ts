import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import Availability from "../models/Availability";
import { getAvailableSlotsService } from "./availability.service";
import logger from "../config/logger";

/**
 * ESOL teacher matching — brief §2 Change 3.
 *
 * Replaces the marketplace browse-and-compare flow with algorithmic
 * matching: at most three teachers, pre-selected, with their next-7-days
 * slots pre-fetched. The learner never sees hourly rates, reviews, or
 * anything else that invites comparison.
 *
 * Match criteria (priority order, per brief):
 *   a. esolTeacherApproved === true
 *   b. teacher.languages contains the learner's l1_language (case-insensitive)
 *      — exact strength preferred (native > fluent > advanced)
 *   c. teacher.teachingPreferences.preferredLevels includes the learner's
 *      esol_level (mapped through CEFR — see ESOL_TO_MARKETPLACE_LEVEL below)
 *   d. Has at least one available slot in the next 7 days
 *   e. Sort: language match strength desc, then averageRating desc
 *
 * Return contract: maximum 3 results. Each result carries pre-fetched
 * slots so the frontend renders the picker without a second round trip.
 */

const MAX_MATCHES = 3;
const SLOT_LOOKAHEAD_DAYS = 7;
const DEFAULT_SLOT_DURATION_MIN = 60;

// ESOL NQF level → closest marketplace "preferredLevels" enum value.
// Used only for the soft-boost match in criterion (c).
const ESOL_TO_MARKETPLACE_LEVEL: Record<string, string> = {
  e1: "beginner",
  e2: "elementary",
  e3: "intermediate",
  l1: "upper-intermediate",
  l2: "advanced",
};

// Language match strength: higher number = stronger.
const FLUENCY_RANK: Record<string, number> = {
  native: 3,
  fluent: 2,
  advanced: 1,
  intermediate: 0,
  basic: 0,
};

export type LanguageMatchStrength = "native" | "fluent" | "partial" | "none";

const fluencyToStrength = (
  fluency?: string | null
): LanguageMatchStrength => {
  if (!fluency) return "none";
  if (fluency === "native") return "native";
  if (fluency === "fluent") return "fluent";
  if (fluency === "advanced") return "partial";
  return "none"; // intermediate / basic don't count for ESOL bridging
};

const STRENGTH_RANK: Record<LanguageMatchStrength, number> = {
  native: 3,
  fluent: 2,
  partial: 1,
  none: 0,
};

interface TeacherCandidate {
  doc: {
    _id: { toString(): string };
    firstname: string;
    lastname: string;
    profilePicture?: string;
    languages?: Array<{ name: string; fluency: string }>;
    teachingPreferences?: { preferredLevels?: string[] };
    averageRating?: number;
  };
  language_match_strength: LanguageMatchStrength;
  preferred_level_match: boolean;
  score: number;
}

export interface MatchSlot {
  date: string;       // YYYY-MM-DD
  startTime: string;  // HH:mm
  endTime: string;    // HH:mm
}

export interface MatchResult {
  teacher_id: string;
  firstname: string;
  lastname: string;
  profilePicture: string | null;
  language_match_strength: LanguageMatchStrength;
  available_slots: MatchSlot[];
  // Intentionally NOT included: hourlyRate, averageRating, numberOfReviews,
  // totalLessons, completionRate. The brief is explicit that ESOL learners
  // must not see comparison signals.
}

/**
 * Compute up to 3 ESOL teacher matches for a learner.
 *
 * Throws if the learner does not exist, is not a student, or has no
 * `l1Language` — the matching algorithm fundamentally needs the L1.
 */
export const getEsolTeacherMatchesService = async (
  learnerId: string
): Promise<ApiResponse> => {
  // 1. Resolve and validate the learner.
  const learner = await User.findById(learnerId).select(
    "role l1Language esolLevel orgId firstname lastname"
  );
  if (!learner || learner.role !== "student") {
    throw new ApiError(404, "Learner not found");
  }
  if (!learner.orgId) {
    throw new ApiError(
      400,
      "Learner is not assigned to an organisation — matching is only available to org-managed ESOL learners"
    );
  }
  if (!learner.l1Language) {
    throw new ApiError(
      400,
      "Learner's L1 language is not set — complete the onboarding wizard first"
    );
  }

  const l1Lower = learner.l1Language.toLowerCase();
  const mappedLevel = learner.esolLevel
    ? ESOL_TO_MARKETPLACE_LEVEL[learner.esolLevel.toLowerCase()] ?? null
    : null;

  // 2. Coarse filter: approved ESOL teachers, active, DBS cleared.
  //    Faster to over-fetch here and rank in JS than to push the
  //    language/level match into Mongo (the `languages` array is
  //    arbitrarily nested and case-insensitive matching is awkward there).
  const candidates = await User.find({
    role: "tutor",
    isActive: true,
    esolTeacherApproved: true,
    dbsCheckStatus: { $in: ["cleared", "clear"] },
  })
    .select(
      "firstname lastname profilePicture languages teachingPreferences averageRating"
    )
    .lean();

  if (candidates.length === 0) {
    return new ApiResponse(200, "No ESOL teachers currently approved", {
      matches: [],
    });
  }

  // 3. Score each candidate.
  const scored: TeacherCandidate[] = candidates.map((doc) => {
    // (b) Language match — find the strongest fluency for the learner's L1.
    let bestFluency = "";
    let bestRank = -1;
    for (const lang of doc.languages ?? []) {
      if (!lang?.name) continue;
      if (lang.name.toLowerCase() === l1Lower) {
        const r = FLUENCY_RANK[lang.fluency] ?? -1;
        if (r > bestRank) {
          bestRank = r;
          bestFluency = lang.fluency;
        }
      }
    }
    const language_match_strength = fluencyToStrength(bestFluency || null);

    // (c) Soft preferred-level match (boost, not exclude).
    //     preferredLevels has a narrowed marketplace-enum union upstream;
    //     widen via Array<string> for the contains check since our
    //     ESOL→marketplace mapping returns a plain string.
    const preferredLevels: string[] =
      (doc.teachingPreferences?.preferredLevels as string[] | undefined) ?? [];
    const preferred_level_match =
      mappedLevel !== null && preferredLevels.includes(mappedLevel);

    // Composite score: language match dominates, then preferred-level
    // boost (worth ~0.5 of a strength tier), then averageRating tiebreak.
    const score =
      STRENGTH_RANK[language_match_strength] * 10 +
      (preferred_level_match ? 5 : 0) +
      (doc.averageRating ?? 0);

    return {
      doc: doc as TeacherCandidate["doc"],
      language_match_strength,
      preferred_level_match,
      score,
    };
  });

  // 4. Cheap availability filter — does the teacher have ANY enabled
  //    weekly schedule day? Saves us computing slots for teachers who
  //    plainly have no availability configured. The slot pre-fetch in
  //    step 6 will catch teachers who have a schedule but no slots in
  //    the next 7 days.
  const availableIds = await Availability.find({
    tutorId: { $in: scored.map((c) => c.doc._id) },
    weeklySchedule: { $elemMatch: { enabled: true } },
  })
    .select("tutorId")
    .lean();
  const availableIdSet = new Set(availableIds.map((a) => a.tutorId.toString()));

  const withAvailability = scored.filter((c) =>
    availableIdSet.has(c.doc._id.toString())
  );

  // 5. Sort by composite score and take the top N (slightly more than
  //    MAX_MATCHES so we have fallbacks if some have zero slots in
  //    the next 7 days).
  withAvailability.sort((a, b) => b.score - a.score);
  const topCandidates = withAvailability.slice(0, MAX_MATCHES + 3);

  // 6. Pre-fetch slots for the next 7 days for each top candidate.
  //    Once we have MAX_MATCHES candidates with at least one slot,
  //    we stop fetching to keep the response time bounded.
  const matches: MatchResult[] = [];
  for (const candidate of topCandidates) {
    if (matches.length >= MAX_MATCHES) break;

    try {
      const slots = await collectSlotsForNextDays(
        candidate.doc._id.toString(),
        SLOT_LOOKAHEAD_DAYS
      );
      if (slots.length === 0) continue;

      matches.push({
        teacher_id: candidate.doc._id.toString(),
        firstname: candidate.doc.firstname,
        lastname: candidate.doc.lastname,
        profilePicture: candidate.doc.profilePicture ?? null,
        language_match_strength: candidate.language_match_strength,
        available_slots: slots,
      });
    } catch (err) {
      logger.warn(
        { err, tutorId: candidate.doc._id, learnerId },
        "Slot pre-fetch failed for ESOL match candidate — skipping"
      );
    }
  }

  return new ApiResponse(200, "ESOL teacher matches", { matches });
};

/**
 * Return all available slots for a tutor over the next `days` days.
 * Stops at a reasonable cap (15) so a fully-open week doesn't ship
 * 60+ slot rows per teacher to the client.
 */
const collectSlotsForNextDays = async (
  tutorId: string,
  days: number
): Promise<MatchSlot[]> => {
  const out: MatchSlot[] = [];
  const today = new Date();
  const MAX_SLOTS_PER_TEACHER = 15;

  for (let offset = 0; offset < days; offset++) {
    if (out.length >= MAX_SLOTS_PER_TEACHER) break;

    const d = new Date(today);
    d.setDate(today.getDate() + offset);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const resp = await getAvailableSlotsService(tutorId, {
      date: ymd,
      duration: String(DEFAULT_SLOT_DURATION_MIN),
    });

    // Service returns an ApiResponse — dig out the slots safely.
    const slots =
      (resp as ApiResponse & { data?: { slots?: Array<{ startTime: string; endTime: string }> } })
        .data?.slots ?? [];

    for (const s of slots) {
      if (out.length >= MAX_SLOTS_PER_TEACHER) break;
      out.push({ date: ymd, startTime: s.startTime, endTime: s.endTime });
    }
  }

  return out;
};
