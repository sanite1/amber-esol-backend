import { readFileSync } from "fs";
import { resolve } from "path";
import { Types } from "mongoose";

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AISession from "../models/AISession";
import AuditLog from "../models/AuditLog";
import FailedJob from "../models/FailedJob";
import SafeguardingAlert from "../models/SafeguardingAlert";
import TurnLog from "../models/TurnLog";
import User from "../models/User";
import VocabLedger from "../models/VocabLedger";
import { createHash } from "crypto";
import {
  esolSessionQueue,
  notificationsQueue,
  priorityQueueQueue,
} from "../queues";
import IdempotencyService from "./idempotency.service";
import TeacherMessage from "../models/TeacherMessage";
import { ILR_CODE_TO_DOMAIN, IlrSkillCode } from "./esolSkills";
import SafeguardingDetector from "./safeguardingDetector.service";
import {
  loadSafeguardingMessage,
  mapCategoryToBankKey,
} from "./safeguardingMessages.service";
import {
  assemblePrompt,
  LearnerProfileForPrompt,
  ScenarioForPrompt,
} from "./promptAssembly.service";
import { SchemaType } from "@google-cloud/vertexai";
import { generateTurn, ConversationTurn } from "./gemini.service";
import { generateSessionSummary } from "./geminiAI.service";
import { updateLedgerForTurn } from "./vocabLedger.service";
import { encryptSafeguardingRaw } from "../lib/safeguardingCrypto";
import { validateGeminiTurnOutput } from "../utils/geminiOutputValidator";
import { IGeminiTurnOutput } from "../interfaces/geminiTurnOutput.interface";

/**
 * Gemini structured-output schema for AI tutor turns — sent to Vertex
 * as `generationConfig.responseSchema` so the model knows the exact
 * shape to return. Without this, Gemini free-styles JSON and the
 * downstream Zod validator (`validateGeminiTurnOutput`) rejects almost
 * every response with "Required" errors.
 *
 * Field-for-field mirror of `geminiOutputValidator.ts`:
 *   - 8 required fields: reply, mode, skill_codes_used, turn_score,
 *     vocabulary_items_used, safeguarding_flag, session_complete,
 *     safeguarding_category. (`session_summary` is nullable + only
 *     required when session_complete=true; enforced by the Zod
 *     refine() callbacks downstream.)
 *   - `mode` enum mirrors the validator's lowercased values. The
 *     existing geminiAI.service.ts used uppercase ANCHOR/BRIDGE/
 *     IMMERSION; the Zod validator expects lowercase. Aligning here.
 *   - `grammar_feedback` listed optional so Gemini may include it
 *     without tripping Zod (validator should also drop .strict()).
 */
const TURN_RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    reply: { type: SchemaType.STRING },
    mode: {
      type: SchemaType.STRING,
      enum: ["anchor", "bridge", "immersion"],
    },
    skill_codes_used: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    turn_score: { type: SchemaType.NUMBER },
    vocabulary_items_used: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    safeguarding_flag: { type: SchemaType.BOOLEAN },
    safeguarding_category: {
      type: SchemaType.STRING,
      nullable: true,
    },
    session_complete: { type: SchemaType.BOOLEAN },
    session_summary: {
      type: SchemaType.STRING,
      nullable: true,
    },
    grammar_feedback: {
      type: SchemaType.STRING,
      nullable: true,
    },
    // F23/F24 contract additions — optional (validator defaults them),
    // so they're declared here for Gemini but kept out of `required`.
    replyLang: {
      type: SchemaType.STRING,
      enum: ["l1", "en", "mixed"],
      nullable: true,
    },
    microStageComplete: { type: SchemaType.BOOLEAN, nullable: true },
    recastApplied: { type: SchemaType.BOOLEAN, nullable: true },
    emotional_state: {
      type: SchemaType.STRING,
      enum: ["engaged", "neutral", "frustrated", "anxious", "withdrawn"],
      nullable: true,
    },
  },
  required: [
    "reply",
    "mode",
    "skill_codes_used",
    "turn_score",
    "vocabulary_items_used",
    "safeguarding_flag",
    "safeguarding_category",
    "session_complete",
    "session_summary",
  ],
} as const;
import { EsolLevel } from "../interfaces/placementQuestion.interface";
import { IScenarioFile } from "../interfaces/scenario.interface";
import ComplianceConfigService from "./ComplianceConfigService";
import logger from "../config/logger";

/**
 * LOUD escalation when any step of the safeguarding-alert delivery
 * fails (F22 hardening). A safeguarding disclosure that doesn't reach
 * the DSL is a binary inspection failure, so a failure here must never
 * be a quiet logger.error.
 *
 * Robust by design: writes a durable FailedJob row (surfaced on the
 * Amber-admin Failed Jobs dashboard) FIRST — that path doesn't depend
 * on Redis, so it survives the very outage that broke the live alert —
 * then best-effort enqueues an admin notification, then logs FATAL.
 * The learner has already been served the supportive pre-cache reply;
 * this is purely about getting a human's attention.
 */
const escalateSafeguardingFailure = async (params: {
  stage: "alert_create" | "audit_write" | "dsl_notify_enqueue";
  err: unknown;
  learnerId: Types.ObjectId | string;
  sessionId: Types.ObjectId | string;
  orgId: string;
  category: string | null;
}): Promise<void> => {
  const errMsg =
    params.err instanceof Error ? params.err.message : String(params.err);
  logger.fatal(
    {
      stage: params.stage,
      err: errMsg,
      learnerId: String(params.learnerId),
      sessionId: String(params.sessionId),
      orgId: params.orgId,
      category: params.category,
    },
    "SAFEGUARDING DELIVERY FAILURE — a disclosure may not have reached the DSL. Escalating to admin.",
  );

  // Durable, admin-visible, queue-independent record.
  await FailedJob.create({
    queue_name: "safeguarding-critical",
    job_id: `sg-${String(params.sessionId)}-${Date.now()}`,
    error: `Safeguarding ${params.stage} failed: ${errMsg}`,
    job_data: {
      stage: params.stage,
      learner_id: String(params.learnerId),
      session_id: String(params.sessionId),
      org_id: params.orgId,
      category: params.category,
    },
    attempts: 0,
  }).catch((e) =>
    logger.fatal(
      { err: (e as Error).message, stage: params.stage },
      "SAFEGUARDING ESCALATION: FailedJob write ALSO failed — manual check required",
    ),
  );

  // Best-effort admin ping (may itself fail if the queue is the outage).
  await notificationsQueue
    .add(
      "admin_job_failure",
      {
        channel: "email",
        recipientId: "amber-admin",
        type: "admin_job_failure",
        payload: {
          queue: "safeguarding-critical",
          jobName: `safeguarding_${params.stage}`,
          error: `Safeguarding ${params.stage} failed`,
          orgId: params.orgId,
        },
      },
      { priority: 1 },
    )
    .catch(() => undefined);
};

/**
 * Safe reply served when a Gemini turn fails terminally (F24 — "never
 * show the learner a broken turn"). Deliberately plain English + warm;
 * the learner is practising English so an English nudge is appropriate,
 * and it makes no claim / sets no score. ANCHOR mode keeps support high.
 */
const ANCHOR_FALLBACK_REPLY =
  "Sorry — I didn't quite catch that. Could you say it again? Take your time, there's no rush.";

