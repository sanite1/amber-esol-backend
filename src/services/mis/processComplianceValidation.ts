/**
 * Compliance-validation worker — Phase 1.C, Final Addendum §7.
 *
 * Standalone "green-light" surface. Other pipelines can enqueue
 * validation jobs without going through the `mis-push` worker —
 * e.g. a pre-flight validation a user kicks off from the
 * org-admin dashboard, or a nightly cron that sanity-checks the
 * cohort before the funding-claim window.
 *
 * **The mis-push worker does NOT depend on this queue.** Push
 * validation happens inline inside `processMisPush` (defence-in-
 * depth — a direct push from any future surface still validates).
 * This worker is a separate entry point that returns a structured
 * report; it does NOT itself push.
 *
 * Job shape (from `queues/index.ts`)
 * ==================================
 *
 *   target: "ilr" | "rarpa" | "mis"
 *   orgId:  string
 *   exportId?: string   // for ilr / rarpa — references an
 *                       //   existing artefact's idempotency row
 *   uln?:     string    // for mis — single ULN
 *   ulns?:    string[]  // for mis — batch
 *
 * Today we implement the `mis` branch. The `ilr` / `rarpa`
 * branches stub out — those artefacts already validate inline
 * inside their respective generators (Function 13 / Function 14);
 * the standalone surface for them lands when a use case arrives.
 */

import { Job } from "bullmq";
import { Types } from "mongoose";
import logger from "../../config/logger";
import { writeAuditLog } from "../auditLog.service";
import { buildMisRecord } from "./buildMisRecord";
import { validateMisRecord, ValidationResult } from "./validateMisRecord";
import type { ComplianceValidationJob } from "../../queues";

// ─────────────────────────────────────────────────────────────────────
// Public result shape
// ─────────────────────────────────────────────────────────────────────

export interface ComplianceValidationResult {
  target: "ilr" | "rarpa" | "mis";
  org_id: string;
  /** Number of records inspected. */
  inspected: number;
  /** Records that passed validation. */
  passed: number;
  /** Records that failed validation. */
  failed: number;
  /** Per-record detail (only the failed rows; passed rows omitted to keep the envelope small). */
  failures: Array<{
    uln: string;
    reasons: string[];
    compliance_config_version: number | null;
  }>;
  /** Build-time errors (couldn't even assemble the record). */
  build_errors: Array<{ uln: string; error: string }>;
}

// ─────────────────────────────────────────────────────────────────────
// MIS branch
// ─────────────────────────────────────────────────────────────────────

const validateOneMisUln = async (
  org_id: string,
  uln: string,
): Promise<
  | { kind: "ok"; uln: string; validation: ValidationResult }
  | { kind: "build_error"; uln: string; error: string }
> => {
  try {
    const record = await buildMisRecord(org_id, uln);
    const validation = validateMisRecord(record);
    return { kind: "ok", uln, validation };
  } catch (err) {
    return { kind: "build_error", uln, error: (err as Error).message };
  }
};

const processMisValidation = async (
  org_id: string,
  ulns: string[],
): Promise<ComplianceValidationResult> => {
  const checked = await Promise.all(
    ulns.map((uln) => validateOneMisUln(org_id, uln)),
  );

  const failures: ComplianceValidationResult["failures"] = [];
  const build_errors: ComplianceValidationResult["build_errors"] = [];
  let passed = 0;

  for (const c of checked) {
    if (c.kind === "build_error") {
      build_errors.push({ uln: c.uln, error: c.error });
      continue;
    }
    if (c.validation.valid) {
      passed += 1;
    } else {
      failures.push({
        uln: c.uln,
        reasons: c.validation.reasons,
        compliance_config_version: c.validation.compliance_config_version,
      });
    }
  }

  // Single audit row capturing the green-light pass for the whole
  // batch. We do NOT write per-record `mis_push_held` rows here —
  // this worker is the standalone pre-check, not the push. The
  // push worker writes its own per-record audit when the push
  // actually attempts.
  await writeAuditLog({
    actor_type: "system",
    actor_id: null,
    org_id,
    learner_id: null,
    action: "green_light_passed",
    before_state: null,
    after_state: {
      target: "mis",
      inspected: ulns.length,
      passed,
      failed: failures.length,
      build_errors: build_errors.length,
    },
    reason:
      build_errors.length === 0 && failures.length === 0
        ? `Compliance validation: ${ulns.length} MIS record(s) passed.`
        : `Compliance validation: ${passed} of ${ulns.length} MIS record(s) passed (${failures.length} held, ${build_errors.length} build errors).`,
    // The validator surfaces config_version per record; the audit
    // row carries the version of the first failure for the
    // operator-readable reason. Multiple academic years in one
    // call would be unusual but possible.
    compliance_config_version: failures[0]?.compliance_config_version ?? null,
  });

  return {
    target: "mis",
    org_id,
    inspected: ulns.length,
    passed,
    failed: failures.length,
    failures,
    build_errors,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Public entry — dispatched from queueProcessors/index.ts
// ─────────────────────────────────────────────────────────────────────

export const processComplianceValidation = async (
  job: Job<ComplianceValidationJob>,
): Promise<ComplianceValidationResult> => {
  const data = job.data;
  if (!data.orgId || !Types.ObjectId.isValid(data.orgId)) {
    throw new Error(
      `processComplianceValidation: invalid orgId "${data.orgId}" on job ${job.id}`,
    );
  }

  if (data.target === "mis") {
    const ulns =
      data.ulns && data.ulns.length > 0
        ? data.ulns
        : data.uln
          ? [data.uln]
          : [];
    if (ulns.length === 0) {
      throw new Error(
        `processComplianceValidation: MIS target requires uln or ulns on job ${job.id}`,
      );
    }
    return processMisValidation(data.orgId, ulns);
  }

  // ILR + RARPA standalone validation: deferred. Both pipelines
  // already validate inline in their own generators. When a
  // standalone use case arrives, add branches here that read the
  // existing artefact via `exportId` and re-run validation
  // against the active ComplianceConfig.
  logger.info(
    { jobId: job.id, target: data.target, orgId: data.orgId },
    "processComplianceValidation: target stubbed (validation happens inline in its own generator)",
  );
  return {
    target: data.target,
    org_id: data.orgId,
    inspected: 0,
    passed: 0,
    failed: 0,
    failures: [],
    build_errors: [],
  };
};

// Re-export for tests
export const __internals__ = {
  validateOneMisUln,
  processMisValidation,
};
