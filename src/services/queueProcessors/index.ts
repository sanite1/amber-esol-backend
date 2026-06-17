import { Job } from "bullmq";
import logger from "../../config/logger";
import PostcodeRouter from "../postcodeRouter.service";
import FALACache from "../falaCache.service";
import { updateLedgerForTurn } from "../vocabLedger.service";
import {
  recordTurnEvidence,
  recordSessionCompleteEvidence,
} from "../evidenceChain.service";
import { sendSafeguardingAlertEmail } from "../notifications/safeguardingAlertEmail.service";
import { sendProgressionReadyEmail } from "../notifications/progressionReadyEmail.service";
import { sendProgressionConfirmedEmail } from "../notifications/progressionConfirmedEmail.service";
import { sendProgressionRejectedEmail } from "../notifications/progressionRejectedEmail.service";
import { sendDormantLearnersDigestEmail } from "../notifications/dormantLearnersDigestEmail.service";
import { sendLearnerNudgeEmail } from "../notifications/learnerNudgeEmail.service";
import { runOrgProgressionCheck } from "../progressionCron.service";
import {
  processRecalcLearnerPriority,
  processRecalcOrgPriorities,
} from "../priorityQueueRecalc.service";
import { runIlrExport } from "../ilrExport.service";
import { generateEvidenceReport } from "../evidenceReport.service";
import { generateStage5Summary } from "../stage5AiSummary.service";
import IdempotencyKey from "../../models/IdempotencyKey";
import {
  persistExportArtifacts,
  buildCompanionJson,
  fieldNameOverridesForYear,
} from "../ilrCsvWriter.service";
import { Types } from "mongoose";
import User from "../../models/User";
import AuditLog from "../../models/AuditLog";
import type {
  EsolSessionJob,
  RarpaEvidenceJob,
  IlrExportJob,
  ComplianceValidationJob,
  MisPushJob,
  PriorityQueueJob,
  DeltaSyncJob,
  NotificationJob,
  NotificationsQueuePayload,
  SafeguardingAlertEmailJob,
  CacheRefreshJob,
} from "../../queues";

/**
 * Queue job processors — one per queue.
 *
 * Each processor is a stub that logs the inbound payload and returns. Real
 * implementations land per-feature in subsequent tasks:
 *
 *   esolSession        → Phase 9 (AI tutor session)
 *   rarpaEvidence      → Phase 11 (RARPA stages 2–5 compilation)
 *   ilrExport          → Phase 12 (ILR CSV + warnings)
 *   complianceValidation → Phase 13 (green-light validator)
 *   misPush            → Phase 14 (ProSolution/Maytas/EBS push)
 *   priorityQueue      → Phase 15 (teacher prep scoring)
 *   deltaSync          → Phase 15 (MIS delta cron)
 *   notifications      → Phase 10 (safeguarding + email plumbing)
 *
 * When you implement the real version, replace the function body. The worker
 * signature stays identical so no other file has to change.
 */

const stub = async <T>(
  name: string,
  job: Job<T>,
): Promise<{ stubbed: true }> => {
  logger.info(
    { processor: name, jobId: job.id, jobName: job.name, data: job.data },
    "[stub] processor invoked — no real work performed",
  );
  return { stubbed: true };
};

/**
 * esol-session processor — dispatches on `job.data.action`.
 *
 *   update_vocab     → vocabLedger.updateLedgerForTurn (Function 9 To-Do 1)
 *   capture_evidence → stub (Phase 11 / Stage 4 evidence rollup)
 *   process_turn     → stub (the live turn runs inline in the request
 *                      path; this branch is reserved for a future
 *                      async-turn mode)
 *
 * Each branch returns its own result shape; the wrapper just logs.
 */
