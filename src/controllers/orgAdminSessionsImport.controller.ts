import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import { importSessionsService } from "../services/orgAdminSessionsImport.service";

/**
 * POST /api/org-admin/import/sessions — brief Function 5.
 *
 * Mirrors the shape of importLearners / importForskills: pull actor id
 * from req.user, org_id from req.esol_context, hand the Multer-parsed
 * file to the service.
 */
export const importSessions: ExpressFunction = async (req, res, next) => {
  try {
    const actorId = req.user?.id?.toString();
    if (!actorId) return next(new ApiError(401, "Unauthorized"));

    const ctx = (
      req as typeof req & {
        esol_context?: { org_id: string };
      }
    ).esol_context;
    if (!ctx?.org_id)
      return next(new ApiError(403, "Organisation context required"));

    const data = await importSessionsService(req.file, ctx.org_id, actorId);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