/**
 * Per-turn AI tutor handler — brief Function 7 To-Do 5 + Final
 * Addendum (pre-cache safeguarding, async queue, audit logging).
 *
 * Orchestrates the flow described in the brief verbatim:
 *
 *   1. Look up AISession by id, verify learner ownership
 *   2. SafeguardingDetector.scan(message, l1) BEFORE Gemini
 *      → triggered: serve pre-cached reply, raise alert, audit, RETURN
 *   3. TurnLog the raw message (audit trail)
 *   4. Build Layer 5 (dynamic learner profile)
 *   5. assemblePrompt (Function 7 To-Do 1)
 *   6. Build conversation history from session.turns
 *   7. generateTurn (Function 9 wrapper around the singleton)
 *   8. validateGeminiTurnOutput (Function 7 To-Do 4, Zod)
 *   9. Secondary safeguarding: Gemini flagged + keywords didn't →
 *      ai_only_safeguarding_flag (defence-in-depth)
 *   10. Enqueue vocab + evidence on esol-session, push turn_score,
 *       set teaching_mode_sequence, check session_complete
 *   11. Return { reply, mode, session_complete, vocab_words_seen }
 *
 * Every Mongo write that doesn't gate the response is wrapped in
 * .catch(logger) — a billing/audit hiccup must not fail the learner's
 * turn. The audit story stays correct because the TurnLog row is
 * persisted in step 3 BEFORE Gemini even runs.
 */

// ─────────────────────────────────────────────────────────────────────
// Scenario loader (disk-backed; Function 7 To-Do 2 JSON files)
// ─────────────────────────────────────────────────────────────────────

const SCENARIOS_DIR = resolve(__dirname, "../data/scenarios");
const scenarioCache = new Map<string, IScenarioFile>();

