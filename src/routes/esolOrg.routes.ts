import { Router } from "express";
import {
  isAuthenticated,
  isAdmin,
  isOrgAdmin,
} from "../middlewares/authMiddleWare";
import { requireOrgMatch } from "../middlewares/orgScopingMiddleware";
import {
  provisionOrgValidation,
  updateOrgValidation,
  updateOrgStatusValidation,
  getOrgValidation,
  listOrgsValidation,
} from "../validations/esolOrg.validation";
import {
  provisionOrg,
  listOrgs,
  getOrg,
  updateOrg,
  updateOrgStatus,
} from "../controllers/esolOrg.controller";

const router = Router();

// All routes require authentication
router.use(isAuthenticated);

// Provision new org + org admin (platform admin only)
router.post("/", isAdmin, provisionOrgValidation(), provisionOrg);

// List all orgs (platform admin only)
router.get("/", isAdmin, listOrgsValidation(), listOrgs);

// Get single org (admin or matching org_admin)
router.get("/:orgId", isOrgAdmin, requireOrgMatch, getOrgValidation(), getOrg);

// Update org settings (platform admin only)
router.patch("/:orgId", isAdmin, updateOrgValidation(), updateOrg);

// Activate / deactivate org (platform admin only)
router.patch(
  "/:orgId/status",
  isAdmin,
  updateOrgStatusValidation(),
  updateOrgStatus,
);

export default router;