export const processEsolSession = async (
  job: Job<EsolSessionJob>,
): Promise<{ action: string; result: unknown }> => {
  const { action, learnerId } = job.data;
  const payload = (job.data.payload ?? {}) as Record<string, unknown>;

  switch (action) {
    case "update_vocab": {
      const words = Array.isArray(payload.vocabulary_items_used)
        ? (payload.vocabulary_items_used as string[])
        : Array.isArray(payload.vocabularyItemsUsed)
          ? (payload.vocabularyItemsUsed as string[])
          : [];
      const turnScore =
        typeof payload.turn_score === "number"
          ? (payload.turn_score as number)
          : typeof payload.turnScore === "number"
            ? (payload.turnScore as number)
            : 0;
      const scenarioId =
        typeof payload.scenario_id === "string"
          ? (payload.scenario_id as string)
          : typeof payload.scenarioId === "string"
            ? (payload.scenarioId as string)
            : null;
      const stage3ObjectiveId =
        typeof payload.stage3_objective_id === "string"
          ? (payload.stage3_objective_id as string)
          : typeof payload.stage3ObjectiveId === "string"
            ? (payload.stage3ObjectiveId as string)
            : null;

      // Insert-only enrichment (orgId/sessionId/esolLevel/topic) —
      // optional; older queued jobs without it still process fine.
      const context =
        payload.context && typeof payload.context === "object"
          ? (payload.context as {
              orgId?: string | null;
              sessionId?: string | null;
              esolLevel?: string | null;
              topic?: string | null;
            })
          : undefined;

      const result = await updateLedgerForTurn(
        learnerId,
        words,
        turnScore,
        scenarioId,
        stage3ObjectiveId,
        context,
      );
      return { action, result };
    }

    case "capture_evidence": {
      // F29 — write the structured per-beat evidence chain for this
      // turn (beat_2_roleplay) and, when the session just completed,
      // its beat_3_complete records. Capture-time, append-only.
      const sessionId =
        typeof job.data.sessionId === "string" ? job.data.sessionId : null;
      const orgId = typeof job.data.orgId === "string" ? job.data.orgId : null;
      const turnIndex =
        typeof payload.turnIndex === "number"
          ? (payload.turnIndex as number)
          : 0;

      await recordTurnEvidence({
        learnerId,
        orgId,
        sessionId,
        turnIndex,
        turnScore:
          typeof payload.turnScore === "number"
            ? (payload.turnScore as number)
            : undefined,
        skillCodesUsed: Array.isArray(payload.skillCodesUsed)
          ? (payload.skillCodesUsed as string[])
          : undefined,
        vocabularyItemsUsed: Array.isArray(payload.vocabularyItemsUsed)
          ? (payload.vocabularyItemsUsed as string[])
          : undefined,
        mode:
          typeof payload.mode === "string"
            ? (payload.mode as string)
            : undefined,
        recastApplied:
          typeof payload.recastApplied === "boolean"
            ? (payload.recastApplied as boolean)
            : undefined,
      });

      if (payload.sessionComplete === true) {
        await recordSessionCompleteEvidence({
          learnerId,
          orgId,
          sessionId,
          sessionSummary:
            typeof payload.sessionSummary === "string"
              ? (payload.sessionSummary as string)
              : null,
        });
      }

      return { action, result: { captured: true } };
    }

    case "process_turn":
      // Stub — async-turn mode (post-MVP).
      return {
        action,
        result: await stub(`processEsolSession.${action}`, job),
      };

    default: {
      const _exhaustive: never = action as never;
      void _exhaustive;
      logger.warn(
        { jobId: job.id, jobName: job.name, action },
        "esol-session job received with unknown action — ignoring",
      );
      return { action, result: { ignored: true } };
    }
  }
};

/**
 * rarpa-evidence processor — dispatches on `job.data.kind`.
 *
 *   "evidence_report" → consolidated org-wide PDF (Function 14 To-Do 4)
 *   "stage_compile"   → per-learner Stage 2–5 compile (Phase 11, stubbed)
 *   absent            → legacy back-compat; treated as stage_compile
 *
 * Evidence-report lifecycle (BullMQ.updateProgress at each stage):
 *   10%  worker started; idempotency lock claimed
 *   60%  generateEvidenceReport done (data assembled + PDF rendered + cached)
 *   80%  IdempotencyKey marked completed with download metadata
 *   100% AuditLog committed; result returned
 */
