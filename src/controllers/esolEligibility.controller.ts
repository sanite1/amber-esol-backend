import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import { declareEligibilityService } from "../services/esolEligibility.service";

/**
 * POST /api/esol/declare-eligibility — brief Function 2 To-Do 3.
 * Requires isAuthenticated; learner identity comes from req.user.id.
 */
export const declareEligibility: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) {
      return next(new ApiError(401, "Unauthorized"));
    }
    const data = await declareEligibilityService(learnerId);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
