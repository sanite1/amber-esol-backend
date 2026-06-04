/**
 * Admin failed-jobs controllers — Final Addendum §1.
 *
 *   GET    /api/admin/failed-jobs            listFailedJobs
 *   GET    /api/admin/failed-jobs/count      countFailedJobs
 *   POST   /api/admin/failed-jobs/:id/retry  retryFailedJob
 *   DELETE /api/admin/failed-jobs/:id        dismissFailedJob
 *
 * Thin adapters. Auth happens at the route layer.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listFailedJobsService,
  countFailedJobsService,
  retryFailedJobService,
  dismissFailedJobService,
  ListFailedJobsQuery,
} from "../services/adminFailedJobs.service";

export const listFailedJobs: ExpressFunction = async (req, res, next) => {
  try {
    const result = await listFailedJobsService(
      req.query as unknown as ListFailedJobsQuery,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const countFailedJobs: ExpressFunction = async (_req, res, next) => {
  try {
    const result = await countFailedJobsService();
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const retryFailedJob: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const callerId = req.user?.id?.toString() ?? "";
    const result = await retryFailedJobService(id, callerId, req);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const dismissFailedJob: ExpressFunction = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const callerId = req.user?.id?.toString() ?? "";
    const result = await dismissFailedJobService(id, callerId, req);
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
