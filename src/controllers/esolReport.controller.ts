import { ExpressFunction } from "../interfaces/helper.interface";
import { generateIlrCsvService } from "../services/esolReport.service";

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
      `attachment; filename="${report.filename}"`
    );
    return res.status(200).send(report.csv);
  } catch (error) {
    next(error);
  }
};
