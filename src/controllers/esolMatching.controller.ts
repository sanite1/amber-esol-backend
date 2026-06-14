import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import { getEsolTeacherMatchesService } from "../services/esolMatching.service";

/**
 * GET /api/esol/teacher-matches
 *
 * Returns up to 3 algorithmically matched ESOL teachers for the authenticated
 * learner. The learner ID is taken from the JWT, not from query params —
 * this endpoint is strictly "what are MY matches", never "what are someone
 * else's matches".
 */
export const getEsolTeacherMatches: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) {
      return next(new ApiError(401, "Unauthorized"));
    }
    const data = await getEsolTeacherMatchesService(learnerId);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
