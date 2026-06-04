/**
 * Amber-admin sales-intelligence routes — Final Addendum §13.
 *
 * Mounted at `/api/admin/sales-intelligence` in src/index.ts.
 *
 * Auth chain (every route):
 *   isAuthenticated → JWT valid + account active
 *   isAdmin         → role === "admin" (Amber super-admin only)
 *
 * The ROI submission feed is sales-team-only; org admins must
 * not see other orgs' leads, so this lives under /api/admin
 * (not /api/org-admin).
 */

import { Router } from "express";
import { isAdmin, isAuthenticated } from "../middlewares/authMiddleWare";
import {
  listRoiSubmissions,
  markRoiSubmissionContacted,
} from "../controllers/adminSalesIntelligence.controller";
import {
  listRoiSubmissionsValidation,
  markRoiSubmissionContactedValidation,
} from "../validations/adminSalesIntelligence.validation";

const router = Router();

router.use(isAuthenticated, isAdmin);

// GET /api/admin/sales-intelligence/roi-submissions
//   ?contacted=true|false&from=YYYY-MM-DD&to=YYYY-MM-DD&org_type=…&page&limit
router.get(
  "/roi-submissions",
  listRoiSubmissionsValidation(),
  listRoiSubmissions,
);

// PATCH /api/admin/sales-intelligence/roi-submissions/:id/contacted
// Idempotent — repeat calls return 200 with newly_marked: false.
router.patch(
  "/roi-submissions/:id/contacted",
  markRoiSubmissionContactedValidation(),
  markRoiSubmissionContacted,
);

export default router;
