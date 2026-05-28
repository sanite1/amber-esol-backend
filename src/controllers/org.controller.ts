import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import {
  createOrgService,
  listOrgsService,
  getOrgService,
  updateOrgService,
  createOrgReferralLinkService,
  listOrgReferralLinksService,
  deactivateOrgReferralLinkService,
  createOrgAdminUserService,
} from "../services/org.service";

/* ── POST /api/orgs ──────────────────────────────────────────────── */

export const createOrg: ExpressFunction = async (req, res, next) => {
  try {
    const callerId = req.user?.id?.toString();
    if (!callerId) return next(new ApiError(401, "Unauthorized"));
    const data = await createOrgService(req.body as any, callerId);
    return res.status(201).json(data);
  } catch (err) {
    next(err);
  }
};

/* ── GET /api/orgs ───────────────────────────────────────────────── */

export const listOrgs: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listOrgsService(req.query as any);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/* ── GET /api/orgs/:id ───────────────────────────────────────────── */

export const getOrg: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await getOrgService(params.id);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/* ── PATCH /api/orgs/:id ─────────────────────────────────────────── */

export const updateOrg: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await updateOrgService(params.id, req.body as any);
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/* ── POST /api/orgs/:id/referral-link ────────────────────────────── */

export const createOrgReferralLink: ExpressFunction = async (req, res, next) => {
  try {
    const callerId = req.user?.id?.toString();
    if (!callerId) return next(new ApiError(401, "Unauthorized"));
    const params = req.params as Record<string, string>;
    const data = await createOrgReferralLinkService(
      params.id,
      (req.body || {}) as { expires_at?: string },
      callerId
    );
    return res.status(201).json(data);
  } catch (err) {
    next(err);
  }
};

/* ── GET /api/orgs/:id/referral-links ────────────────────────────── */

export const listOrgReferralLinks: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await listOrgReferralLinksService(
      params.id,
      req.query as { page?: string; limit?: string }
    );
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/* ── DELETE /api/orgs/:id/referral-links/:tokenId ────────────────── */

export const deactivateOrgReferralLink: ExpressFunction = async (
  req,
  res,
  next
) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await deactivateOrgReferralLinkService(
      params.id,
      params.tokenId
    );
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/* ── POST /api/orgs/:id/admin-user ───────────────────────────────── */

export const createOrgAdminUser: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await createOrgAdminUserService(params.id, req.body as any);
    return res.status(201).json(data);
  } catch (err) {
    next(err);
  }
};
