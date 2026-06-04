import { Router } from "express";
import multer from "multer";
import { isAuthenticated, isOrgAdmin } from "../middlewares/authMiddleWare";
import { requireOrgContext } from "../middlewares/orgScopingMiddleware";
import { importLearners } from "../controllers/orgAdminImport.controller";
import { importForskills } from "../controllers/orgAdminForskillsImport.controller";
import { importSessions } from "../controllers/orgAdminSessionsImport.controller";

/**
 * POST /api/org-admin/import/learners — brief Function 3 To-Do 2.
 *
 * Bulk learner CSV upload.
 *
 * Middleware chain:
 *   1. isAuthenticated  — populate req.user from JWT
 *   2. isOrgAdmin       — role must be "org_admin" or "admin"
 *   3. requireOrgContext — derive req.esol_context.org_id from req.user
 *   4. multer (route-local)
 *        - memoryStorage (the file is small enough to parse in-process)
 *        - 10 MB cap per the brief
 *        - CSV mimetype check (defence-in-depth; csv-parse will also fail
 *          on non-CSV but the early reject is friendlier)
 *   5. importLearners controller
 *
 * Why a route-local multer instead of the shared src/config/upload.ts:
 * the shared instance has no size limit (other routes don't need one).
 * A 10 MB cap applied globally would block legitimate profile-picture
 * uploads >10 MB and other heavier flows.
 */

const ACCEPTED_MIME = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel", // Excel saves CSV with this MIME on some platforms
  "text/plain", // browsers occasionally label .csv as text/plain
]);

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith(".csv")) {
      cb(new Error("File must have a .csv extension"));
      return;
    }
    if (!ACCEPTED_MIME.has(file.mimetype)) {
      cb(
        new Error(
          `Unexpected MIME type ${file.mimetype} — expected text/csv`
        )
      );
      return;
    }
    cb(null, true);
  },
});

const router = Router();

router.post(
  "/learners",
  isAuthenticated,
  isOrgAdmin,
  requireOrgContext,
  csvUpload.single("file"),
  importLearners
);

/**
 * POST /api/org-admin/import/forskills — brief Function 4 Phase A.
 *
 * Same middleware chain, same multer instance, same 10 MB cap. The
 * forskills CSV is structurally different (assessment scores instead
 * of learner enrolment) so it gets its own controller + service, but
 * we don't need a second multer config.
 */
router.post(
  "/forskills",
  isAuthenticated,
  isOrgAdmin,
  requireOrgContext,
  csvUpload.single("file"),
  importForskills
);

/**
 * POST /api/org-admin/import/sessions — brief Function 5.
 *
 * Historical pre-platform session CSV upload. Same middleware chain
 * as the other two import routes; the controller hands off to
 * importSessionsService which sets `session_source: "pre_platform"`
 * on every created AISession regardless of the row's value.
 */
router.post(
  "/sessions",
  isAuthenticated,
  isOrgAdmin,
  requireOrgContext,
  csvUpload.single("file"),
  importSessions
);

export default router;
