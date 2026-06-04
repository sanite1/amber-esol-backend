/**
 * AuditLog write helper — brief Function 15 impersonation support.
 *
 * Why a helper at all
 *
 * AuditLog rows are written from 16+ call sites across the codebase
 * using the model directly: `AuditLog.create({ ... })`. That pattern
 * keeps the call site obvious but it has two problems:
 *
 *   1. There is no single place to enforce "this row must carry
 *      `impersonated_by` whenever an admin is impersonating a user".
 *      Function 15 mandates that EVERY audit row written under an
 *      impersonation session is tagged with the original admin's id.
 *   2. Best-effort failure handling (catch and log) is duplicated
 *      at every call site.
 *
 * The helper fixes both. New code should call `writeAuditLog(...)`;
 * existing call sites can migrate over time (the model API still
 * works, but won't pick up impersonation context).
 *
 * Impersonation contract
 *
 *   - When `options.req` (or `options.actor`) carries a JWT with
 *     `impersonated_by` set, that value is written to the new
 *     `impersonated_by` field on AuditLog.
 *   - `actor_id` continues to reflect the impersonated user — so
 *     org-scoped audit views read naturally ("this learner did X"
 *     remains true), and the impersonation breadcrumb is carried as
 *     a sibling field rather than displacing the actor.
 *   - If the caller passes `impersonated_by` explicitly in the input,
 *     that wins over the request-derived value.
 *
 * Failure handling
 *
 *   - Audit-log writes are append-only and operationally critical,
 *     but a single failed write must not tank the underlying business
 *     op (the op already succeeded by the time we reach the audit
 *     write). We log the error and return null so callers can decide
 *     whether to surface it.
 *   - Mongoose's schema-level enum on `action` catches typos at write
 *     time; the AuditAction TypeScript union catches them at compile
 *     time.
 */

import { Types } from "mongoose";
import { Request } from "express";
import AuditLog from "../models/AuditLog";
import { IAuditLog, AuditAction, AuditActorType } from "../interfaces/auditLog.interface";
import { IUserDecoded } from "../middlewares/authMiddleWare";
import logger from "../config/logger";

/**
 * Required + optional fields the caller hands us. `impersonated_by`
 * is allowed but usually omitted — the helper derives it from the
 * request.
 */
export interface WriteAuditLogInput {
  actor_type: AuditActorType;
  actor_id: Types.ObjectId | string | null;
  org_id: Types.ObjectId | string | null;
  learner_id: Types.ObjectId | string | null;
  action: AuditAction;
  reason: string;
  before_state?: unknown;
  after_state?: unknown;
  compliance_config_version?: number | null;
  /** Optional explicit override; usually derived from the request. */
  impersonated_by?: Types.ObjectId | string | null;
  /**
   * Final Addendum §11 — populate when a system action is
   * masquerading as a teacher (re-engagement cron). Pairs with
   * `actor_type: "system"`; the audit-log UI renders "system,
   * acting as Sarah Chen". Null/undefined on every other row.
   */
  acting_as_teacher_id?: Types.ObjectId | string | null;
  /** Optional explicit timestamp; defaults to "now". */
  timestamp?: Date;
}

export interface WriteAuditLogOptions {
  /** Express request — used to read `req.user.impersonated_by`. */
  req?: Request;
  /** Already-decoded JWT — alternative to passing `req`. */
  actor?: IUserDecoded | null;
}

/**
 * Convert a string ObjectId reference to an ObjectId, accepting null
 * passthrough. Mongoose would cast strings on its own, but the
 * normalisation here lets us keep the AuditLog doc shape consistent
 * regardless of how the caller passed the value.
 */
const toObjectIdOrNull = (
  v: Types.ObjectId | string | null | undefined,
): Types.ObjectId | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    if (!Types.ObjectId.isValid(v)) return null;
    return new Types.ObjectId(v);
  }
  return v;
};

/**
 * Read the impersonating-admin id from either the request or an
 * already-decoded JWT. Returns null when not impersonating.
 */
const resolveImpersonatedBy = (
  options: WriteAuditLogOptions,
): Types.ObjectId | null => {
  const decoded =
    options.actor ??
    ((options.req as Request & { user?: IUserDecoded } | undefined)?.user ??
      null);
  const claim = decoded?.impersonated_by ?? null;
  return toObjectIdOrNull(claim);
};

/**
 * Persist an audit row. Returns the saved document on success, or
 * null when the write failed (the failure is logged at error level
 * with the input so it can be reconstructed).
 */
export const writeAuditLog = async (
  input: WriteAuditLogInput,
  options: WriteAuditLogOptions = {},
): Promise<IAuditLog | null> => {
  // Caller-supplied `impersonated_by` overrides request-derived. Most
  // call sites will omit it and rely on the request lookup.
  const impersonatedBy =
    input.impersonated_by !== undefined
      ? toObjectIdOrNull(input.impersonated_by)
      : resolveImpersonatedBy(options);

  try {
    const doc = await AuditLog.create({
      timestamp: input.timestamp ?? new Date(),
      actor_type: input.actor_type,
      actor_id: toObjectIdOrNull(input.actor_id),
      org_id: toObjectIdOrNull(input.org_id),
      learner_id: toObjectIdOrNull(input.learner_id),
      action: input.action,
      before_state: input.before_state ?? null,
      after_state: input.after_state ?? null,
      reason: input.reason,
      compliance_config_version: input.compliance_config_version ?? null,
      acting_as_teacher_id: toObjectIdOrNull(input.acting_as_teacher_id ?? null),
      impersonated_by: impersonatedBy,
    });
    return doc;
  } catch (err) {
    logger.error(
      {
        err: (err as Error).message,
        action: input.action,
        actor_id: input.actor_id,
        org_id: input.org_id,
        learner_id: input.learner_id,
        impersonated_by: impersonatedBy,
      },
      "writeAuditLog: persist failed (underlying op already succeeded)",
    );
    return null;
  }
};

// Re-export for tests
export const __internals__ = { toObjectIdOrNull, resolveImpersonatedBy };