export const processRarpaEvidence = async (
  job: Job<RarpaEvidenceJob>,
): Promise<{ kind: string; result: unknown }> => {
  const data = job.data as RarpaEvidenceJob & { kind?: string };
  const kind = data.kind ?? "stage_compile";

  // ── Stage-compile (Phase 11) — still a stub ──────────────────────
  if (kind === "stage_compile") {
    return {
      kind,
      result: await stub("processRarpaEvidence.stage_compile", job),
    };
  }

  // ── Stage 5 AI tutor summary (Function 17) ──────────────────────
  // Delegated to its own service. Throws on Gemini failure so BullMQ
  // retries (3 attempts with backoff). Returns a structured result
  // envelope on success / skip.
  if (kind === "stage5_summary") {
    const payload = data as Extract<
      RarpaEvidenceJob,
      { kind: "stage5_summary" }
    >;
    const result = await generateStage5Summary(payload.stage5_review_id);
    return { kind, result };
  }

  if (kind !== "evidence_report") {
    logger.warn(
      { jobId: job.id, jobName: job.name, kind },
      "rarpa-evidence job received with unknown kind — ignoring",
    );
    return { kind, result: { ignored: true } };
  }

  // ── Evidence-report (Function 14 To-Do 4) ────────────────────────
  // Re-type after the `kind === "evidence_report"` guard. We can't
  // rely on TS narrowing through the optional-kind union shape, so
  // we cast to the concrete report-job shape here.
  const reportData = data as Extract<
    RarpaEvidenceJob,
    { kind: "evidence_report" }
  >;
  const { orgId, periodStart, periodEnd, requestedBy, reportId } = reportData;

  logger.info(
    { jobId: job.id, reportId, orgId, periodStart, periodEnd },
    "processRarpaEvidence: evidence_report start",
  );

  // 1. Claim the idempotency lock UPFRONT (status: "processing"). A
  //    duplicate trigger arriving while this one is still running
  //    will see the lock and short-circuit. Use updateOne with
  //    upsert so retries on this job don't bounce on the unique index.
  await IdempotencyKey.updateOne(
    { key: reportId, operation: "rarpa-evidence" },
    {
      $setOnInsert: {
        key: reportId,
        operation: "rarpa-evidence",
        org_id: new Types.ObjectId(orgId),
        created_at: new Date(),
      },
      $set: { status: "processing", error: null },
    },
    { upsert: true },
  );
  await job.updateProgress(10);

  try {
    // 2. Build the report (assemble payload + render Handlebars + PDF +
    //    write to ${EVIDENCE_REPORT_DIR}/<reportId>.pdf). The service
    //    is the heavy lift.
    const result = await generateEvidenceReport(orgId, periodStart, periodEnd, {
      reportId,
    });
    await job.updateProgress(60);

    // 3. Mark the lock completed with the metadata the download route
    //    needs (period bounds, learner count, generated_at).
    // The cached envelope stores the canonical download URL — the
    // route layer reads this on cache hits instead of recomputing the
    // path string (Function 14 To-Do 5).
    const downloadUrl = `/api/org-admin/evidence-report/${reportId}/download`;
    await IdempotencyKey.updateOne(
      { key: reportId, operation: "rarpa-evidence" },
      {
        $set: {
          status: "completed",
          result: {
            report_id: reportId,
            period_start: periodStart,
            period_end: periodEnd,
            generated_at: result.payload.generated_at,
            learner_count: result.payload.cohort.total_learners,
            pdf_bytes: result.pdf_buffer.length,
            download_url: downloadUrl,
          },
        },
      },
    );
    await job.updateProgress(80);

    // 4. AuditLog (brief Function 14 To-Do 4).
    let requesterName = "Org admin";
    if (requestedBy && Types.ObjectId.isValid(requestedBy)) {
      const requester = await User.findById(requestedBy)
        .select("firstname lastname")
        .lean();
      if (requester) {
        requesterName =
          `${requester.firstname ?? ""} ${requester.lastname ?? ""}`.trim() ||
          "Org admin";
      }
    }
    await AuditLog.create({
      timestamp: new Date(),
      actor_type: "org_admin",
      actor_id: Types.ObjectId.isValid(requestedBy)
        ? new Types.ObjectId(requestedBy)
        : null,
      org_id: new Types.ObjectId(orgId),
      learner_id: null,
      action: "evidence_report_generated",
      before_state: null,
      after_state: {
        report_id: reportId,
        period_start: periodStart,
        period_end: periodEnd,
        learner_count: result.payload.cohort.total_learners,
        pdf_bytes: result.pdf_buffer.length,
      },
      reason: `RARPA evidence report generated by ${requesterName} for period ${periodStart} to ${periodEnd}`,
      compliance_config_version: null,
    }).catch((err) =>
      logger.error(
        { err: (err as Error).message, reportId },
        "processRarpaEvidence: AuditLog write failed (report still complete)",
      ),
    );
    await job.updateProgress(100);

    return {
      kind,
      result: {
        report_id: reportId,
        download_url: downloadUrl,
        learner_count: result.payload.cohort.total_learners,
        pdf_bytes: result.pdf_buffer.length,
      },
    };
  } catch (err) {
    // Mark the lock as failed so a subsequent retrigger doesn't see
    // a stuck "processing" row. BullMQ's retry policy still applies —
    // 3 attempts before terminal failure.
    await IdempotencyKey.updateOne(
      { key: reportId, operation: "rarpa-evidence" },
      { $set: { status: "failed", error: (err as Error).message } },
    ).catch(() => undefined);
    throw err;
  }
};

