import { ExpressFunction } from "../interfaces/helper.interface";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import {
  processTurnService,
  startSessionService,
  endSessionService,
} from "../services/aiSession.service";
import {
  synthesizeSpeech,
  transcribeSpeech,
  voiceCapabilities,
} from "../services/voice.service";
import { Types } from "mongoose";
import User from "../models/User";
import AuditLog from "../models/AuditLog";
import { buildStage3NegotiationScript } from "../services/rarpa.service";

/** Hard cap on TTS input length — guards billing + abuse. */
const TTS_MAX_CHARS = 2000;

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

    const body = req.body as { text?: string; language?: string };
    const text = (body.text ?? "").slice(0, TTS_MAX_CHARS);
    const language = body.language ?? "english";

    const result = await synthesizeSpeech(text, language);
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

    return res.status(200).json(
      new ApiResponse(200, "Goals", {
        objectives,
        negotiation_script,
        l1_language: l1Language,
        agreed_at:
          agreement?.timestamp instanceof Date
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
