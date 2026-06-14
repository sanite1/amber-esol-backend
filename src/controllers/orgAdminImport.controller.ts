import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import { importLearnersService } from "../services/orgAdminImport.service";

/**
 * POST /api/org-admin/import/learners — brief Function 3 To-Do 2.
 *
 * Middleware chain (set on the route): isAuthenticated + isOrgAdmin +
 * requireOrgContext + multer.single("file") with a 10MB cap.
 *
 * org_id comes from requireOrgContext (req.esol_context.org_id), not
 * from req.body — Project Silk's hard rule: services never derive
 * org_id from req.user directly.
 */
export const importLearners: ExpressFunction = async (req, res, next) => {
  try {
    const actorId = req.user?.id?.toString();
    if (!actorId) {
      return next(new ApiError(401, "Unauthorized"));
    }

    const ctx = (
      req as typeof req & {
        esol_context?: { org_id: string };
      }
    ).esol_context;
    if (!ctx?.org_id) {
      return next(new ApiError(403, "Organisation context required"));
    }

    const data = await importLearnersService(req.file, ctx.org_id, actorId);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