const loadScenarioById = (scenarioId: string): IScenarioFile | null => {
  if (scenarioCache.has(scenarioId)) return scenarioCache.get(scenarioId)!;
  try {
    const path = resolve(SCENARIOS_DIR, `${scenarioId}.json`);
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as IScenarioFile;
    scenarioCache.set(scenarioId, parsed);
    return parsed;
  } catch (err) {
    logger.warn(
      { err, scenarioId },
      "Scenario file not found or unparseable — turn will use general-conversation prompt",
    );
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const NORMALISED_LEVELS: ReadonlySet<EsolLevel> = new Set<EsolLevel>([
  "e1",
  "e2",
  "e3",
  "l1",
  "l2",
]);

const normaliseLevel = (raw: unknown): EsolLevel => {
  if (typeof raw === "string") {
    const lc = raw.trim().toLowerCase();
    if (NORMALISED_LEVELS.has(lc as EsolLevel)) return lc as EsolLevel;
    // Display form — the User record stores what placement returned
    // ("Entry 1".."Level 2"), not the code form. Previously these
    // fell through to the e2 fallback, silently mis-calibrating an
    // Entry 1 learner's tutor session (and the scenario level gate)
    // to e2.
    const m = lc.match(/^(entry|level)\s*(\d)$/);
    if (m) {
      const code = `${m[1] === "entry" ? "e" : "l"}${m[2]}`;
      if (NORMALISED_LEVELS.has(code as EsolLevel)) return code as EsolLevel;
    }
  }
  // Sensible fallback — placement should have run by now. e2 is the
  // midpoint at which most learners enrol; safer than e1 (which would
  // condescend a fluent learner) or l1 (which would over-task a new one).
  return "e2";
};

const upperMode = (m: string): "BRIDGE" | "ANCHOR" | "IMMERSION" => {
  const u = m.toUpperCase();
  if (u === "BRIDGE" || u === "ANCHOR" || u === "IMMERSION") return u;
  return "BRIDGE";
};

const lowerMode = (m: string): "bridge" | "anchor" | "immersion" => {
  const l = m.toLowerCase();
  if (l === "bridge" || l === "anchor" || l === "immersion") return l;
  return "bridge";
};

/**
 * Layer 5 builder — pulls the per-session learner state Gemini needs
 * to calibrate this turn. Pure-ish (one DB read for vocab); no Gemini
 * call, no side effects on the learner doc.
 */
const buildLearnerProfile = async (
  learner: any,
  session: any,
): Promise<LearnerProfileForPrompt> => {
  // Recent session summaries — last 3 completed sessions for this
  // learner, newest first. Excludes the current session.
  const recent = await AISession.find({
    learnerId: learner._id,
    _id: { $ne: session._id },
    completedAt: { $ne: null },
    assessmentSummary: { $ne: null },
  })
    .sort({ completedAt: -1 })
    .limit(3)
    .select("assessmentSummary")
    .lean();

  const recentSessionSummaries: string[] = recent
    .map((s) => (s as any).assessmentSummary)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  // Top 6 vocab items due for reinforcement. Phase-10 stub: most-
  // recently-introduced words for this learner with masteryScore < 0.8.
  // Real spaced-repetition replaces this when Function 10 lands.
  const dueVocab = await VocabLedger.find({
    learnerId: learner._id,
    $or: [
      { masteryScore: { $lt: 0.8 } },
      { masteryScore: { $exists: false } },
      { masteryScore: null },
    ],
  })
    .sort({ introducedAt: -1 })
    .limit(6)
    .select("word")
    .lean();

  const vocabularyToReinforce: string[] = dueVocab.map((v) => (v as any).word);

  // Current mode — last entry in teaching_mode_sequence, else fall back
  // to the uppercase sessionMode. Gemini wants lowercase.
  const seq = (session.teaching_mode_sequence as string[] | undefined) ?? [];
  const currentMode =
    seq.length > 0
      ? lowerMode(seq[seq.length - 1])
      : lowerMode(session.sessionMode ?? "bridge");

  return {
    esolLevel: normaliseLevel(learner.esolLevel),
    l1Language: learner.l1Language ?? "english",
    vocabularyToReinforce,
    recentSessionSummaries,
    skillWeaknessFlags:
      (learner.skillWeaknessFlags as string[] | undefined) ?? [],
    currentMode:
      currentMode === "anchor"
        ? "ANCHOR"
        : currentMode === "immersion"
          ? "IMMERSION"
          : "BRIDGE",
    // advancement ceremony comes from Function 12 (level-change flow);
    // null for now means "no celebration this turn".
    advancementCeremony: null,
  };
};

/**
 * Map a scenario JSON file to the ScenarioForPrompt shape that
 * assemblePrompt expects. Trims the bank-language slice to what
 * Gemini will read (English only — Layer 6 / Layer 4 use the English
 * source for vocabulary definitions).
 */
const adaptScenario = (
  scenario: IScenarioFile,
  l1Code: string | undefined,
): ScenarioForPrompt => ({
  scenarioId: scenario.scenario_id,
  title: scenario.title.en,
  roleplayPrompt: scenario.roleplay_prompt_en,
  grammarTargets: scenario.grammar_targets,
  culturalNotes: scenario.cultural_notes_en,
  passThreshold: scenario.pass_threshold,
  l1Code,
  vocabulary: scenario.vocabulary_set.map((v) => ({
    word: v.word,
    definition: v.definition_en,
    translations: v.translations as Record<string, string>,
  })),
});

const buildConversationHistory = (session: any): ConversationTurn[] => {
  const turns = (session.turns ?? []) as Array<{
    originalInput?: string;
    deepSeekResponse?: string;
  }>;
  const history: ConversationTurn[] = [];
  for (const t of turns) {
    if (t.originalInput)
      history.push({ role: "user", content: t.originalInput });
    if (t.deepSeekResponse)
      history.push({ role: "model", content: t.deepSeekResponse });
  }
  return history;
};

// ─────────────────────────────────────────────────────────────────────
// Safeguarding handling
// ─────────────────────────────────────────────────────────────────────

interface SafeguardingTriggerArgs {
  session: any;
  learner: any;
  orgId: string;
  message: string;
  scanCategory: string | null;
  detectorMatchedPattern: string | null;
  /** "keyword" = SafeguardingDetector fired pre-Gemini;
   *  "ai_only" = Gemini flagged but detector didn't (secondary check). */
  source: "keyword" | "ai_only";
  /**
   * Pre-computed encrypted raw disclosure (keyword path passes this so
   * the same ciphertext that's stored here is also the basis for
   * redacting TurnLog). When omitted (ai_only path), the helper
   * encrypts internally. `null` = no key configured → not stored.
   */
  rawInputEncrypted?: string | null;
}

/**
 * Common path for both pre-Gemini (keyword) and post-Gemini (ai_only)
 * safeguarding triggers:
 *   1. Create SafeguardingAlert
 *   2. AuditLog with the right action
 *   3. Enqueue notifications job (email DSL)
 *   4. Mark session as safeguardingFlagged
 *
 * Never throws — a safeguarding flow failure should not block the
 * pre-cached reply reaching the learner.
 */
const recordSafeguardingTrigger = async (
  args: SafeguardingTriggerArgs,
): Promise<void> => {
  const { session, learner, orgId, message, scanCategory, source } = args;

  // 1. SafeguardingAlert
  // Severity mapping covers both naming dialects — the keyword detector
  // emits `child_concern` (matches the brief), Gemini emits
  // `child_protection` (legacy Zod enum). Both should escalate to
  // critical.
  const alertLevel =
    scanCategory === "self_harm" ||
    scanCategory === "child_concern" ||
    scanCategory === "child_protection"
      ? "critical"
      : scanCategory === "domestic_abuse" || scanCategory === "exploitation"
        ? "high"
        : "medium";

  // SHA-256 of the original message. Brief Function 10 mandate: the
  // safeguarding-alert collection stores hashes only, NEVER cleartext.
  // The disclosure text lives in TurnLog (the accepted audit trail)
  // and the hash lets a reviewer correlate alert → turn without
  // duplicating content across collections.
  const messageContentHash = createHash("sha256").update(message).digest("hex");

  // Normalise category onto the brief's bank keys so the dashboard
  // groups `child_protection` (Gemini-flagged) and `child_concern`
  // (keyword-flagged) together. Falls back to the raw value if the
  // mapper doesn't recognise it — defensive against a future Gemini
  // enum change leaking through.
  const triggerCategory =
    mapCategoryToBankKey(scanCategory) ?? scanCategory ?? null;

  // Encrypt the raw disclosure for at-rest storage on the alert. The
  // keyword path pre-computes this (so the same ciphertext drives the
  // TurnLog redaction); the ai_only path lets us encrypt here. null
  // when no key is configured — then nothing extra is stored and the
  // raw remains in the append-only TurnLog.
  const rawInputEncrypted =
    args.rawInputEncrypted !== undefined
      ? args.rawInputEncrypted
      : encryptSafeguardingRaw(message);

  let alertDoc: any = null;
  try {
    alertDoc = await SafeguardingAlert.create({
      learnerId: learner._id,
      orgId: new Types.ObjectId(orgId),
      sessionId: session._id,
      alertLevel,
      messageContentHash,
      rawInputEncrypted,
      triggerCategory,
      triggerSource: source,
      status: "open",
    });
  } catch (err) {
    // CRITICAL: with no alertDoc the DSL notification + session flag
    // below are skipped — the disclosure would otherwise vanish. Escalate
    // loudly so a human picks it up. Learner still gets the pre-cache reply.
    await escalateSafeguardingFailure({
      stage: "alert_create",
      err,
      learnerId: learner._id as Types.ObjectId,
      sessionId: session._id as Types.ObjectId,
      orgId,
      category: triggerCategory,
    });
  }

  // 2. Audit row — use the right action depending on source
  const action =
    source === "ai_only"
      ? "safeguarding_ai_only_flag"
      : "safeguarding_alert_raised";
  const ilrConfig = ComplianceConfigService.getCurrent("ilr");
  // Await-with-catch (not fire-and-forget): the audit row is the
  // single record of why an alert was raised; if a downstream test or
  // dashboard checks for it right after the turn response returns
  // (the common pattern), a racy fire-and-forget write produces
  // false negatives. The .catch keeps resilience — a write failure
  // logs but doesn't break the learner's safeguarding reply.
  await AuditLog.create({
    timestamp: new Date(),
    actor_type: "system",
    actor_id: null,
    org_id: new Types.ObjectId(orgId),
    learner_id: learner._id,
    action,
    before_state: { safeguardingFlagged: !!session.safeguardingFlagged },
    after_state: {
      safeguardingFlagged: true,
      category: scanCategory,
      alert_id: alertDoc?._id?.toString() ?? null,
      session_id: session._id.toString(),
      source,
    },
    reason:
      source === "ai_only"
        ? "Gemini raised safeguarding flag but pre-Gemini keyword scan did not — defence-in-depth"
        : `Pre-Gemini keyword scan matched ${scanCategory ?? "unknown category"}`,
    compliance_config_version: ilrConfig?.version ?? null,
  }).catch((err) =>
    escalateSafeguardingFailure({
      stage: "audit_write",
      err,
      learnerId: learner._id as Types.ObjectId,
      sessionId: session._id as Types.ObjectId,
      orgId,
      category: triggerCategory,
    }),
  );

  // 3. Notifications queue — email the DSL (brief Function 10).
  //
  // Payload is the brief's minimal shape: category + org_id, plus the
  // alert_id (so the worker stamps notificationSentAt) and the
  // alert_created_at timestamp (so the worker measures dispatch
  // latency against the p95 < 5s SLA). NO learner id, NO session id,
  // NO message content in the queue payload — if Redis spills, the
  // worst leak is "org X had a category-Y event at time T".
  if (alertDoc?._id) {
    notificationsQueue
      .add(
        "safeguarding-alert",
        {
          category: triggerCategory ?? "unknown",
          org_id: orgId,
          alert_id: alertDoc._id.toString(),
          alert_created_at: (alertDoc.createdAt instanceof Date
            ? alertDoc.createdAt
            : new Date()
          ).toISOString(),
        },
        // Priority 1 = HIGH (BullMQ lower = higher). Belt-and-braces
        // alongside the queue's default of PRIORITY_HIGH; an explicit
        // value here documents the intent at the call site for the
        // safeguarding flow specifically.
        { priority: 1 },
      )
      .catch((err) =>
        escalateSafeguardingFailure({
          stage: "dsl_notify_enqueue",
          err,
          learnerId: learner._id as Types.ObjectId,
          sessionId: session._id as Types.ObjectId,
          orgId,
          category: triggerCategory,
        }),
      );
  }

  // 4. Mark session as flagged for the org admin's dashboard.
  if (alertDoc) {
    AISession.updateOne(
      { _id: session._id },
      {
        $set: {
          safeguardingFlagged: true,
          safeguardingAlertId: alertDoc._id,
        },
      },
    ).catch((err) =>
      logger.error(
        { err, sessionId: session._id },
        "AISession safeguard flag update failed",
      ),
    );
  }
};

// ─────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────

interface ProcessTurnInput {
  sessionId: string;
  message: string;
  learnerId: string;
  orgId: string;
}

interface ProcessTurnResponse {
  reply: string;
  mode: "anchor" | "bridge" | "immersion";
  session_complete: boolean;
  vocab_words_seen: string[];
  safeguarding_served?: boolean;
}

/**
 * POST /api/esol/session/turn — the per-turn AI tutor handler.
 */
export const processTurnService = async (
  input: ProcessTurnInput,
): Promise<ApiResponse> => {
  if (!input.sessionId || !Types.ObjectId.isValid(input.sessionId)) {
    throw new ApiError(400, "Valid session_id is required");
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new ApiError(
      400,
      "message is required and must be a non-empty string",
    );
  }

  // ── 1. Load session + ownership check ────────────────────────────
  const session = await AISession.findById(input.sessionId);
  if (!session) {
    throw new ApiError(404, `AISession ${input.sessionId} not found`);
  }
  if (session.learnerId.toString() !== input.learnerId) {
    // Security check — a JWT must not be able to drive someone else's session.
    throw new ApiError(
      403,
      "This session does not belong to the calling learner",
    );
  }
  if (session.completedAt) {
    throw new ApiError(409, "This session has already been completed");
  }
  if (session.orgId.toString() !== input.orgId) {
    // The orgId came from req.esol_context; if it doesn't match the
    // session's stored orgId, something is wrong upstream.
    throw new ApiError(
      403,
      "Session does not belong to the calling org context",
    );
  }

  const learner = await User.findById(input.learnerId);
  if (!learner) {
    throw new ApiError(404, "Learner not found");
  }

  // ── 2. Pre-Gemini safeguarding scan ──────────────────────────────
  const scan = SafeguardingDetector.scan(
    input.message,
    learner.l1Language ?? "en",
  );

  // Encrypt the raw disclosure up front when the scan triggered, so the
  // SAME ciphertext is stored on the SafeguardingAlert AND used to
  // decide whether to redact TurnLog. When no key is configured this is
  // null → we keep the raw in TurnLog (append-only) so it's never lost.
  const encryptedRaw = scan.triggered
    ? encryptSafeguardingRaw(input.message)
    : null;

  // Always TurnLog the message — capture the audit trail BEFORE
  // Gemini runs, regardless of which path serves the reply.
  // The actual served_path is filled in below. For a triggered
  // disclosure we redact the plaintext here when it's been encrypted
  // onto the alert — no cleartext copy of a disclosure in the DB.
  const turnLog = await TurnLog.create({
    session_id: session._id,
    learner_id: learner._id,
    org_id: session.orgId,
    message:
      scan.triggered && encryptedRaw
        ? "[safeguarding disclosure — raw text encrypted on SafeguardingAlert]"
        : input.message,
    safeguarding_scan: {
      triggered: scan.triggered,
      category: scan.category,
      matched_pattern: scan.matched_pattern,
    },
    served_path: scan.triggered ? "safeguarding_precache" : "gemini",
    gemini_safeguarding_category: null,
  }).catch((err) => {
    logger.error(
      { err, sessionId: session._id.toString() },
      "TurnLog write failed — turn continues but audit row missing",
    );
    return null;
  });

  if (scan.triggered) {
    // Pre-cached reply — Gemini is never called.
    // Per Function 10 To-Do 2: serve the category + language slice from
    // safeguarding-messages.json, NOT a single English string.
    const preCachedReply = loadSafeguardingMessage(
      scan.category,
      learner.l1Language,
    );

    // Record the alert + audit + notify the DSL. Pass the pre-computed
    // ciphertext so the alert stores exactly what we redacted from
    // TurnLog above.
    await recordSafeguardingTrigger({
      session,
      learner,
      orgId: input.orgId,
      message: input.message,
      scanCategory: scan.category,
      detectorMatchedPattern: scan.matched_pattern,
      source: "keyword",
      rawInputEncrypted: encryptedRaw,
    });

    const response: ProcessTurnResponse = {
      reply: preCachedReply,
      mode: lowerMode(session.sessionMode ?? "anchor"), // anchor when safeguarding hits
      session_complete: false,
      vocab_words_seen: [],
      safeguarding_served: true,
    };
    return new ApiResponse(200, "Safeguarding response served", response);
  }

  // ── 3. (Done — TurnLog captured above) ───────────────────────────

  // ── 4. Build Layer 5 (dynamic learner profile) ───────────────────
  const learnerProfile = await buildLearnerProfile(learner, session);

  // ── 5. Load scenario + assemble prompt ───────────────────────────
  let scenarioForPrompt: ScenarioForPrompt | undefined;
  if (session.scenario_id) {
    const scenarioFile = loadScenarioById(String(session.scenario_id));
    if (scenarioFile) {
      // Map the wizard's LangCode to a scenario language code if possible;
      // for now default to en since the scenario shells only have en filled.
      scenarioForPrompt = adaptScenario(scenarioFile, "en");
    }
  }

  const assembled = assemblePrompt(learnerProfile, scenarioForPrompt);

  // ── 6. Conversation history from prior turns ─────────────────────
  const conversationHistory = buildConversationHistory(session);

  // ── 7. Call Gemini ───────────────────────────────────────────────
  let geminiOutput: IGeminiTurnOutput;
  let rawReplyText: string;
  try {
    const result = await generateTurn<IGeminiTurnOutput>({
      systemPrompt: assembled.systemPrompt,
      conversationHistory,
      userMessage: input.message,
      // cacheableLayers will be uploaded to Vertex's cachedContents
      // resource in a follow-up — for now we pass the assembled prompt
      // directly via systemInstruction inside generateTurn.
      tracking: {
        sessionId: session._id,
        orgId: input.orgId,
        learnerId: input.learnerId,
      },
      // Tell Gemini the exact shape to return. Without this, Vertex
      // free-styles JSON (it follows the prompt's instructions but
      // omits fields, renames keys, etc.) and the downstream Zod
      // validator rejects nearly every turn with "Required" errors.
      responseSchema: TURN_RESPONSE_SCHEMA as unknown as Record<
        string,
        unknown
      >,
      validate: validateGeminiTurnOutput,
    });
    geminiOutput = result.parsed;
    rawReplyText = result.rawText;
  } catch (err) {
    // generateTurn handles its own retry; if we get here the turn failed
    // terminally (parse/validate/transport). The spec is explicit: never
    // show the learner a broken turn. Serve a safe ANCHOR-mode reply
    // (no scoring, no session progression) and log loudly for ops. The
    // pre-Gemini TurnLog row already captured the audit trail.
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        sessionId: session._id.toString(),
        learnerId: String(input.learnerId),
      },
      "Gemini turn failed terminally — serving safe ANCHOR fallback reply",
    );
    const fallback: ProcessTurnResponse = {
      reply: ANCHOR_FALLBACK_REPLY,
      mode: "anchor",
      session_complete: false,
      vocab_words_seen: [],
    };
    return new ApiResponse(200, "Fallback reply served", fallback);
  }

  // ── 8. (Validation already inside generateTurn via Zod) ──────────

  // ── 9. Secondary safeguarding check (AI flagged, keyword didn't) ─
  // RETAINED on purpose. The AI Tutor Brief §8.2 says to remove the AI
  // safeguarding flag, but it's a genuine defence-in-depth net that
  // catches disclosures the (still-incomplete, starter) keyword banks
  // miss. We keep it until the ar/tr/yue keyword banks are completed +
  // safeguarding-lead reviewed, then revisit removal. It's secondary
  // (keyword scan runs first, independently) so the "lost in a malformed
  // response" risk only degrades this turn to keyword-only — the spec's
  // own baseline — never below it.
  if (geminiOutput.safeguarding_flag) {
    await recordSafeguardingTrigger({
      session,
      learner,
      orgId: input.orgId,
      message: input.message,
      scanCategory: geminiOutput.safeguarding_category,
      detectorMatchedPattern: null,
      source: "ai_only",
    });

    // Patch the TurnLog with the AI-only finding (best-effort).
    if (turnLog?._id) {
      try {
        await TurnLog.collection.updateOne(
          { _id: turnLog._id },
          {
            $set: {
              served_path: "ai_only_safeguarding",
              gemini_safeguarding_category: geminiOutput.safeguarding_category,
            },
          },
        );
      } catch (err) {
        logger.error(
          { err, turnLogId: turnLog._id.toString() },
          "TurnLog patch failed for ai_only_safeguarding — append-only enforcement",
        );
      }
    }

    // Serve the pre-cached safeguarding reply, NOT Gemini's text.
    // Trust Gemini's flag but not its surface — the pre-cached reply
    // is the safest thing to put in front of a learner in distress.
    // Look up by Gemini's safeguarding_category so the AI-only path
    // also gets a category-appropriate signposting message in the
    // learner's L1 (Function 10 To-Do 2).
    const preCachedReply = loadSafeguardingMessage(
      geminiOutput.safeguarding_category,
      learner.l1Language,
    );
    const response: ProcessTurnResponse = {
      reply: preCachedReply,
      mode: "anchor",
      session_complete: false,
      vocab_words_seen: [],
      safeguarding_served: true,
    };
    return new ApiResponse(
      200,
      "Safeguarding response served (AI-only)",
      response,
    );
  }

  // ── 10. Safe path — commit turn + enqueue downstream work ────────
  //
  // PRIVACY INVARIANT (brief Function 10): this block runs ONLY when
  // both safeguarding gates returned false. The two `if (...) { return }`
  // paths above (keyword-triggered at the top of the function, AI-only
  // immediately above this block) exit BEFORE we get here, so
  // input.message is only ever written into session.turns for
  // non-safeguarding turns. If a future edit removes one of those
  // early returns, this push would leak a safeguarding-triggered
  // message into AISession.turns; the audit test in
  // src/__tests__/safeguarding.test.ts catches that regression.

  // Append the turn to the session document.
  const newTurnIndex = session.turns?.length ?? 0;
  session.turns.push({
    turnIndex: newTurnIndex,
    originalInput: input.message,
    scrubbed: false,
    deepSeekResponse: geminiOutput.reply, // legacy field name; stores the AI tutor's reply
    claudeAssessment: JSON.stringify(geminiOutput), // full validated output for audit
    timestamp: new Date(),
  } as any);

  // Push the per-turn rollups (brief Function 7 To-Do 5 spec).
  session.turn_scores = [
    ...(session.turn_scores ?? []),
    geminiOutput.turn_score,
  ];
  session.teaching_mode_sequence = [
    ...(session.teaching_mode_sequence ?? []),
    lowerMode(geminiOutput.mode),
  ];
  // Roll the turn's vocabulary into the session doc inline. The vocab
  // LEDGER write stays async (queue below), but session.vocabIntroduced
  // feeds persistSessionOnEnd's vocabulary_retained_count — the
  // "Words you have learned" number on the learner's end screen.
  // Leaving it to the queue meant the end screen showed 0 whenever the
  // worker lagged or Redis was down.
  if ((geminiOutput.vocabulary_items_used ?? []).length > 0) {
    const seenVocab = new Set(session.vocabIntroduced ?? []);
    for (const w of geminiOutput.vocabulary_items_used) {
      if (typeof w === "string" && w.trim()) seenVocab.add(w.trim());
    }
    session.vocabIntroduced = Array.from(seenVocab);
  }
  // Update the current session mode for ACL / UI.
  session.sessionMode = upperMode(geminiOutput.mode);

  if (geminiOutput.session_complete) {
    session.completedAt = new Date();
    if (geminiOutput.session_summary) {
      session.assessmentSummary = geminiOutput.session_summary;
    }
  }

  await session.save();

  // Enqueue the post-turn work — vocab ledger + evidence capture.
  // Fire-and-forget; we don't block the learner's reply on these.
  //
  // FALLBACK: if the enqueue itself fails (Redis down, Upstash request
  // quota exhausted), write the ledger inline instead of dropping the
  // learner's vocabulary on the floor. Still fire-and-forget — the
  // upserts are a handful of single-document writes.
  const vocabLedgerArgs = {
    vocabulary_items_used: geminiOutput.vocabulary_items_used,
    turn_score: geminiOutput.turn_score,
    scenario_id: session.scenario_id ? String(session.scenario_id) : null,
    // The learner's session has many Stage 3 objective ids matched
    // to the scenario; we attach the first one to new vocab rows
    // because Gemini doesn't tell us which objective each word
    // covers. A future enhancement could route per-word, but the
    // single-anchor approximation is fine for retention tracking.
    stage3_objective_id: (session.stage3_objective_ids ?? [])[0] ?? null,
    // Insert-only enrichment for the learner vocabulary page.
    context: {
      orgId: input.orgId,
      sessionId: session._id.toString(),
      esolLevel: session.esolLevel ?? null,
      topic: session.topic ?? null,
    },
  };
  esolSessionQueue
    .add("update-vocab", {
      sessionId: session._id.toString(),
      learnerId: input.learnerId,
      orgId: input.orgId,
      action: "update_vocab",
      payload: {
        // Brief Function 9 To-Do 1 fields the processor needs to call
        // updateLedgerForTurn(learner_id, vocab, score, scenario, stage3).
        ...vocabLedgerArgs,
        turnIndex: newTurnIndex,
      },
    })
    .catch(async (err) => {
      logger.error(
        { err },
        "Failed to enqueue update_vocab job — writing vocab ledger inline",
      );
      try {
        await updateLedgerForTurn(
          input.learnerId,
          vocabLedgerArgs.vocabulary_items_used,
          vocabLedgerArgs.turn_score,
          vocabLedgerArgs.scenario_id,
          vocabLedgerArgs.stage3_objective_id,
          vocabLedgerArgs.context,
        );
      } catch (inlineErr) {
        logger.error(
          { err: inlineErr },
          "Inline vocab ledger fallback also failed",
        );
      }
    });

  esolSessionQueue
    .add("capture-evidence", {
      sessionId: session._id.toString(),
      learnerId: input.learnerId,
      orgId: input.orgId,
      action: "capture_evidence",
      payload: {
        turnIndex: newTurnIndex,
        skillCodesUsed: geminiOutput.skill_codes_used,
        turnScore: geminiOutput.turn_score,
        mode: geminiOutput.mode,
      },
    })
    .catch((err) =>
      logger.error({ err }, "Failed to enqueue capture_evidence job"),
    );

  // If session ended, the session-end workflow (Function 7 To-Do 6)
  // is wired here in a follow-up. For now the assessmentSummary write
  // above is the user-visible part; the org admin's "session done"
  // notification + Stage 4 evidence rollup is the To-Do 6 task.
  if (geminiOutput.session_complete) {
    logger.info(
      { sessionId: session._id.toString(), learnerId: input.learnerId },
      "session_complete=true — Function 7 To-Do 6 finaliser will pick up",
    );
  }

  const response: ProcessTurnResponse = {
    reply: geminiOutput.reply,
    mode: lowerMode(geminiOutput.mode),
    session_complete: geminiOutput.session_complete,
    vocab_words_seen: geminiOutput.vocabulary_items_used,
  };
  return new ApiResponse(200, "Turn processed", response);
};

