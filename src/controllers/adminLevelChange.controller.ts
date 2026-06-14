/**
 * Admin level-change controllers — brief Function 11 To-Do 2.
 *
 * Thin layer: pull body + caller id, hand off to the service, render
 * the ApiResponse. Role gating happens at the route layer (isAdmin).
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  confirmLevelChangeService,
  rejectLevelChangeService,
  ConfirmLevelChangeBody,
  RejectLevelChangeBody,
} from "../services/adminLevelChange.service";

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/level-change/confirm
// ─────────────────────────────────────────────────────────────────────

export const confirmLevelChange: ExpressFunction = async (req, res, next) => {
  try {
    const callerId = req.user!.id.toString();
    const result = await confirmLevelChangeService(
      req.body as ConfirmLevelChangeBody,
      callerId,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/admin/level-change/reject
// ─────────────────────────────────────────────────────────────────────

export const rejectLevelChange: ExpressFunction = async (req, res, next) => {
  try {
    const callerId = req.user!.id.toString();
    const result = await rejectLevelChangeService(
      req.body as RejectLevelChangeBody,
      callerId,
    );
    return res.status(result.statusCode).json({
      message: result.message,
      data: result.data,
    });
  } catch (err) {
    next(err);
  }
};
