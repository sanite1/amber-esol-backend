import { Router } from "express";
import {
  isAuthenticated,
  isAdmin,
  isOrgAdmin,
} from "../middlewares/authMiddleWare";
import { ilrReportValidation } from "../validations/esolReport.validation";
import {
  downloadIlrCsv,
  downloadIntegrationReadinessReport,
} from "../controllers/esolReport.controller";

const router = Router();

router.use(isAuthenticated);

// ILR CSV — admin only
router.get("/ilr", isAdmin, ilrReportValidation(), downloadIlrCsv);

// Integration Readiness Report — admin or org_admin (own org)
router.get(
  "/integration-readiness",
  isOrgAdmin,
  downloadIntegrationReadinessReport
);

export default router;
