import { Router } from "express";
import { isAuthenticated, isAdmin } from "../middlewares/authMiddleWare";
import { ilrReportValidation } from "../validations/esolReport.validation";
import { downloadIlrCsv } from "../controllers/esolReport.controller";

const router = Router();

router.use(isAuthenticated, isAdmin);

// Download ILR CSV (admin only)
router.get("/ilr", ilrReportValidation(), downloadIlrCsv);

export default router;
