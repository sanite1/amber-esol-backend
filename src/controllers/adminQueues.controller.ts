/**
 * Admin queues controllers — Final Addendum §1.
 *
 *   GET /api/admin/queues/summary  getQueueSummary
 *   GET /api/admin/queues/link     getBullBoardLink
 *
 * Thin adapters — auth happens at the route layer.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  getQueueSummaryService,
  getBullBoardLinkService,
} from "../services/adminQueues.service";

export const getQueueSummary: ExpressFunction = async (_req, res, next) => {
  try {
    const result = await getQueueSummaryService();
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

export const getBullBoardLink: ExpressFunction = async (_req, res, next) => {
  try {
    const result = await getBullBoardLinkService();
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
