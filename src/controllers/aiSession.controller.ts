import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import {
  processTurnService,
  startSessionService,
  endSessionService,
  getPendingSpeakingTarget,
  getLearnerProgressService,
} from "../services/aiSession.service";
import {
  synthesizeSpeech,
  transcribeSpeech,
  voiceCapabilities,
} from "../services/voice.service";
import { assessPronunciation } from "../services/pronunciation.service";
import { Types } from "mongoose";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { buildStage3NegotiationScript } from "../services/rarpa.service";

/** Hard cap on TTS input length — guards billing + abuse. */
const TTS_MAX_CHARS = 2000;
/** A reply rarely has more than a handful of language switches. */
const TTS_MAX_SEGMENTS = 24;
/** Hard cap on a voice-turn audio payload (base64 chars, ~3 MB raw). */
const VOICE_TURN_MAX_AUDIO_CHARS = 4_000_000;

const pullContext = (req: any): { learnerId: string; orgId: string } | null => {
  const learnerId = req.user?.id?.toString();
  const orgId = req.esol_context?.org_id;
  if (!learnerId || !orgId) return null;
  return { learnerId, orgId };
};

/**
 * POST /api/esol/session/turn — brief Function 7 To-Do 5.
 *
 * Thin: pull the body + identity from the request, hand off to the
 * service. Auth chain (isAuthenticated + requireOrgContext +
 * aiTurnLimiter) is enforced at the route layer.
 */
export const processTurn: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) return next(new ApiError(401, "Unauthorized"));

    const ctx = (
      req as typeof req & {
        esol_context?: { org_id: string };
      }
    ).esol_context;
    if (!ctx?.org_id) {
      return next(new ApiError(403, "Organisation context required"));
    }

    const body = req.body as { session_id?: string; message?: string };
    const data = await processTurnService({
      sessionId: body.session_id ?? "",
      message: body.message ?? "",
      learnerId,
      orgId: ctx.org_id,
    });
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/esol/session/start — brief Function 7 To-Do 6.
 */
