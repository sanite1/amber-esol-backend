/**
 * Admin ComplianceConfig controllers — Final Addendum §3.
 *
 *   GET  /api/admin/compliance-config                        listAllConfigs
 *   GET  /api/admin/compliance-config/:domain/:academicYear/active
 *                                                            getActiveConfig
 *   POST /api/admin/compliance-config                        activateConfig
 *
 * Thin adapters — deserialise the request, call the service, return
 * the ApiResponse verbatim.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listAllConfigsService,
  getActiveConfigService,
  activateConfigService,
} from "../services/adminComplianceConfig.service";

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/compliance-config
// ─────────────────────────────────────────────────────────────────────

export const listAllConfigs: ExpressFunction = async (_req, res, next) => {
  try {
    const result = await listAllConfigsService();
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// GET /api/admin/compliance-config/:domain/:academicYear/active
// ─────────────────────────────────────────────────────────────────────

export const getActiveConfig: ExpressFunction = async (req, res, next) => {
  try {
    const { domain, academicYear } = req.params as {
      domain: string;
      academicYear: string;
    };
    const result = await getActiveConfigService(domain, academicYear);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/compliance-config
// ─────────────────────────────────────────────────────────────────────

export const activateConfig: ExpressFunction = async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      domain?: string;
      academic_year?: string;
      rules?: unknown;
      changelog?: string;
    };
    const callerId = req.user?.id?.toString() ?? "";
    const result = await activateConfigService({
      domain: body.domain ?? "",
      academic_year: body.academic_year ?? "",
      rules: body.rules,
      changelog: body.changelog ?? "",
      caller_id: callerId,
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