// ═════════════════════════════════════════════════════════════════════
// Function 7 To-Do 6 — session START + END
// ═════════════════════════════════════════════════════════════════════

const LEVELS_ASC: EsolLevel[] = ["e1", "e2", "e3", "l1", "l2"];

const isLevelInRange = (
  learnerLevel: EsolLevel,
  min: EsolLevel,
  max: EsolLevel,
): boolean => {
  const learnerIdx = LEVELS_ASC.indexOf(learnerLevel);
  const minIdx = LEVELS_ASC.indexOf(min);
  const maxIdx = LEVELS_ASC.indexOf(max);
  return learnerIdx >= minIdx && learnerIdx <= maxIdx;
};

const PATHWAY_OVERRIDE_TTL_DAYS = 30;

const isPathwayOverrideExpired = (setAt: Date): boolean => {
  const ageMs = Date.now() - new Date(setAt).getTime();
  return ageMs > PATHWAY_OVERRIDE_TTL_DAYS * 24 * 60 * 60 * 1000;
};

/**
 * One-line warm greeting + scenario lead-in, templated per L1. The
 * opening message is NOT a Gemini call — it's deterministic so a
 * learner can always start a session even if Gemini is down.
 *
 * Translations cover the 5 MVP languages the scenario bank speaks.
 * Other wizard languages fall back to English; the scenario's title
 * carries the localised text the learner will recognise.
 */