/**
 * ilr-export processor — brief Function 13 To-Do 4.
 *
 * Lifecycle (with BullMQ job.updateProgress at each stage):
 *   25%  buildIlrRows complete (rows assembled from Mongo)
 *   50%  validateRows complete (errors + warnings classified)
 *   75%  CSV + companion JSON written to disk
 *   100% AuditLog row committed; result returned
 *
 * Returns `{ download_url, json_url, rows_exported, rows_blocked }`
 * so the status endpoint can advertise the artefacts without
 * re-reading the result envelope. The export_id flows through from
 * the route's idempotency key (the route computed it; the worker
 * echoes it back).
 */
export const processIlrExport = async (
  job: Job<IlrExportJob>,
): Promise<{
  export_id: string;
  download_url: string;
  json_url: string;
  rows_exported: number;
  rows_blocked: number;
  warnings_count: number;
}> => {
  const { orgId, academicYear, periodStart, periodEnd, requestedBy, exportId } =
    job.data;

  logger.info(
    { jobId: job.id, exportId, orgId, academicYear, periodStart, periodEnd },
    "processIlrExport: start",
  );

  // ── 1. Build rows + validate ────────────────────────────────────
  // runIlrExport composes both halves and wraps in IdempotencyService;
  // a duplicate (org, year, periods) tuple will short-circuit here.
  const result = await runIlrExport({
    org_id: orgId,
    academic_year: academicYear,
    period_start: periodStart,
    period_end: periodEnd,
  });
  await job.updateProgress(50);

  // ── 2. Compute teacher-contact map (one read; per-learner GLH) ──
  const learnerIds = Array.from(
    new Set([
      ...result.valid_rows.map((r) => r._learner_id),
      ...result.blocked_rows.map((b) => b.row._learner_id),
    ]),
  );
  const teacherContactByLearner = new Map<string, number>();
  if (learnerIds.length > 0) {
    const learners = await User.find({ _id: { $in: learnerIds } })
      .select("_id glh_teacher_contact")
      .lean();
    for (const l of learners) {
      teacherContactByLearner.set(
        (l._id as Types.ObjectId).toString(),
        (l as { glh_teacher_contact?: number }).glh_teacher_contact ?? 0,
      );
    }
  }

  // ── 3. Persist CSV + companion JSON ─────────────────────────────
  const companion = buildCompanionJson({
    exportId,
    generatedAt: new Date(),
    configVersion: result.config_version,
    validRows: result.valid_rows,
    blockedRows: result.blocked_rows,
    warnings: result.warnings,
    teacherContactByLearner,
  });
  const overrides = fieldNameOverridesForYear(academicYear);
  const persisted = await persistExportArtifacts({
    exportId,
    validRows: result.valid_rows,
    fieldNameOverrides: overrides,
    companion,
  });
  await job.updateProgress(75);

  // ── 4. AuditLog row (brief Function 13 To-Do 4) ────────────────
  let requesterName = "Org admin";
  if (requestedBy && Types.ObjectId.isValid(requestedBy)) {
    const requester = await User.findById(requestedBy)
      .select("firstname lastname")
      .lean();
    if (requester) {
      requesterName =
        `${requester.firstname ?? ""} ${requester.lastname ?? ""}`.trim() ||
        "Org admin";
    }
  }
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "org_admin",
    actor_id: Types.ObjectId.isValid(requestedBy)
      ? new Types.ObjectId(requestedBy)
      : null,
    org_id: new Types.ObjectId(orgId),
    learner_id: null,
    action: "ilr_export_completed",
    before_state: null,
    after_state: {
      export_id: exportId,
      academic_year: academicYear,
      period_start: periodStart,
      period_end: periodEnd,
      rows_exported: result.valid_rows.length,
      rows_blocked: result.blocked_rows.length,
      warnings_count: result.warnings.length,
      totals: companion.totals,
    },
    reason: `ILR export generated by ${requesterName} for period ${periodStart} to ${periodEnd}`,
    compliance_config_version: result.config_version,
  }).catch((err) =>
    logger.error(
      { err: (err as Error).message, exportId },
      "processIlrExport: AuditLog write failed (export still complete)",
    ),
  );
  await job.updateProgress(100);

  return {
    export_id: exportId,
    download_url: `/api/org-admin/export/ilr/${exportId}/download`,
    json_url: `/api/org-admin/export/ilr/${exportId}/download?format=json`,
    rows_exported: result.valid_rows.length,
    rows_blocked: result.blocked_rows.length,
    warnings_count: result.warnings.length,
  };
};

