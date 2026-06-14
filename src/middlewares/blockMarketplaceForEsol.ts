import ApiError from "../errors/apiError";
import { ExpressFunction } from "../interfaces/helper.interface";
import { isEsolUser } from "../utils/userType";

/**
 * Blocks ESOL learners (and any org-scoped user) from marketplace-only routes
 * such as tutor browsing, public reviews, Stripe checkout, and saved payment
 * methods. Returns 403 with a clear message that points the user back to their
 * organisation dashboard.
 *
 * Must run AFTER `isAuthenticated` so `req.user` is populated. Pairs with
 * `requireEsolLearner` (the inverse gate) in orgScopingMiddleware.
 */
export const blockMarketplaceForEsol: ExpressFunction = async (
  req,
  _res,
  next,
) => {
  try {
    if (isEsolUser(req.user)) {
      return next(
        new ApiError(
          403,
          "This feature is not available to ESOL learners. Please use your organisation dashboard.",
        ),
      );
    }
    next();
  } catch (error) {
    next(error);
  }
};
