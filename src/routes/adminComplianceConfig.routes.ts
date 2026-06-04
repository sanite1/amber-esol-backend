/**
 * Admin ComplianceConfig routes — Final Addendum §3.
 *
 * Mounted at /api/admin/compliance-config.
 *
 * Auth: Amber admin only (NOT org admin). No requireOrgContext —
 * compliance config is platform-wide.
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin"
 *
 * Endpoints:
 *   GET   /                                 list all versions of all configs
 *                                           (every domain × every year ×
 *                                           every version). Sorted domain ↑,
 *                                           year ↓, version ↓ so the
 *                                           freshest is first per group.
 *   GET   /:domain/:academicYear/active     the currently active config
 *                                           for the given domain + year.
 *                                           Reads from the in-memory cache
 *                                           so the editor sees what the
 *                                           ILR / RARPA engine sees.
 *   POST  /                                 land a new version. Body
 *                                           { domain, academic_year, rules,
 *                                             changelog }. Deactivates the
 *                                           prior active version, creates
 *                                           the new one, reloads the
 *                                           in-memory cache atomically,
 *                                           writes an AuditLog row.
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  getActiveComplianceConfigValidation,
  activateComplianceConfigValidation,
} from "../validations/adminComplianceConfig.validation";
import {
  listAllConfigs,
  getActiveConfig,
  activateConfig,
} from "../controllers/adminComplianceConfig.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.get("/", listAllConfigs);
router.get(
  "/:domain/:academicYear/active",
  getActiveComplianceConfigValidation(),
  getActiveConfig,
);
router.post("/", activateComplianceConfigValidation(), activateConfig);

export default router;
