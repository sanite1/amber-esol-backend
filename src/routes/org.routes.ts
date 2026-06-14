import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import {
  createOrgValidation,
  listOrgsValidation,
  orgIdParamValidation,
  updateOrgValidation,
  createReferralLinkValidation,
  listReferralLinksValidation,
  deactivateReferralLinkValidation,
  createOrgAdminUserValidation,
} from "../validations/org.validation";
import {
  createOrg,
  listOrgs,
  getOrg,
  updateOrg,
  createOrgReferralLink,
  listOrgReferralLinks,
  deactivateOrgReferralLink,
  createOrgAdminUser,
} from "../controllers/org.controller";

/**
 * /api/orgs — brief Function 1 organisation CRUD.
 *
 * Platform-admin-only (Amber admin). Distinct from the legacy
 * /api/esol/organisations routes which carry the full provisioning
 * flow (creates org + org_admin user + initial referral token in one
 * call). The two route families currently coexist; consolidation is a
 * future cleanup decision for the user.
 */
const router = Router();

// Every route here is admin-only.
router.use(isAuthenticated, isAdmin);

router.post("/", createOrgValidation(), createOrg);
router.get("/", listOrgsValidation(), listOrgs);
router.get("/:id", orgIdParamValidation(), getOrg);
router.patch("/:id", updateOrgValidation(), updateOrg);

// Generate a fresh org-wide referral link (brief Function 1)
router.post(
  "/:id/referral-link",
  createReferralLinkValidation(),
  createOrgReferralLink,
);

// List all referral tokens for an organisation (active + inactive)
router.get(
  "/:id/referral-links",
  listReferralLinksValidation(),
  listOrgReferralLinks,
);

// Deactivate a referral token (sets isActive: false; row preserved for audit)
router.delete(
  "/:id/referral-links/:tokenId",
  deactivateReferralLinkValidation(),
  deactivateOrgReferralLink,
);

// Create an org_admin user for this organisation
router.post(
  "/:id/admin-user",
  createOrgAdminUserValidation(),
  createOrgAdminUser,
);

export default router;
