import { ExpressFunction } from "../interfaces/helper.interface";
import {
  createLevelChangeService,
  listLevelChangesService,
} from "../services/esolLevelChange.service";

export const createLevelChange: ExpressFunction = async (req, res, next) => {
  try {
    const data = await createLevelChangeService(req.body as any, {
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

export const listLevelChanges: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listLevelChangesService(req.query as any, {
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
