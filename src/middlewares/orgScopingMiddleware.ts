import ApiError from "../errors/apiError";
import { ExpressFunction, IEsolContext } from "../interfaces/helper.interface";

/**
 * Org-scoping middleware for ESOL routes.
 *
 * Project Silk's hard rule: every request that touches learner or session
 * data must carry an explicit organisation context. Services NEVER derive
 * `org_id` from `req.user` directly — they receive it as a parameter
 * sourced from `req.esol_context.org_id` set here.
 *
 * Why this indirection: it makes cross-org leakage impossible to ship
 * accidentally. A service signature like `listLearners(orgId, query)`
 * forces the caller to wire the org context through, surfaced at code
 * review. A service that secretly reads `req.user.orgId` hides the
 * authorisation decision deep inside business logic.
 *
 * Naming bridge: the User document stores `orgId` (camelCase) from
 * earlier work. The Project Silk brief specifies `org_id` (snake_case) on
 * the request context. This middleware translates between the two.
 */

/**
 * Mandatory on every ESOL route.
 *
 * Reads `orgId` from the JWT-rehydrated user. If absent, returns 403 —
 * the request came from a marketplace user or an admin who shouldn't be
 * acting on org-scoped data without an explicit org parameter.
 *
 * On success, attaches `{ org_id }` to `req.esol_context` for downstream
 * controllers and services.
 */
export const requireOrgContext: ExpressFunction = async (req, _res, next) => {
  try {
    const orgId = req.user?.orgId;
    if (!orgId) {
      return next(
        new ApiError(403, "Organisation context required for this resource")
      );
    }

    const context: IEsolContext = { org_id: String(orgId) };
    (req as typeof req & { esol_context: IEsolContext }).esol_context = context;
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Restrict a route to organisation admins and platform admins.
 *
 * Functionally identical to `isOrgAdmin` in authMiddleWare.ts. Defined
 * separately here so ESOL route files can express their intent as
 * `orgScopingMiddleware.requireOrgAdmin` rather than reaching into the
 * general auth layer — it makes the org-scoping nature of the guard
 * obvious at the call site.
 */
export const requireOrgAdmin: ExpressFunction = async (req, _res, next) => {
  try {
    const role = req.user?.role;
    if (role !== "org_admin" && role !== "admin") {
      return next(new ApiError(403, "Organisation admin access required"));
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * For routes that take an `orgId` URL parameter (e.g. /api/orgs/:orgId/...):
 * verify the parameter matches the requesting user's own org. Platform
 * admins (`role === "admin"`) bypass this check.
 *
 * Preserved from the previous version of this file — used by org-admin
 * routes that drill into a specific org by ID.
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
      return next(
        new ApiError(403, "Access denied to this organisation's resources")
      );
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Restricts access to org-managed learners only.
 * Role must be "student" AND orgId must be present in the JWT.
 *
 * Preserved from the previous version of this file — used by learner-
 * facing ESOL routes (session turn submission, vocab fetch, feedback).
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
