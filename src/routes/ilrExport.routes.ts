/**
 * ILR export routes — brief Function 13 To-Do 4.
 *
 * Mounted at /api/org-admin/export/ilr.
 *
 * Auth chain matches the rest of the org-admin family:
 *   isAuthenticated     → JWT valid + account active
 *   isOrgAdmin          → role is org_admin or admin
 *   requireOrgContext   → req.user.orgId is set, attached to
 *                         req.esol_context.org_id
 *
 * Endpoints:
 *   POST  /                       trigger an export (returns 202 + jobId)
 *   GET   /:jobId/status          BullMQ job status + progress
 *   GET   /:exportId/download     stream CSV (or ?format=json)
 */

import { Router } from "express";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import {
  triggerIlrExportValidation,
  downloadIlrExportValidation,
} from "../validations/ilrExport.validation";
import {
  triggerIlrExport,
  getIlrExportStatus,
  downloadIlrExport,
} from "../controllers/ilrExport.controller";

const router = Router();

router.use(isAuthenticated, isOrgAdmin, requireOrgContext);

router.post("/", triggerIlrExportValidation(), triggerIlrExport);
router.get("/:jobId/status", getIlrExportStatus);
router.get(
  "/:exportId/download",
  downloadIlrExportValidation(),
  downloadIlrExport,
);

export default router;