export const startSession: ExpressFunction = async (req, res, next) => {
  try {
    const ctx = pullContext(req);
    if (!ctx) return next(new ApiError(403, "Auth + org context required"));

    const body = req.body as { scenario_id?: string };
    const data = await startSessionService({
      scenarioId: body.scenario_id ?? "",
      learnerId: ctx.learnerId,
      orgId: ctx.orgId,
    });
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/esol/session/end — brief Function 7 To-Do 6.
 */
export const endSession: ExpressFunction = async (req, res, next) => {
  try {
    const ctx = pullContext(req);
    if (!ctx) return next(new ApiError(403, "Auth + org context required"));

    const body = req.body as { session_id?: string };
    const data = await endSessionService({
      sessionId: body.session_id ?? "",
      learnerId: ctx.learnerId,
      orgId: ctx.orgId,
    });
    return res.status(200).json(data);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/esol/session/tts — F28 TTS OUT.
 *
 * Synthesises a learner-facing line server-side. Returns `{ available:
 * false }` (HTTP 200) when voice is disabled / the language has no voice
 * / synthesis fails — the client then just shows text. Never errors into
 * the session flow.
 */
export const synthesizeTts: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) return next(new ApiError(401, "Unauthorized"));

    const body = req.body as {
      text?: string;
      language?: string;
      /** Mixed-language reply split into runs. "l1" resolves to the
       *  learner's own first language server-side. */
      segments?: Array<{ lang?: string; text?: string }>;
      /** Google speakingRate (0.5..1.5); frontend derives it from level. */
      rate?: number;
    };
    const speakingRate =
      typeof body.rate === "number" && Number.isFinite(body.rate)
        ? body.rate
        : undefined;

    // ── Segment mode (F33): one voice per language run ──────────────
    if (Array.isArray(body.segments) && body.segments.length > 0) {
      const learner = await User.findById(learnerId)
        .select("l1Language")
        .lean<{ l1Language?: string | null }>();
      const l1 = learner?.l1Language || "english";
      const capped = body.segments.slice(0, TTS_MAX_SEGMENTS);
      let anyAudio = false;
      const out = [];
      for (const seg of capped) {
        const segText = (seg?.text ?? "").slice(0, TTS_MAX_CHARS);
        const lang = seg?.lang === "l1" ? "l1" : "en";
        const language = lang === "l1" ? l1 : "english";
        const r = segText.trim()
          ? await synthesizeSpeech(segText, language, { speakingRate })
          : null;
        if (r) anyAudio = true;
        out.push({ lang, text: segText, audio_base64: r?.audioBase64 ?? null });
      }
      if (!anyAudio) {
        return res
          .status(200)
          .json(
            new ApiResponse(200, "Voice unavailable", { available: false }),
          );
      }
      return res.status(200).json(
        new ApiResponse(200, "Synthesised", {
          available: true,
          content_type: "audio/mpeg",
          segments: out,
        }),
      );
    }

    const text = (body.text ?? "").slice(0, TTS_MAX_CHARS);
    const language = body.language ?? "english";

    const result = await synthesizeSpeech(text, language, { speakingRate });
    if (!result) {
      return res
        .status(200)
        .json(new ApiResponse(200, "Voice unavailable", { available: false }));
    }
    return res.status(200).json(
      new ApiResponse(200, "Synthesised", {
        available: true,
        audio_base64: result.audioBase64,
        content_type: result.contentType,
      }),
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/esol/session/stt — F28 STT IN (opt-in, default OFF).
 *
 * Transcribes a short learner utterance. Returns `{ available: false }`
 * when STT is disabled or transcription yields nothing — the client
 * falls back to tap-to-type. Forgiving, never pass/fail.
 */
export const transcribeStt: ExpressFunction = async (req, res, next) => {
  try {
    const learnerId = req.user?.id?.toString();
    if (!learnerId) return next(new ApiError(401, "Unauthorized"));

    const body = req.body as {
      audio_base64?: string;
      language?: string;
      encoding?: string;
      sample_rate_hertz?: number;
    };
    const result = await transcribeSpeech(
      body.audio_base64 ?? "",
      body.language ?? "english",
      { encoding: body.encoding, sampleRateHertz: body.sample_rate_hertz },
    );
    if (!result) {
      return res.status(200).json(
        new ApiResponse(200, "Speech input unavailable", {
          available: false,
        }),
      );
    }
    return res.status(200).json(
      new ApiResponse(200, "Transcribed", {
        available: true,
        transcript: result.transcript,
      }),
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/esol/session/turn-voice — F32 spoken learner turn.
 *
 * The ONLY path that marks a turn as spoken. Flow:
 *   1. STT off               → 200 { available: false }       (nothing consumed)
 *   2. transcribe; nothing   → 200 { available: true, heard: false }
 *   3. pending speaking target + level from the session
 *   4. assessPronunciation (fail safe; may be null)
 *   5. processTurnService with inputMode "voice"
 *   6. 200 { available: true, heard: true, ...turnResponse }
 *
 * No audio is persisted or logged; only the transcript + assessment
 * flow onward. Typing is never blocked by this endpoint.
 */
export const processVoiceTurn: ExpressFunction = async (req, res, next) => {
  try {
    const ctx = pullContext(req);
    if (!ctx) return next(new ApiError(403, "Auth + org context required"));

    const body = req.body as {
      session_id?: string;
      audio_base64?: string;
      encoding?: string;
      sample_rate_hertz?: number;
      mime_type?: string;
      language?: string;
      audio_seconds?: number;
    };

    const sessionId =
      typeof body.session_id === "string" ? body.session_id : "";
    if (!sessionId || !Types.ObjectId.isValid(sessionId)) {
      return next(new ApiError(400, "Valid session_id is required"));
    }
    const audioBase64 =
      typeof body.audio_base64 === "string" ? body.audio_base64 : "";
    if (audioBase64.length > VOICE_TURN_MAX_AUDIO_CHARS) {
      return next(
        new ApiError(
          400,
          `audio_base64 exceeds the ${VOICE_TURN_MAX_AUDIO_CHARS} character limit — record a shorter answer`,
        ),
      );
    }

    // 1. Voice gating — the whole feature hides behind VOICE_STT_ENABLED.
    if (!voiceCapabilities().stt) {
      return res.status(200).json(
        new ApiResponse(200, "Speech input unavailable", {
          available: false,
        }),
      );
    }

    const encoding = body.encoding || "WEBM_OPUS";
    const sampleRateHertz =
      typeof body.sample_rate_hertz === "number" &&
      Number.isFinite(body.sample_rate_hertz)
        ? body.sample_rate_hertz
        : 48000;
    const mimeType = body.mime_type || "audio/webm";
    const language = body.language || "english";
    const audioSeconds =
      typeof body.audio_seconds === "number" &&
      Number.isFinite(body.audio_seconds)
        ? Math.max(0, body.audio_seconds)
        : null;

    // 2. Transcribe. Nothing heard → no turn consumed, no TurnLog.
    const stt = await transcribeSpeech(audioBase64, language, {
      encoding,
      sampleRateHertz,
    });
    const transcript = (stt?.transcript ?? "").trim();
    if (!stt || !transcript) {
      return res.status(200).json(
        new ApiResponse(200, "Nothing heard", {
          available: true,
          heard: false,
        }),
      );
    }

    // 3. What did the tutor ask them to say (if anything)?
    const { targetPhrase, esolLevel } = await getPendingSpeakingTarget(
      sessionId,
      ctx.learnerId,
    );

    // 4. Pronunciation assessment — fail safe, may be null.
    const pronunciation = await assessPronunciation({
      audioBase64,
      mimeType,
      transcript,
      sttConfidence: stt.confidence ?? null,
      words: stt.words ?? [],
      targetPhrase,
      esolLevel,
      tracking: { sessionId, orgId: ctx.orgId, learnerId: ctx.learnerId },
    });

    // 5. The regular turn pipeline, marked as spoken.
    const turn = await processTurnService({
      sessionId,
      message: transcript,
      learnerId: ctx.learnerId,
      orgId: ctx.orgId,
      inputMode: "voice",
      pronunciation,
      audioSeconds,
    });

    // 6. Same envelope as /turn, plus the voice flags.
    return res.status(200).json(
      new ApiResponse(200, turn.message, {
        available: true,
        heard: true,
        ...(turn.data ?? {}),
      }),
    );
  } catch (err) {
    next(err);
  }
};

/** GET /api/esol/session/voice-capabilities — what controls to render. */
export const getVoiceCapabilities: ExpressFunction = async (req, res, next) => {
  try {
    return res
      .status(200)
      .json(new ApiResponse(200, "Voice capabilities", voiceCapabilities()));
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/esol/session/progress — every number the learner home shows,
 * computed over all sessions and the whole vocabulary ledger.
 */
export const getMyProgress: ExpressFunction = async (req, res, next) => {
  try {
    const ctx = pullContext(req);
    if (!ctx) return next(new ApiError(403, "Auth + org context required"));
    const progress = await getLearnerProgressService(ctx.learnerId);
    return res.status(200).json(new ApiResponse(200, "Progress", progress));
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/esol/session/goals — F30 learner-facing Stage 3 negotiation.
 *
 * Returns the learner's own Stage 3 objectives, the L1 negotiation
 * script (the same warm "do you agree?" framing recorded at placement),
 * and whether the learner has already agreed.
 */
export const getMyGoals: ExpressFunction = async (req, res, next) => {
  try {
    const ctx = pullContext(req);
    if (!ctx) return next(new ApiError(403, "Auth + org context required"));

    const learner = await User.findById(ctx.learnerId)
      .select("stage3_objectives l1Language")
      .lean();
    const objectives = (learner?.stage3_objectives ?? []) as Array<{
      id: string;
      skill_domain: string;
      description: string;
      target_level?: string | null;
    }>;
    const l1Language = (learner?.l1Language as string) ?? "english";
    const negotiation_script = buildStage3NegotiationScript(
      objectives as never,
      l1Language,
    );

    const agreement = await AuditLog.findOne({
      learner_id: new Types.ObjectId(ctx.learnerId),
      action: "rarpa_stage3_negotiated",
      actor_type: "learner",
    })
      .sort({ timestamp: -1 })
      .lean();

    // "Agreed" only counts for the objectives the learner actually saw.
    // Silk brief section 2: the flag used to carry over to a new set of
    // objectives the learner had never agreed.
    const agreedIds = new Set<string>(
      ((agreement?.after_state as { objective_ids?: string[] } | null)
        ?.objective_ids ?? []) as string[],
    );
    const currentIds = objectives.map((o) => o.id);
    const agreementCoversCurrent =
      currentIds.length > 0 && currentIds.every((id) => agreedIds.has(id));

    return res.status(200).json(
      new ApiResponse(200, "Goals", {
        objectives,
        negotiation_script,
        l1_language: l1Language,
        agreed_at:
          agreementCoversCurrent && agreement?.timestamp instanceof Date
            ? agreement.timestamp.toISOString()
            : null,
      }),
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/esol/session/goals/agree — the learner confirms their Stage 3
 * objectives in their L1. Records an immutable learner-actor negotiation
 * evidence row (RARPA Stage 3).
 */
export const agreeMyGoals: ExpressFunction = async (req, res, next) => {
  try {
    const ctx = pullContext(req);
    if (!ctx) return next(new ApiError(403, "Auth + org context required"));

    const rawNote = (req.body as { note?: unknown })?.note;
    const note = typeof rawNote === "string" ? rawNote.slice(0, 500) : null;

    const learner = await User.findById(ctx.learnerId)
      .select("stage3_objectives orgId")
      .lean();
    const objectiveIds = (
      (learner?.stage3_objectives ?? []) as Array<{ id: string }>
    ).map((o) => o.id);

    await AuditLog.create({
      timestamp: new Date(),
      actor_type: "learner",
      actor_id: new Types.ObjectId(ctx.learnerId),
      org_id: (learner?.orgId as Types.ObjectId | null) ?? null,
      learner_id: new Types.ObjectId(ctx.learnerId),
      action: "rarpa_stage3_negotiated",
      before_state: null,
      after_state: {
        agreed: true,
        learner_note: note,
        objective_ids: objectiveIds,
        source: "learner_confirmation",
      },
      reason:
        "Learner reviewed and agreed their Stage 3 objectives in their first language (RARPA Stage 3 negotiation)",
    });

    return res
      .status(200)
      .json(new ApiResponse(200, "Goals agreed", { agreed: true }));
  } catch (err) {
    next(err);
  }
};
