import { ExpressFunction } from "../interfaces/helper.interface";
import {
  generateInvoiceService,
  listInvoicesService,
  getInvoiceService,
  markInvoicePaidService,
  loadInvoiceForPdf,
} from "../services/esolInvoice.service";
import { generatePdfFromHtml } from "../services/pdfGenerator.service";
import { buildInvoiceHtml } from "../services/templates/invoiceTemplate";

export const generateInvoice: ExpressFunction = async (req, res, next) => {
  try {
    const data = await generateInvoiceService(req.body as any);
    return res.status(201).json(data);
  } catch (error) {
    next(error);
  }
};

export const listInvoices: ExpressFunction = async (req, res, next) => {
  try {
    const data = await listInvoicesService(req.query as any, {
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const getInvoice: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await getInvoiceService(params.invoiceId, {
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const markInvoicePaid: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const data = await markInvoicePaidService(params.invoiceId, req.body as any);
    return res.status(200).json(data);
  } catch (error) {
    next(error);
  }
};

export const downloadInvoicePdf: ExpressFunction = async (req, res, next) => {
  try {
    const params = req.params as Record<string, string>;
    const invoice = await loadInvoiceForPdf(params.invoiceId, {
      callerRole: req.user!.role,
      callerOrgId: req.user!.orgId,
    });

    const html = buildInvoiceHtml({ invoice: invoice as any });
    const pdfBuffer = await generatePdfFromHtml(html);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${invoice.invoiceNumber}.pdf"`
    );
    res.setHeader("Content-Length", String(pdfBuffer.length));
    return res.status(200).send(pdfBuffer);
  } catch (error) {
    next(error);
  }
};