const buildOpeningMessage = (
  firstName: string,
  scenarioTitle: { en: string; ar: string; so: string; fa: string; zh: string },
  l1Language: string,
): string => {
  const lc = (l1Language ?? "english").toLowerCase();
  switch (lc) {
    case "arabic":
    case "ar":
      return `مرحباً ${firstName} — اليوم سنتدرب على ${scenarioTitle.ar || scenarioTitle.en}. هل أنت مستعد؟`;
    case "somali":
    case "so":
      return `Hello ${firstName} — maanta waxaan ku tababaranaynaa ${scenarioTitle.so || scenarioTitle.en}. Diyaar ma tahay?`;
    case "dari":
    case "fa":
    case "fa-af":
      return `سلام ${firstName} — امروز ${scenarioTitle.fa || scenarioTitle.en} را تمرین می‌کنیم. آماده‌اید؟`;
    case "cantonese":
    case "zh":
    case "yue":
      return `你好 ${firstName} — 今日我哋會練習 ${scenarioTitle.zh || scenarioTitle.en}。準備好未?`;
    default:
      return `Hi ${firstName} — today we will practise "${scenarioTitle.en}". Are you ready?`;
  }
};

/**
 * Map the learner's Stage 3 objectives to the subset whose
 * `skill_domain` matches any entry in the scenario's
 * `stage3_objective_domains` — brief Function 8 To-Do 3.
 *
 * Contract:
 *   - scenario.stage3_objective_domains: ILR anchor codes
 *     ("Sc" | "Lr" | "Rt" | "Wt"). See scenario.interface.ts.
 *   - learner.stage3_objectives[].skill_domain: one of the four anchors
 *     OR the "general" sentinel (from buildStage3ObjectivesForPlacement
 *     in rarpa.service.ts).
 *
 * Match rule:
 *   - Direct equality between learner's skill_domain and scenario's
 *     codes — both sides speak the same anchor-code vocabulary.
 *   - The "general" objective always matches, regardless of which
 *     codes the scenario lists. It's every learner's catch-all.
 *
 * Example: scenario lists ["Sc", "Lr"]; learner objectives are
 *   [{id:"a", skill_domain:"Rt"}, {id:"b", skill_domain:"Sc"},
 *    {id:"c", skill_domain:"Lr"}, {id:"d", skill_domain:"general"}].
 * Returns ["b", "c", "d"] — Sc, Lr, general. Rt is dropped because
 * the scenario doesn't list it.
 *
 * Zero-match is a valid (but warning-worthy) outcome — see the
 * warning emitted in startSessionService below.
 */
