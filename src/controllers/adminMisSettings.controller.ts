/**
 * Admin MIS settings controllers — Final Addendum §7.
 *
 *   PATCH /api/admin/orgs/:id/mis-settings        updateMisSettings
 *   POST  /api/admin/orgs/:id/mis-test-connection testMisConnection
 *
 * Thin adapters. Auth happens at the route layer (isAuthenticated +
 * isAdmin); the service does the validation and encryption.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getMisSettingsService,
  updateMisSettingsService,
  testMisConnectionService,
} from "../services/adminMisSettings.service";

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/orgs/:id/mis-settings
// ─────────────────────────────────────────────────────────────────────

export const getMisSettings: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const result = await getMisSettingsService(id);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// PATCH /api/admin/orgs/:id/mis-settings
// ─────────────────────────────────────────────────────────────────────

export const updateMisSettings: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      misType?: string;
      misApiEndpoint?: string | null;
      misApiCredentials?: string | null;
    };
    const callerId = req.user?.id?.toString() ?? "";
    const result = await updateMisSettingsService({
      org_id: id,
      caller_id: callerId,
      misType: body.misType,
      misApiEndpoint: body.misApiEndpoint,
      misApiCredentials: body.misApiCredentials,
      req,
    });
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/orgs/:id/mis-test-connection
// ─────────────────────────────────────────────────────────────────────

export const testMisConnection: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const callerId = req.user?.id?.toString() ?? "";
    const result = await testMisConnectionService(id, callerId, req);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
