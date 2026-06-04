/**
 * Org-admin evidence-report routes — brief Function 14 To-Do 4.
 *
 * Mounted at /api/org-admin/evidence-report.
 *
 * Auth chain matches the rest of the org-admin family:
 *   isAuthenticated    → JWT valid + account active
 *   isOrgAdmin         → role is org_admin or admin
 *   requireOrgContext  → req.user.orgId set, attached to req.esol_context.org_id
 *
 * Endpoints:
 *   POST  /                          trigger an evidence-report build
 *                                    (returns 200 + cached payload if a
 *                                    completed report exists, else 202 + jobId)
 *   GET   /:jobId/status             BullMQ job status + progress
 *   GET   /:reportId/download        stream the cached PDF
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { triggerEvidenceReportOrgAdminValidation } from "../validations/evidenceReport.validation";
import {
  triggerEvidenceReportOrgAdmin,
  getEvidenceReportStatusOrgAdmin,
  downloadEvidenceReportOrgAdmin,
} from "../controllers/evidenceReport.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin, requireOrgContext);

router.post("/", triggerEvidenceReportOrgAdminValidation(), triggerEvidenceReportOrgAdmin);
router.get("/:jobId/status", getEvidenceReportStatusOrgAdmin);
router.get("/:reportId/download", downloadEvidenceReportOrgAdmin);

export default router;
