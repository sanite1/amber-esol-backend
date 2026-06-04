import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import { declareUlnService } from "../services/esolUln.service";

/**
 * POST /api/esol/uln — brief Function 2 To-Do 4.
 * Requires isAuthenticated; learner identity comes from req.user.id.
 */
export const declareUln: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) {
      return next(new ApiError(401, "Unauthorized"));
    }
    const body = req.body as { uln?: string; skip: boolean };
    const data = await declareUlnService(learnerId, {
      uln: body.uln,
      skip: body.skip,
    });
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
