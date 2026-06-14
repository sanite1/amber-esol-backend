import { ExpressFunction } from "../interfaces/helper.interface";
import {
  generateIlrCsvService,
  generateIntegrationReadinessPdf,
} from "../services/esolReport.service";

export const downloadIlrCsv: ExpressFunction = async (req, res, next) => {
  try {
    const query = req.query as any;
    const report = await generateIlrCsvService({
      orgId: query.orgId,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${report.filename}"`,
    );
    return res.status(200).send(report.csv);
  } catch (error) {
    next(error);
  }
};

export const downloadIntegrationReadinessReport: ExpressFunction = async (
  req,
  res,
  next,
) => {
  try {
    const query = req.query as any;
    const orgId =
      query.orgId ?? (req.user!.role === "org_admin" ? req.user!.orgId : null);
    if (!orgId) {
      return res.status(400).json({ message: "Organisation ID is required" });
    }
    const result = await generateIntegrationReadinessPdf({
      orgId,
      periodStart: query.periodStart,
      periodEnd: query.periodEnd,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${result.filename}"`,
    );
    return res.status(200).send(result.pdf);
  } catch (error) {
    next(error);
  }
};
