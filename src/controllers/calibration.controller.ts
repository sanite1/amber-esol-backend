import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import {
  logCalibrationService,
  deleteCalibrationService,
  summariseCalibrationService,
} from "../services/calibration.service";

/**
 * Calibration admin endpoints — brief Function 6 To-Do 5.
 *
 * All routes are amber-admin-only (`isAuthenticated + isAdmin`). Org
 * admins cannot see calibration data; this is platform-level tooling
 * for the launch sign-off.
 */

export const logCalibration: ExpressFunction = async (req, res, next) => {
  try {
    const adminId = req.user?.id?.toString();
    if (!adminId) return next(new ApiError(401, "Unauthorized"));
    const data = await logCalibrationService(req.body as any, adminId);
    return res.status(201).json(data);
  } catch (err) {
    next(err);
  }
};

export const deleteCalibration: ExpressFunction = async (req, res, next) => {
  try {
    const id = (req.params as Record<string, string>).id;
    const data = await deleteCalibrationService(id);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

export const summariseCalibration: ExpressFunction = async (req, res, next) => {
  try {
    const query = req.query as Record<string, string | undefined>;
    const versionRaw = query.bank_version;
    const version =
      typeof versionRaw === "string" && versionRaw.trim() !== ""
        ? Number(versionRaw)
        : undefined;
    const data = await summariseCalibrationService(
      Number.isFinite(version) ? (version as number) : undefined,
    );
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};
