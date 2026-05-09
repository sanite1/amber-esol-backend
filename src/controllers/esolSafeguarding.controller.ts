import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listAlertsService,
  getAlertService,
  reviewAlertService,
} from "../services/esolSafeguarding.service";

export const listAlerts: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listAlertsService(req.query as any, {
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const getAlert: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await getAlertService(params.alertId, {
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const reviewAlert: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await reviewAlertService(params.alertId, req.body as any, {
      callerId: req.user!.id.toString(),
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
