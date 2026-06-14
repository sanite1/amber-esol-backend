import { ExpressFunction } from "../interfaces/helper.interface";
import {
  IProvisionOrgRequest,
  IUpdateOrganisationRequest,
} from "../interfaces/organisation.interface";
import {
  provisionOrgService,
  listOrgsService,
  getOrgService,
  updateOrgService,
  updateOrgStatusService,
} from "../services/esolOrganisation.service";

export const provisionOrg: ExpressFunction<IProvisionOrgRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const data = await provisionOrgService(req.body);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

export const listOrgs: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listOrgsService(req.query as any);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const getOrg: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await getOrgService(
      params.orgId,
      req.user!.id.toString(),
      req.user!.role,
      req.user!.orgId,
    );
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const updateOrg: ExpressFunction<IUpdateOrganisationRequest> = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await updateOrgService(params.orgId, req.body);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const updateOrgStatus: ExpressFunction<{ isActive: boolean }> = async (
  req,
  res,
  next,
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await updateOrgStatusService(params.orgId, req.body.isActive);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};
