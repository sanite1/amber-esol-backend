/**
 * Admin MIS sync controllers — Phase 4 / Final Addendum §7 (BE-D).
 *
 * Mounted on the existing `/api/admin/orgs/:id` router behind the
 * `isAuthenticated + isAdmin` chain. By the time we land here the
 * caller is an Amber super-admin; we pull `org_id` from the route
 * param and the actor from `req.user`.
 */

import { ExpressFunction } from "../interfaces/helper.interface";
import {
  listSyncLogsService,
  listMisConflictsService,
  triggerSyncNowService,
  resolveMisConflictService,
  type MisSyncQuery,
} from "../services/adminMisSync.service";

const readActorId = (req: unknown): string => {
  const u = (req as { user?: { id?: unknown; _id?: unknown } }).user;
  if (!u) return "";
  return String(u.id ?? u._id ?? "");
};

export const getMisSyncLogs: ExpressFunction = async (req, res, next) => {
  try {
    const { id: orgId } = req.params as { id: string };
    const result = await listSyncLogsService(
      orgId,
      req.query as unknown as MisSyncQuery,
    );
    return res
      .status(result.statusCode)
      .json({ message: result.message, data: result.data });
  } catch (err) {
    next(err);
  }
};

export const getMisConflicts: ExpressFunction = async (req, res, next) => {
  try {
    const { id: orgId } = req.params as { id: string };
    const result = await listMisConflictsService(
      orgId,
      req.query as unknown as MisSyncQuery,
    );
    return res
      .status(result.statusCode)
      .json({ message: result.message, data: result.data });
  } catch (err) {
    next(err);
  }
};

export const triggerMisSyncNow: ExpressFunction = async (req, res, next) => {
  try {
    const { id: orgId } = req.params as { id: string };
    const body = (req.body ?? {}) as { ulns?: string[] };
    const result = await triggerSyncNowService({
      org_id: orgId,
      actor_user_id: readActorId(req),
      ulns: Array.isArray(body.ulns) ? body.ulns : null,
    });
    return res
      .status(result.statusCode)
      .json({ message: result.message, data: result.data });
  } catch (err) {
    next(err);
  }
};

export const resolveMisConflict: ExpressFunction = async (req, res, next) => {
  try {
    const { id: orgId, conflictId } = req.params as {
      id: string;
      conflictId: string;
    };
    const body = (req.body ?? {}) as { note?: string };
    const result = await resolveMisConflictService({
      conflict_id: conflictId,
      org_id: orgId,
      actor_user_id: readActorId(req),
      note: body.note ?? null,
    });
    return res
      .status(result.statusCode)
      .json({ message: result.message, data: result.data });
  } catch (err) {
    next(err);
  }
};
