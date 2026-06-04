/**
 * Amber-admin evidence-report routes — brief Function 14.
 *
 * Mounted at /api/admin/evidence-report.
 *
 * Auth chain — Amber admin only (NOT org admin). No requireOrgContext;
 * the trigger body carries the target org_id.
 *   isAuthenticated  → JWT valid + account active
 *   isAdmin          → role is "admin" (Amber super-admin), org_admin excluded
 *
 * Endpoints:
 *   POST    /                          { org_id, period_start, period_end }
 *   GET     /:jobId/status             cross-org observable
 *   GET     /:reportId/download        cross-org downloadable
 *   DELETE  /cache/:org_id             Function 14 To-Do 5 — clear cache
 *
 * Path ordering note: the DELETE /cache/:org_id route sits under a
 * distinct verb so it doesn't collide with the GET /:reportId/download
 * pattern.
 */

import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import { triggerEvidenceReportAdminValidation } from "../validations/evidenceReport.validation";
import {
  triggerEvidenceReportAdmin,
  getEvidenceReportStatusAdmin,
  downloadEvidenceReportAdmin,
  clearEvidenceReportCacheAdmin,
} from "../controllers/evidenceReport.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

router.post("/", triggerEvidenceReportAdminValidation(), triggerEvidenceReportAdmin);
router.get("/:jobId/status", getEvidenceReportStatusAdmin);
router.get("/:reportId/download", downloadEvidenceReportAdmin);
router.delete("/cache/:org_id", clearEvidenceReportCacheAdmin);

export default router;
