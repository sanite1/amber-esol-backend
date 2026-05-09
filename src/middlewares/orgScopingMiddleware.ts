import ApiError from "../errors/apiError";
import { ExpressFunction } from "../interfaces/helper.interface";

/**
 * Ensures the JWT carries an orgId — blocks B2C users from ESOL routes.
 * Applied to every learner-facing ESOL route.
 */
export const requireOrgContext: ExpressFunction = async (req, _res, next) => {
  try {
    if (!req.user?.orgId) {
      return next(new ApiError(403, "Organisation context required for this resource"));
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * For org_admin routes: verifies the orgId in the route param matches
 * the admin's own orgId (platform admins bypass this check).
 */
export const requireOrgMatch: ExpressFunction = async (req, _res, next) => {
  try {
    if (req.user?.role === "admin") {
      return next();
    }
    const paramOrgId = (req.params as Record<string, string>).orgId;
    if (!paramOrgId) {
      return next(new ApiError(400, "Organisation ID is required"));
    }
    if (req.user?.orgId !== paramOrgId) {
      return next(new ApiError(403, "Access denied to this organisation's resources"));
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Restricts access to org-managed learners only.
 * Role must be "student" AND orgId must be present in the JWT.
 */
export const requireEsolLearner: ExpressFunction = async (req, _res, next) => {
  try {
    if (req.user?.role !== "student" || !req.user?.orgId) {
      return next(new ApiError(403, "ESOL learner access required"));
    }
    next();
  } catch (error) {
    next(error);
  }
};
