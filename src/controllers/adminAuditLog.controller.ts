import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listAdminAuditLogService,
  AdminAuditLogQuery,
} from "../services/adminAuditLog.service";

export const listAdminAuditLog: ExpressFunction = async (req, res, next) => {
  try {
    const result = await listAdminAuditLogService(
      req.query as AdminAuditLogQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
