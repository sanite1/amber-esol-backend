import { Router } from "express";
import {
  isAuthenticated,
  isAdmin,
  isOrgAdmin,
} from "../middlewares/authMiddleWare";
import {
  listAlertsValidation,
  alertIdParamValidation,
  reviewAlertValidation,
} from "../validations/esolSafeguarding.validation";
import {
  listAlerts,
  getAlert,
  reviewAlert,
} from "../controllers/esolSafeguarding.controller";

const router = Router();

router.use(isAuthenticated);

// List alerts (admin sees all, org_admin sees own org)
router.get("/", isOrgAdmin, listAlertsValidation(), listAlerts);

// Get single alert
router.get("/:alertId", isOrgAdmin, alertIdParamValidation(), getAlert);

// Review alert (admin only)
router.patch("/:alertId/review", isAdmin, reviewAlertValidation(), reviewAlert);

export default router;
