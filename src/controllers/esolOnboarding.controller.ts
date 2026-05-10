import { Request, Response, NextFunction } from "express";
import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getPlacementQuestionsService,
  completeOnboardingService,
} from "../services/esolOnboarding.service";

export const getPlacementQuestions: ExpressFunction = async (
  _req,
  res,
  next
) => {
  try {
    const data = getPlacementQuestionsService();
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

/**
 * Complete onboarding. Multipart/form-data:
 *   - file: optional residency document (jpg/png/pdf)
 *   - body: JSON-stringified payload as `data` field
 */
export const completeOnboarding = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const file = (req as any).file as Express.Multer.File | undefined;
    const raw = req.body?.data ?? JSON.stringify(req.body);
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    const data = await completeOnboardingService(payload, file?.buffer);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};