// Re-export the real processors built in services/mis/. Keeping the
// re-export here (rather than wiring workers to import from mis/
// directly) preserves the queueProcessors module as the single
// dispatch hub the worker base class binds against.
export { processComplianceValidation } from "../mis/processComplianceValidation";
export { processMisPush } from "../mis/processMisPush";

/**
 * priority-queue processor — dispatches on `job.data.action`.
 *
 *   "check-progression"      → Function 11 per-org sweep:
 *                              runOrgProgressionCheck(orgId)
 *   "recalc-org-priorities"  → Final Addendum §10 Todo 23.3
 *                              per-org teacher-priority recalc:
 *                              processRecalcOrgPriorities(job)
 *   "teacher-priority-score" → Phase 23 teacher prep scoring (stub —
 *                              superseded by recalc-org-priorities,
 *                              kept for back-compat with any in-flight
 *                              jobs enqueued before the rename)
 *   absent                   → back-compat path; treated as
 *                              teacher-priority-score
 *
 * Per-org-job design: the daily cron fans out one job per org, so a
 * single bad org doesn't block the rest, and BullMQ's retry policy
 * gives the worker three attempts before terminal failure.
 */
export const processPriorityQueue = async (
  job: Job<PriorityQueueJob>,
): Promise<{ action: string; result: unknown }> => {
  const action = job.data.action ?? "teacher-priority-score";

  if (action === "check-progression") {
    if (!job.data.orgId) {
      logger.warn(
        { jobId: job.id },
        "processPriorityQueue: check-progression job missing orgId — skipping",
      );
      return { action, result: { skipped: true, reason: "missing orgId" } };
    }
    const result = await runOrgProgressionCheck(job.data.orgId);
    return { action, result };
  }

  if (action === "recalc-org-priorities") {
    // Cast — the recalc service accepts either { orgId } (the queue's
    // existing convention, propagated from PriorityQueueJob.orgId)
    // or { org_id } (the brief's payload shape). The shared dispatcher
    // hands the job through unmodified; the recalc worker normalises
    // the key internally.
    const result = await processRecalcOrgPriorities(
      job as unknown as Job<{
        orgId?: string;
        org_id?: string;
        runId?: string;
      }>,
    );
    return { action, result };
  }

  if (action === "recalc-learner-priority") {
    // Todo 23.4 — single-learner recalc fired off teacher actions.
    // Same dual-key payload tolerance as the org variant.
    const result = await processRecalcLearnerPriority(
      job as unknown as Job<{
        learnerId?: string;
        learner_id?: string;
        triggerEvent?: string;
      }>,
    );
    return { action, result };
  }

  // Phase 23 — teacher priority scoring stub until that work lands.
  const result = await stub("processPriorityQueue.teacher-priority-score", job);
  return { action, result };
};