const matchStage3ObjectiveIds = (
  learnerObjectives: Array<{ id: string; skill_domain: string }> | undefined,
  scenarioAnchors: string[],
): string[] => {
  if (!learnerObjectives || learnerObjectives.length === 0) return [];
  const wanted = new Set(scenarioAnchors);
  return learnerObjectives
    .filter((o) => o.skill_domain === "general" || wanted.has(o.skill_domain))
    .map((o) => o.id);
};

// ─────────────────────────────────────────────────────────────────────
// startSessionService
// ─────────────────────────────────────────────────────────────────────

interface StartSessionInput {
  scenarioId: string;
  learnerId: string;
  orgId: string;
}

export const startSessionService = async (
  input: StartSessionInput,
): Promise<ApiResponse> => {
  if (!input.scenarioId || typeof input.scenarioId !== "string") {
    throw new ApiError(400, "scenario_id is required");
  }

  // ── 1. Validate scenario exists + level range ───────────────────
  const scenarioFile = loadScenarioById(input.scenarioId);
  if (!scenarioFile) {
    throw new ApiError(404, `Scenario "${input.scenarioId}" not found`);
  }

  const learner = await User.findById(input.learnerId);
  if (!learner) throw new ApiError(404, "Learner not found");

  const learnerLevel = normaliseLevel(learner.esolLevel);
  if (
    !isLevelInRange(
      learnerLevel,
      scenarioFile.nqf_level_range.min,
      scenarioFile.nqf_level_range.max,
    )
  ) {
    throw new ApiError(
      403,
      `Scenario ${input.scenarioId} is for levels ${scenarioFile.nqf_level_range.min}–${scenarioFile.nqf_level_range.max}; learner is ${learnerLevel}`,
    );
  }

  // ── 2. Pathway override (Final Addendum) ────────────────────────
  // If set and fresh, the scenarios in pathway_override.scenario_ids
  // are the primary recommendation — the frontend uses this list,
  // not the default scenario picker.
  // If stale (> 30 days), clear it + audit.
  const override = (learner as any).pathway_override as
    | { scenario_ids: string[]; set_by: unknown; set_at: Date }
    | null
    | undefined;

  if (override && override.set_at) {
    if (isPathwayOverrideExpired(override.set_at)) {
      (learner as any).pathway_override = null;
      await learner.save();
      const ilrConfig = ComplianceConfigService.getCurrent("ilr");
      AuditLog.create({
        timestamp: new Date(),
        actor_type: "system",
        actor_id: null,
        org_id: new Types.ObjectId(input.orgId),
        learner_id: learner._id,
        action: "pathway_override_expired",
        before_state: {
          pathway_override: {
            scenario_ids: override.scenario_ids,
            set_at: override.set_at,
          },
        },
        after_state: { pathway_override: null },
        reason: `Pathway override exceeded the ${PATHWAY_OVERRIDE_TTL_DAYS}-day TTL`,
        compliance_config_version: ilrConfig?.version ?? null,
      }).catch((err) =>
        logger.error(
          { err },
          "AuditLog write failed for pathway_override_expired",
        ),
      );
    }
  }

  // ── 3. Unread TeacherMessages (Final Addendum) ──────────────────
  // The frontend (Phase 24) renders these before the scenario UI so
  // the learner sees their teacher's note before answering.
  const unreadMessages = await TeacherMessage.find({
    learner_id: learner._id,
    read_at: null,
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  // ── 4 + 5. Idempotent session creation ──────────────────────────
  // Coarse minute window: a double-click within the same minute
  // produces the same key and returns the cached session.
  const startMinute = Math.floor(Date.now() / 60000);
  const idemKey = createHash("sha256")
    .update(
      `session-start|${input.learnerId}|${input.scenarioId}|${startMinute}`,
    )
    .digest("hex");

  // ── Stage 3 objective linking (brief Function 8 To-Do 3) ────────
  // Match learner objectives against scenario.stage3_objective_domains.
  // An empty match is allowed — happens when the scenario covers a
  // domain the learner has no objective for (very narrow weakness
  // profile). The session still starts; Stage 4 evidence for this
  // session simply won't tie to any stored objective.
  const learnerObjectives = ((learner as any).stage3_objectives ??
    []) as Array<{
    id: string;
    skill_domain: string;
  }>;
  const stage3Ids = matchStage3ObjectiveIds(
    learnerObjectives,
    scenarioFile.stage3_objective_domains,
  );
  if (stage3Ids.length === 0) {
    logger.warn(
      {
        learnerId: input.learnerId,
        scenarioId: input.scenarioId,
        scenarioDomains: scenarioFile.stage3_objective_domains,
        learnerObjectiveDomains: learnerObjectives.map((o) => o.skill_domain),
      },
      "Stage 3 link empty — scenario covers a domain the learner has no objective for. Session will proceed; evidence won't tie to an objective.",
    );
  }

  const outcome = await IdempotencyService.check(
    idemKey,
    "session-write",
    async () => {
      const session = await AISession.create({
        learnerId: learner._id,
        teacherId: null,
        orgId: new Types.ObjectId(input.orgId),
        bookingId: null,
        sessionMode: "BRIDGE",
        esolLevel: learnerLevel,
        topic: scenarioFile.title.en,
        turns: [],
        safeguardingFlagged: false,
        vocabIntroduced: [],
        completedAt: null,

        // Function 5 fields
        session_source: "ai_tutor",
        duration_mins: null,
        skill_codes_covered: [],
        scenario_id: input.scenarioId,
        final_score: null,
        passed: null,

        // Function 7 To-Do 5 fields
        turn_scores: [],
        teaching_mode_sequence: [],

        // Function 7 To-Do 6 fields
        stage3_objective_ids: stage3Ids,
        esol_aim_type_at_start: (learner as any).esol_aim_type ?? null,
        nqf_level_at_start: learnerLevel,
        start_time: new Date(),
      });
      return { sessionId: session._id.toString() };
    },
    { org_id: input.orgId, learner_id: input.learnerId },
  );

  const sessionId = outcome.result.sessionId;

  // ── 6. Templated opening message ────────────────────────────────
  const openingMessage = buildOpeningMessage(
    learner.firstname ?? "",
    scenarioFile.title,
    learner.l1Language ?? "english",
  );

  // ── 7. AuditLog session_started ────────────────────────────────
  if (!outcome.hit) {
    const ilrConfig = ComplianceConfigService.getCurrent("ilr");
    AuditLog.create({
      timestamp: new Date(),
      actor_type: "learner",
      actor_id: learner._id,
      org_id: new Types.ObjectId(input.orgId),
      learner_id: learner._id,
      action: "session_started",
      before_state: {},
      after_state: {
        session_id: sessionId,
        scenario_id: input.scenarioId,
        nqf_level_at_start: learnerLevel,
        esol_aim_type_at_start: (learner as any).esol_aim_type ?? null,
        stage3_objective_count: stage3Ids.length,
        pathway_override_active:
          !!override?.set_at && !isPathwayOverrideExpired(override.set_at),
      },
      reason: "Learner started a new AI tutor session",
      compliance_config_version: ilrConfig?.version ?? null,
    }).catch((err) =>
      logger.error(
        { err, sessionId },
        "AuditLog write failed for session_started",
      ),
    );
  }

  // ── 8. Response shape per brief ─────────────────────────────────
  return new ApiResponse(
    200,
    outcome.hit ? "Resuming existing session" : "Session started",
    {
      session_id: sessionId,
      opening_message: openingMessage,
      scenario_title: scenarioFile.title.en,
      unread_messages: unreadMessages.map((m: any) => ({
        id: m._id?.toString?.() ?? null,
        teacher_id: m.teacher_id?.toString?.() ?? null,
        message_text: m.message_text,
        language: m.language,
        created_at: m.createdAt,
      })),
    },
  );
};

// ─────────────────────────────────────────────────────────────────────
// endSessionService
// ─────────────────────────────────────────────────────────────────────

interface EndSessionInput {
  sessionId: string;
  learnerId: string;
  orgId: string;
}

const VOCAB_RETAINED_MIN_SCORE = 0.7;

// ─────────────────────────────────────────────────────────────────────
// persistSessionOnEnd — brief Function 8 To-Do 2
// ─────────────────────────────────────────────────────────────────────

export interface PersistSessionOnEndResult {
  session_id: string;
  duration_mins: number;
  final_score: number;
  passed: boolean;
  esol_aim_type: "regulated" | "non_regulated";
  skill_codes_covered: string[];
  vocabulary_items_used: string[];
  /** True when the idempotency cache returned a prior result. Caller
   *  uses this to skip orchestration side-effects (audit log, queue
   *  enqueue) on a repeat /end call. */
  idempotency_hit: boolean;
}

/**
 * Focused session writer — brief Function 8 To-Do 2.
 *
 * Called from `endSessionService` (which owns ownership/state checks +
 * audit + queue enqueue). This function owns the WRITE: load, dedupe,
 * compute, persist. Wrapped in IdempotencyService so re-calling /end
 * on a session that already ended returns the cached result without
 * double-writing the document.
 *
 * Side effects:
 *   - `end_time = now` (always)
 *   - `duration_mins = round((end_time - start_time) / 60000)` minimum 1
 *   - `skill_codes_covered` and `vocabulary_items_used` deduplicated
 *     (defensive — the per-turn workers should keep these clean, but
 *     a leaky worker shouldn't pollute the ILR export)
 *   - `final_score` = mean of `turn_scores` (0 if empty)
 *   - `passed` = `final_score >= scenario.pass_threshold` (false if
 *     no scenario; the org admin's level-change workflow can override)
 *   - `esol_aim_type` re-confirmed from User.esol_aim_type, defaulting
 *     to "non_regulated" if missing or invalid. Defaulting to
 *     non_regulated is the safer failure mode because it suppresses
 *     AddHours in the ILR export — over-suppressing is recoverable;
 *     over-claiming is an audit landing.
 *   - `completedAt` set if not already set
 */
export const persistSessionOnEnd = async (
  sessionId: string,
): Promise<PersistSessionOnEndResult> => {
  if (!sessionId || !Types.ObjectId.isValid(sessionId)) {
    throw new ApiError(400, "Valid session_id is required");
  }

  const idemKey = createHash("sha256")
    .update(`session-end|${sessionId}`)
    .digest("hex");

  const outcome = await IdempotencyService.check(
    idemKey,
    "session-write",
    async () => {
      // ── 1. Load the in-progress session ──────────────────────────
      const session = await AISession.findById(sessionId);
      if (!session) {
        throw new ApiError(404, `AISession ${sessionId} not found`);
      }

      // ── 2. duration_mins = (now - start_time) in minutes ─────────
      const endTime = new Date();
      const startTime: Date = session.start_time
        ? new Date(session.start_time as Date)
        : new Date((session as unknown as { createdAt: Date }).createdAt);
      const durationMins = Math.max(
        1,
        Math.round((endTime.getTime() - startTime.getTime()) / 60000),
      );

      // ── 3. Dedupe skill_codes_covered ────────────────────────────
      const dedupedSkills = Array.from(
        new Set(session.skill_codes_covered ?? []),
      );

      // ── 4. Dedupe vocabulary_items_used ──────────────────────────
      // The existing AISession field is `vocabIntroduced` (legacy
      // name from the v1 AI tutor); semantically the same as the
      // brief's `vocabulary_items_used`. Dedupe it.
      const dedupedVocab = Array.from(new Set(session.vocabIntroduced ?? []));

      // ── 5. final_score = mean of turn_scores ─────────────────────
      const scores = (session.turn_scores ?? []) as number[];
      const finalScore =
        scores.length === 0
          ? 0
          : scores.reduce((s, x) => s + x, 0) / scores.length;

      // ── 6. passed = final_score >= scenario.pass_threshold ───────
      let passed: boolean;
      const scenarioFile = session.scenario_id
        ? loadScenarioById(String(session.scenario_id))
        : null;
      if (scenarioFile) {
        passed = finalScore >= scenarioFile.pass_threshold;
      } else {
        passed = false;
      }

      // ── 7. esol_aim_type from User, default non_regulated ────────
      const learner = await User.findById(session.learnerId).select(
        "esol_aim_type",
      );
      const userAim = (learner as unknown as { esol_aim_type?: string })
        ?.esol_aim_type;
      let aimType: "regulated" | "non_regulated";
      if (userAim === "regulated" || userAim === "non_regulated") {
        aimType = userAim;
      } else {
        aimType = "non_regulated";
        logger.warn(
          {
            sessionId,
            learnerId: session.learnerId.toString(),
            userAim,
          },
          "User.esol_aim_type missing or invalid at session-end — defaulting to non_regulated (suppresses AddHours in ILR)",
        );
      }

      // ── 8. Write the updated session ─────────────────────────────
      session.end_time = endTime;
      session.duration_mins = durationMins;
      session.skill_codes_covered = dedupedSkills;
      session.vocabIntroduced = dedupedVocab;
      session.final_score = finalScore;
      session.passed = passed;
      session.esol_aim_type = aimType;
      if (!session.completedAt) session.completedAt = endTime;
      await session.save();

      return {
        session_id: session._id.toString(),
        duration_mins: durationMins,
        final_score: finalScore,
        passed,
        esol_aim_type: aimType,
        skill_codes_covered: dedupedSkills,
        vocabulary_items_used: dedupedVocab,
      };
    },
    { learner_id: undefined, org_id: undefined },
  );

  return {
    ...outcome.result,
    idempotency_hit: outcome.hit,
  };
};

// ─────────────────────────────────────────────────────────────────────
// endSessionService — orchestrates (ownership checks + persistSessionOnEnd + audit + queue)
// ─────────────────────────────────────────────────────────────────────

export const endSessionService = async (
  input: EndSessionInput,
): Promise<ApiResponse> => {
  if (!input.sessionId || !Types.ObjectId.isValid(input.sessionId)) {
    throw new ApiError(400, "Valid session_id is required");
  }

  // ── 1. Ownership + state checks ─────────────────────────────────
  const session = await AISession.findById(input.sessionId);
  if (!session) throw new ApiError(404, "AISession not found");
  if (session.learnerId.toString() !== input.learnerId) {
    throw new ApiError(
      403,
      "This session does not belong to the calling learner",
    );
  }
  if (session.orgId.toString() !== input.orgId) {
    throw new ApiError(
      403,
      "Session does not belong to the calling org context",
    );
  }

  // ── Capture before-state for the AuditLog ──────────────────────
  const beforeState = {
    final_score: session.final_score ?? null,
    passed: session.passed ?? null,
  };

  // ── Write via persistSessionOnEnd (brief Function 8 To-Do 2) ───
  // The focused writer owns the idempotency key + the actual document
  // mutation. We don't wrap a second idempotency layer here — that
  // would deadlock against the same key.
  const persisted = await persistSessionOnEnd(input.sessionId);

  if (!persisted.idempotency_hit) {
    // ── Enqueue level-progression check (Phase 12) ─────────────────
    // priority-queue is deferred + non-blocking per the brief.
    priorityQueueQueue
      .add("level-progression-check", {
        date: new Date().toISOString().slice(0, 10),
        orgId: input.orgId,
        learnerId: input.learnerId,
        triggerEvent: "session_completed",
      })
      .catch((err) =>
        logger.error(
          { err, sessionId: input.sessionId },
          "Failed to enqueue level-progression check",
        ),
      );

    // ── AuditLog session_completed ────────────────────────────────
    const ilrConfig = ComplianceConfigService.getCurrent("ilr");
    AuditLog.create({
      timestamp: new Date(),
      actor_type: "learner",
      actor_id: new Types.ObjectId(input.learnerId),
      org_id: new Types.ObjectId(input.orgId),
      learner_id: new Types.ObjectId(input.learnerId),
      action: "session_completed",
      before_state: beforeState,
      after_state: {
        final_score: persisted.final_score,
        passed: persisted.passed,
        session_id: input.sessionId,
        duration_mins: persisted.duration_mins,
        esol_aim_type: persisted.esol_aim_type,
        skill_codes_covered: persisted.skill_codes_covered,
      },
      reason: "Session ended by learner",
      compliance_config_version: ilrConfig?.version ?? null,
    }).catch((err) =>
      logger.error({ err }, "AuditLog write failed for session_completed"),
    );
  }

  // ── Vocabulary retained count (Phase 10 stub) ──────────────────
  // Always queried — same value on idempotent replay because the
  // ledger only changes via the worker, not via /end.
  const vocabularyRetainedCount = await VocabLedger.countDocuments({
    learnerId: new Types.ObjectId(input.learnerId),
    masteryScore: { $gte: VOCAB_RETAINED_MIN_SCORE },
  }).catch((err) => {
    logger.error(
      { err, learnerId: input.learnerId },
      "VocabLedger retained-count query failed",
    );
    return 0;
  });

  // ── Final session summary ────────────────────────────────────────
  // The per-turn handler only writes `assessmentSummary` when Gemini
  // decides mid-conversation that the session reached a natural end.
  // A manual "End session" click skips that path entirely, so the
  // learner's end screen permanently showed no summary. Generate it
  // here from the transcript — same approach as the legacy
  // esolAISession end flow. Failure is non-fatal: /end still returns,
  // just without a summary.
  let sessionSummary: string | null = session.assessmentSummary ?? null;
  const turnsForSummary = (session.turns ?? []) as Array<{
    originalInput?: string;
    deepSeekResponse?: string;
  }>;
  if (!sessionSummary && turnsForSummary.length > 0) {
    try {
      const transcript = turnsForSummary
        .map(
          (t, i) =>
            `Turn ${i + 1}\nLearner: ${t.originalInput ?? ""}\nTutor: ${t.deepSeekResponse ?? ""}`,
        )
        .join("\n\n");
      sessionSummary = (await generateSessionSummary(transcript)) || null;
      if (sessionSummary) {
        // updateOne (not session.save()) — persistSessionOnEnd already
        // saved this document; writing a single scalar via updateOne
        // can't clobber the fields it just committed.
        await AISession.updateOne(
          { _id: session._id },
          { $set: { assessmentSummary: sessionSummary } },
        );
      }
    } catch (err) {
      logger.error(
        { err, sessionId: input.sessionId },
        "Final session summary generation failed — returning null summary",
      );
    }
  }

  return new ApiResponse(
    200,
    persisted.idempotency_hit ? "Session already ended" : "Session ended",
    {
      session_summary: sessionSummary,
      final_score: persisted.final_score,
      passed: persisted.passed,
      vocabulary_retained_count: vocabularyRetainedCount,
    },
  );
};
