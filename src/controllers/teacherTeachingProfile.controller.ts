import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getTeachingProfileService,
  updateTeachingProfileService,
  TeachingProfileBody,
} from "../services/teacherTeachingProfile.service";

export const getTeachingProfile: ExpressFunction = async (req, res, next) => {
  try {
    const result = await getTeachingProfileService(req.user!.id.toString());
    return res.status(result.statusCode).json(result);
  } catch (err) {
    next(err);
  }
};

export const updateTeachingProfile: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const result = await updateTeachingProfileService(
      req.user!.id.toString(),
      (req.body ?? {}) as TeachingProfileBody,
    );
    return res.status(result.statusCode).json(result);
  } catch (err) {
    next(err);
  }
};
