import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listVocabService,
  updateMasteryService,
} from "../services/esolVocab.service";

export const listVocab: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listVocabService(req.query as any, {
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const updateMastery: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await updateMasteryService(params.vocabId, req.body as any, {
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
