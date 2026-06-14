import User from "../models/User";
import AISession from "../models/AISession";
import logger from "../config/logger";

const INACTIVE_DAYS_THRESHOLD = 14;

/**
 * Daily check for ESOL learners who have not had an AI session in N days.
 * Currently logs flagged learners; future iteration can dispatch nudge emails.
 *
 * Designed to be hit by GET /api/cron/check-progression.
 */
export const checkProgressionService = async () => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - INACTIVE_DAYS_THRESHOLD);

  // ESOL learners — students with an org_id assigned
  const learners = await User.find({
    role: "student",
    orgId: { $ne: null },
    isActive: true,
  }).select("_id firstname lastname email orgId esolLevel esolOnboardedAt");

  const flagged: {
    learnerId: string;
    name: string;
    email: string;
    orgId: string;
    daysSinceLastSession: number | null;
    onboardedAt: string | null;
  }[] = [];

  for (const learner of learners) {
    const latestSession = await AISession.findOne({
      learnerId: learner._id,
      completedAt: { $ne: null },
    })
      .sort({ completedAt: -1 })
      .select("completedAt");

    let daysSince: number | null = null;
    if (latestSession?.completedAt) {
      daysSince = Math.floor(
        (Date.now() - latestSession.completedAt.getTime()) /
          (1000 * 60 * 60 * 24),
      );
    } else if (learner.esolOnboardedAt) {
      daysSince = Math.floor(
        (Date.now() - learner.esolOnboardedAt.getTime()) /
          (1000 * 60 * 60 * 24),
      );
    }

    const inactive =
      latestSession === null
        ? // No session ever — flag if onboarded > threshold ago
          learner.esolOnboardedAt && learner.esolOnboardedAt < cutoff
        : latestSession.completedAt && latestSession.completedAt < cutoff;

    if (inactive) {
      flagged.push({
        learnerId: learner._id.toString(),
        name: `${learner.firstname} ${learner.lastname}`,
        email: learner.email,
        orgId: learner.orgId!.toString(),
        daysSinceLastSession: daysSince,
        onboardedAt: learner.esolOnboardedAt?.toISOString() ?? null,
      });
    }
  }

  logger.info(
    {
      learnersChecked: learners.length,
      flagged: flagged.length,
      threshold: INACTIVE_DAYS_THRESHOLD,
    },
    "Progression check completed",
  );

  return {
    learnersChecked: learners.length,
    flaggedCount: flagged.length,
    thresholdDays: INACTIVE_DAYS_THRESHOLD,
    flagged,
  };
};
