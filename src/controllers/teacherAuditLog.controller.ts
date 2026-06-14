/**
 * Teacher-scoped audit log controller — Final Addendum §6 (BE-C).
 *
 * Auth chain (configured at the teacher router level): isAuthenticated
 * + requireTeacherRole + requireOrgContext. By the time we land here
 * `req.user._id` is the teacher and `req.params.id` is the requested
 * learner. The service does the assignment-gate (learner exists +
 * assigned to this teacher) and returns the audit rows.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listTeacherAuditLogService,
  TeacherAuditLogQuery,
} from "../services/teacherAuditLog.service";

export const listTeacherAuditLog: ExpressFunction = async (req, res, next) => {
  try {
    const teacherId = (req.user?.id ?? req.user?._id ?? "") as string;
    const { id: learnerId } = req.params as { id: string };

    const result = await listTeacherAuditLogService(
      teacherId,
      learnerId,
      req.query as unknown as TeacherAuditLogQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
