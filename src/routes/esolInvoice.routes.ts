import { Router } from "express";
import {
  isAuthenticated,
  isAdmin,
  isOrgAdmin,
} from "../middlewares/authMiddleWare";
import {
  generateInvoiceValidation,
  listInvoicesValidation,
  invoiceIdParamValidation,
  markPaidValidation,
} from "../validations/esolInvoice.validation";
import {
  generateInvoice,
  listInvoices,
  getInvoice,
  markInvoicePaid,
  downloadInvoicePdf,
} from "../controllers/esolInvoice.controller";

const router = Router();

router.use(isAuthenticated);

// Generate invoice manually (admin only)
router.post("/generate", isAdmin, generateInvoiceValidation(), generateInvoice);

// List invoices
router.get("/", isOrgAdmin, listInvoicesValidation(), listInvoices);

// Single invoice
router.get("/:invoiceId", isOrgAdmin, invoiceIdParamValidation(), getInvoice);

// Download PDF
router.get(
  "/:invoiceId/pdf",
  isOrgAdmin,
  invoiceIdParamValidation(),
  downloadInvoicePdf,
);

// Mark paid (admin only)
router.patch(
  "/:invoiceId/mark-paid",
  isAdmin,
  markPaidValidation(),
  markInvoicePaid,
);

export default router;