// Real implementation in services/mis/processDeltaSync.ts.
export { processDeltaSync } from "../mis/processDeltaSync";

/**
 * notifications processor — dispatches on `job.name`.
 *
 *   "safeguarding-alert"  → send DSL email via privateemail.com SMTP
 *                            (brief Function 10; payload is the minimal
 *                            { category, org_id, alert_id,
 *                              alert_created_at } — see
 *                            safeguardingAlertEmail.service for body
 *                            composition + privacy contract)
 *   any other name        → stub (other notification types land in their
 *                            own functions as they're built)
 *
 * Type-narrowing: the queue accepts a union (NotificationsQueuePayload).
 * The TS narrowing here happens via `job.name` — runtime guard on the
 * required fields keeps us safe if a job is enqueued with the wrong
 * shape.
 */
export const processNotifications = async (
  job: Job<NotificationsQueuePayload>,
): Promise<{ kind: string; result: unknown }> => {
  if (job.name === "safeguarding-alert") {
    const data = job.data as SafeguardingAlertEmailJob;
    if (
      typeof data.category !== "string" ||
      typeof data.org_id !== "string" ||
      typeof data.alert_created_at !== "string"
    ) {
      logger.error(
        { jobId: job.id, data },
        "safeguarding-alert job has invalid payload shape — refusing to dispatch",
      );
      throw new Error("Invalid safeguarding-alert payload");
    }
    const result = await sendSafeguardingAlertEmail(data);
    return { kind: "safeguarding-alert", result };
  }

  if (job.name === "progression-confirmed-email") {
    const generic = job.data as NotificationJob;
    const payload = (generic.payload ?? {}) as Record<string, unknown>;
    if (
      typeof payload.learner_email !== "string" ||
      typeof payload.learner_name !== "string" ||
      typeof payload.new_level !== "string"
    ) {
      logger.error(
        { jobId: job.id, data: generic },
        "progression-confirmed-email: invalid payload shape — refusing to dispatch",
      );
      throw new Error("Invalid progression-confirmed-email payload");
    }
    const result = await sendProgressionConfirmedEmail({
      learner_id:
        typeof payload.learner_id === "string" ? payload.learner_id : "",
      learner_email: payload.learner_email,
      learner_name: payload.learner_name,
      l1_language:
        typeof payload.l1_language === "string"
          ? payload.l1_language
          : "english",
      old_level: typeof payload.old_level === "string" ? payload.old_level : "",
      new_level: payload.new_level,
    });
    return { kind: "progression-confirmed-email", result };
  }

  if (job.name === "progression-rejected-email") {
    const generic = job.data as NotificationJob;
    const payload = (generic.payload ?? {}) as Record<string, unknown>;
    if (
      typeof payload.org_admin_user_id !== "string" ||
      typeof payload.learner_name !== "string" ||
      typeof payload.reason !== "string"
    ) {
      logger.error(
        { jobId: job.id, data: generic },
        "progression-rejected-email: invalid payload shape — refusing to dispatch",
      );
      throw new Error("Invalid progression-rejected-email payload");
    }
    const result = await sendProgressionRejectedEmail({
      org_id: typeof payload.org_id === "string" ? payload.org_id : "",
      org_name:
        typeof payload.org_name === "string"
          ? payload.org_name
          : "your organisation",
      org_admin_user_id: payload.org_admin_user_id,
      learner_id:
        typeof payload.learner_id === "string" ? payload.learner_id : "",
      learner_name: payload.learner_name,
      current_level:
        typeof payload.current_level === "string"
          ? payload.current_level
          : "unknown",
      reason: payload.reason,
    });
    return { kind: "progression-rejected-email", result };
  }

  if (job.name === "dormant-learners-digest-email") {
    const generic = job.data as NotificationJob;
    const payload = (generic.payload ?? {}) as Record<string, unknown>;
    if (
      typeof payload.org_admin_user_id !== "string" ||
      typeof payload.dormant_count !== "number"
    ) {
      logger.error(
        { jobId: job.id, data: generic },
        "dormant-learners-digest-email: invalid payload — refusing to dispatch",
      );
      throw new Error("Invalid dormant-learners-digest-email payload");
    }
    const result = await sendDormantLearnersDigestEmail({
      org_admin_user_id: payload.org_admin_user_id,
      org_id: typeof payload.org_id === "string" ? payload.org_id : "",
      dormant_count: payload.dormant_count,
      window_days:
        typeof payload.window_days === "number" ? payload.window_days : 14,
    });
    return { kind: "dormant-learners-digest-email", result };
  }

  if (job.name === "learner-nudge-email") {
    const generic = job.data as NotificationJob;
    const payload = (generic.payload ?? {}) as Record<string, unknown>;
    if (
      typeof payload.learner_email !== "string" ||
      typeof payload.learner_name !== "string"
    ) {
      logger.error(
        { jobId: job.id, data: generic },
        "learner-nudge-email: invalid payload — refusing to dispatch",
      );
      throw new Error("Invalid learner-nudge-email payload");
    }
    const result = await sendLearnerNudgeEmail({
      learner_id:
        typeof payload.learner_id === "string" ? payload.learner_id : "",
      learner_email: payload.learner_email,
      learner_name: payload.learner_name,
      l1_language:
        typeof payload.l1_language === "string"
          ? payload.l1_language
          : "english",
      esol_level:
        typeof payload.esol_level === "string" ? payload.esol_level : null,
      custom_message:
        typeof payload.custom_message === "string"
          ? payload.custom_message
          : null,
      sent_by_user_id:
        typeof payload.sent_by_user_id === "string"
          ? payload.sent_by_user_id
          : "",
    });
    return { kind: "learner-nudge-email", result };
  }

  if (job.name === "progression-ready-email") {
    // The progression-ready email reuses the generic NotificationJob
    // shape: { channel, recipientId, type, payload }. We extract
    // payload + recipient here and hand off to the typed sender.
    const generic = job.data as NotificationJob;
    const payload = (generic.payload ?? {}) as Record<string, unknown>;
    if (
      typeof generic.recipientId !== "string" ||
      typeof payload.learner_name !== "string" ||
      typeof payload.current_level !== "string"
    ) {
      logger.error(
        { jobId: job.id, data: generic },
        "progression-ready-email: invalid payload shape — refusing to dispatch",
      );
      throw new Error("Invalid progression-ready-email payload");
    }
    const result = await sendProgressionReadyEmail({
      org_admin_user_id: generic.recipientId,
      org_id: typeof payload.org_id === "string" ? payload.org_id : "",
      learner_id:
        typeof payload.learner_id === "string" ? payload.learner_id : "",
      learner_name: payload.learner_name,
      current_level: payload.current_level,
      ready_at:
        typeof payload.ready_at === "string"
          ? payload.ready_at
          : new Date().toISOString(),
    });
    return { kind: "progression-ready-email", result };
  }

  // Other notification types — fall through to the stub. As each
  // notification type's real implementation lands, add a branch above.
  const result = await stub("processNotifications", job);
  return { kind: "stub", result };
};

/**
 * Real implementation (not a stub). Branches on job.name to either load
 * the postcode dataset into Redis or refresh the FALA whitelist.
 */
export const processCacheRefresh = async (
  job: Job<CacheRefreshJob>,
): Promise<{ task: string; result: unknown }> => {
  const { task, academicYear } = job.data;
  logger.info(
    { task, academicYear, jobId: job.id },
    "cache-refresh job started",
  );

  if (task === "postcode-load") {
    const result = await PostcodeRouter.loadDatasetFromSource(academicYear);
    return { task, result };
  }
  if (task === "fala-refresh") {
    const result = await FALACache.reload(academicYear);
    return { task, result };
  }

  throw new Error(`Unknown cache-refresh task: ${task}`);
};
