import { readFileSync } from "fs";
import { resolve } from "path";
import { Types } from "mongoose";

import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import AISession from "../models/AISession";
import AuditLog from "../models/AuditLog";
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
import { generateTurn, ConversationTurn } from "./gemini.service";
import { validateGeminiTurnOutput } from "../utils/geminiOutputValidator";
import { IGeminiTurnOutput } from "../interfaces/geminiTurnOutput.interface";
import { EsolLevel } from "../interfaces/placementQuestion.interface";
import { IScenarioFile } from "../interfaces/scenario.interface";
import ComplianceConfigService from "./ComplianceConfigService";
import logger from "../config/logger";

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
      "Scenario file not found or unparseable — turn will use general-conversation prompt"
    );
    return null;
  }
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const NORMALISED_LEVELS: ReadonlySet<EsolLevel> = new Set<EsolLevel>([
  "e1", "e2", "e3", "l1", "l2",
]);

const normaliseLevel = (raw: unknown): EsolLevel => {
  if (typeof raw === "string") {
    const lc = raw.toLowerCase();
    if (NORMALISED_LEVELS.has(lc as EsolLevel)) return lc as EsolLevel;
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
  session: any
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
  const currentMode = seq.length > 0
    ? lowerMode(seq[seq.length - 1])
    : lowerMode(session.sessionMode ?? "bridge");

  return {
    esolLevel: normaliseLevel(learner.esolLevel),
    l1Language: learner.l1Language ?? "english",
    vocabularyToReinforce,
    recentSessionSummaries,
    skillWeaknessFlags: (learner.skillWeaknessFlags as string[] | undefined) ?? [],
    currentMode:
      currentMode === "anchor" ? "ANCHOR"
      : currentMode === "immersion" ? "IMMERSION"
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
  l1Code: string | undefined
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
    if (t.originalInput) history.push({ role: "user", content: t.originalInput });
    if (t.deepSeekResponse) history.push({ role: "model", content: t.deepSeekResponse });
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
  args: SafeguardingTriggerArgs
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
  const triggerCategory = mapCategoryToBankKey(scanCategory) ?? scanCategory ?? null;

  let alertDoc: any = null;
  try {
    alertDoc = await SafeguardingAlert.create({
      learnerId: learner._id,
      orgId: new Types.ObjectId(orgId),
      sessionId: session._id,
      alertLevel,
      messageContentHash,
      triggerCategory,
      triggerSource: source,
      status: "open",
    });
  } catch (err) {
    logger.error(
      { err, learnerId: learner._id, sessionId: session._id, source },
      "SafeguardingAlert creation failed — pre-cache reply still served"
    );
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
    logger.error({ err, source }, "AuditLog write failed for safeguarding trigger")
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
        { priority: 1 }
      )
      .catch((err) =>
        logger.error(
          { err, alert_id: alertDoc._id?.toString() },
          "Failed to enqueue safeguarding-alert notification"
        )
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
      }
    ).catch((err) =>
      logger.error({ err, sessionId: session._id }, "AISession safeguard flag update failed")
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
  input: ProcessTurnInput
): Promise<ApiResponse> => {
  if (!input.sessionId || !Types.ObjectId.isValid(input.sessionId)) {
    throw new ApiError(400, "Valid session_id is required");
  }
  if (typeof input.message !== "string" || input.message.trim() === "") {
    throw new ApiError(400, "message is required and must be a non-empty string");
  }

  // ── 1. Load session + ownership check ────────────────────────────
  const session = await AISession.findById(input.sessionId);
  if (!session) {
    throw new ApiError(404, `AISession ${input.sessionId} not found`);
  }
  if (session.learnerId.toString() !== input.learnerId) {
    // Security check — a JWT must not be able to drive someone else's session.
    throw new ApiError(403, "This session does not belong to the calling learner");
  }
  if (session.completedAt) {
    throw new ApiError(409, "This session has already been completed");
  }
  if (session.orgId.toString() !== input.orgId) {
    // The orgId came from req.esol_context; if it doesn't match the
    // session's stored orgId, something is wrong upstream.
    throw new ApiError(403, "Session does not belong to the calling org context");
  }

  const learner = await User.findById(input.learnerId);
  if (!learner) {
    throw new ApiError(404, "Learner not found");
  }

  // ── 2. Pre-Gemini safeguarding scan ──────────────────────────────
  const scan = SafeguardingDetector.scan(
    input.message,
    learner.l1Language ?? "en"
  );

  // Always TurnLog the message — capture the audit trail BEFORE
  // Gemini runs, regardless of which path serves the reply.
  // The actual served_path is filled in below.
  const turnLog = await TurnLog.create({
    session_id: session._id,
    learner_id: learner._id,
    org_id: session.orgId,
    message: input.message,
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
      "TurnLog write failed — turn continues but audit row missing"
    );
    return null;
  });

  if (scan.triggered) {
    // Pre-cached reply — Gemini is never called.
    // Per Function 10 To-Do 2: serve the category + language slice from
    // safeguarding-messages.json, NOT a single English string.
    const preCachedReply = loadSafeguardingMessage(
      scan.category,
      learner.l1Language
    );

    // Record the alert + audit + notify the DSL.
    await recordSafeguardingTrigger({
      session,
      learner,
      orgId: input.orgId,
      message: input.message,
      scanCategory: scan.category,
      detectorMatchedPattern: scan.matched_pattern,
      source: "keyword",
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
      validate: validateGeminiTurnOutput,
    });
    geminiOutput = result.parsed;
    rawReplyText = result.rawText;
  } catch (err) {
    // generateTurn handles its own retry; if we get here, the turn
    // failed terminally. Surface a 502.
    throw new ApiError(
      502,
      `Gemini turn failed: ${err instanceof Error ? err.message : "unknown error"}`
    );
  }

  // ── 8. (Validation already inside generateTurn via Zod) ──────────

  // ── 9. Secondary safeguarding check (AI flagged, keyword didn't) ─
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
          }
        );
      } catch (err) {
        logger.error(
          { err, turnLogId: turnLog._id.toString() },
          "TurnLog patch failed for ai_only_safeguarding — append-only enforcement"
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
      learner.l1Language
    );
    const response: ProcessTurnResponse = {
      reply: preCachedReply,
      mode: "anchor",
      session_complete: false,
      vocab_words_seen: [],
      safeguarding_served: true,
    };
    return new ApiResponse(200, "Safeguarding response served (AI-only)", response);
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
  const newTurnIndex = (session.turns?.length ?? 0);
  session.turns.push({
    turnIndex: newTurnIndex,
    originalInput: input.message,
    scrubbed: false,
    deepSeekResponse: geminiOutput.reply,             // legacy field name; stores the AI tutor's reply
    claudeAssessment: JSON.stringify(geminiOutput),   // full validated output for audit
    timestamp: new Date(),
  } as any);

  // Push the per-turn rollups (brief Function 7 To-Do 5 spec).
  session.turn_scores = [...(session.turn_scores ?? []), geminiOutput.turn_score];
  session.teaching_mode_sequence = [
    ...(session.teaching_mode_sequence ?? []),
    lowerMode(geminiOutput.mode),
  ];
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
  esolSessionQueue
    .add("update-vocab", {
      sessionId: session._id.toString(),
      learnerId: input.learnerId,
      orgId: input.orgId,
      action: "update_vocab",
      payload: {
        // Brief Function 9 To-Do 1 fields the processor needs to call
        // updateLedgerForTurn(learner_id, vocab, score, scenario, stage3).
        vocabulary_items_used: geminiOutput.vocabulary_items_used,
        turn_score: geminiOutput.turn_score,
        scenario_id: session.scenario_id ? String(session.scenario_id) : null,
        // The learner's session has many Stage 3 objective ids matched
        // to the scenario; we attach the first one to new vocab rows
        // because Gemini doesn't tell us which objective each word
        // covers. A future enhancement could route per-word, but the
        // single-anchor approximation is fine for retention tracking.
        stage3_objective_id:
          (session.stage3_objective_ids ?? [])[0] ?? null,
        turnIndex: newTurnIndex,
      },
    })
    .catch((err) => logger.error({ err }, "Failed to enqueue update_vocab job"));

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
      logger.error({ err }, "Failed to enqueue capture_evidence job")
    );

  // If session ended, the session-end workflow (Function 7 To-Do 6)
  // is wired here in a follow-up. For now the assessmentSummary write
  // above is the user-visible part; the org admin's "session done"
  // notification + Stage 4 evidence rollup is the To-Do 6 task.
  if (geminiOutput.session_complete) {
    logger.info(
      { sessionId: session._id.toString(), learnerId: input.learnerId },
      "session_complete=true — Function 7 To-Do 6 finaliser will pick up"
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
  max: EsolLevel
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
  l1Language: string
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
  scenarioAnchors: string[]
): string[] => {
  if (!learnerObjectives || learnerObjectives.length === 0) return [];
  const wanted = new Set(scenarioAnchors);
  return learnerObjectives
    .filter(
      (o) => o.skill_domain === "general" || wanted.has(o.skill_domain)
    )
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
  input: StartSessionInput
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
      scenarioFile.nqf_level_range.max
    )
  ) {
    throw new ApiError(
      403,
      `Scenario ${input.scenarioId} is for levels ${scenarioFile.nqf_level_range.min}–${scenarioFile.nqf_level_range.max}; learner is ${learnerLevel}`
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
        logger.error({ err }, "AuditLog write failed for pathway_override_expired")
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
    .update(`session-start|${input.learnerId}|${input.scenarioId}|${startMinute}`)
    .digest("hex");

  // ── Stage 3 objective linking (brief Function 8 To-Do 3) ────────
  // Match learner objectives against scenario.stage3_objective_domains.
  // An empty match is allowed — happens when the scenario covers a
  // domain the learner has no objective for (very narrow weakness
  // profile). The session still starts; Stage 4 evidence for this
  // session simply won't tie to any stored objective.
  const learnerObjectives = ((learner as any).stage3_objectives ?? []) as Array<{
    id: string;
    skill_domain: string;
  }>;
  const stage3Ids = matchStage3ObjectiveIds(
    learnerObjectives,
    scenarioFile.stage3_objective_domains
  );
  if (stage3Ids.length === 0) {
    logger.warn(
      {
        learnerId: input.learnerId,
        scenarioId: input.scenarioId,
        scenarioDomains: scenarioFile.stage3_objective_domains,
        learnerObjectiveDomains: learnerObjectives.map((o) => o.skill_domain),
      },
      "Stage 3 link empty — scenario covers a domain the learner has no objective for. Session will proceed; evidence won't tie to an objective."
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
    { org_id: input.orgId, learner_id: input.learnerId }
  );

  const sessionId = outcome.result.sessionId;

  // ── 6. Templated opening message ────────────────────────────────
  const openingMessage = buildOpeningMessage(
    learner.firstname ?? "",
    scenarioFile.title,
    learner.l1Language ?? "english"
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
      logger.error({ err, sessionId }, "AuditLog write failed for session_started")
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
    }
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
  sessionId: string
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
        Math.round((endTime.getTime() - startTime.getTime()) / 60000)
      );

      // ── 3. Dedupe skill_codes_covered ────────────────────────────
      const dedupedSkills = Array.from(
        new Set(session.skill_codes_covered ?? [])
      );

      // ── 4. Dedupe vocabulary_items_used ──────────────────────────
      // The existing AISession field is `vocabIntroduced` (legacy
      // name from the v1 AI tutor); semantically the same as the
      // brief's `vocabulary_items_used`. Dedupe it.
      const dedupedVocab = Array.from(
        new Set(session.vocabIntroduced ?? [])
      );

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
        "esol_aim_type"
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
          "User.esol_aim_type missing or invalid at session-end — defaulting to non_regulated (suppresses AddHours in ILR)"
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
    { learner_id: undefined, org_id: undefined }
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
  input: EndSessionInput
): Promise<ApiResponse> => {
  if (!input.sessionId || !Types.ObjectId.isValid(input.sessionId)) {
    throw new ApiError(400, "Valid session_id is required");
  }

  // ── 1. Ownership + state checks ─────────────────────────────────
  const session = await AISession.findById(input.sessionId);
  if (!session) throw new ApiError(404, "AISession not found");
  if (session.learnerId.toString() !== input.learnerId) {
    throw new ApiError(403, "This session does not belong to the calling learner");
  }
  if (session.orgId.toString() !== input.orgId) {
    throw new ApiError(403, "Session does not belong to the calling org context");
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
          "Failed to enqueue level-progression check"
        )
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
      logger.error({ err }, "AuditLog write failed for session_completed")
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
      "VocabLedger retained-count query failed"
    );
    return 0;
  });

  return new ApiResponse(
    200,
    persisted.idempotency_hit ? "Session already ended" : "Session ended",
    {
      session_summary: session.assessmentSummary ?? null,
      final_score: persisted.final_score,
      passed: persisted.passed,
      vocabulary_retained_count: vocabularyRetainedCount,
    }
  );
};
