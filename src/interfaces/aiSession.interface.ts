import { Types, Document } from "mongoose";

export type AISessionMode = "BRIDGE" | "ANCHOR" | "IMMERSION";

/**
 * Source of a session record.
 *   - "ai_tutor"              — live AI tutor session (default)
 *   - "teacher_consolidation" — booked human-led consolidation session
 *   - "pre_platform"          — historical session imported via CSV
 *                               (brief Function 5). No turns, no vocab,
 *                               no AI scoring — just GLH evidence.
 */
export type AISessionSource =
  | "ai_tutor"
  | "teacher_consolidation"
  | "pre_platform";

export interface IAISessionTurn {
  turnIndex: number;
  originalInput: string;
  scrubbed: boolean;
  deepSeekResponse: string;
  claudeAssessment?: string;
  safeguardingScore?: number;
  timestamp: Date;
}

export interface IAISession extends Document {
  _id: Types.ObjectId;
  learnerId: Types.ObjectId;
  // Optional: pre-platform imports (brief Function 5) have no teacher
  // and no esolLevel snapshot. AI tutor + consolidation sessions still
  // populate both, so existing readers keep working.
  teacherId?: Types.ObjectId | null;
  orgId: Types.ObjectId;
  bookingId?: Types.ObjectId | null;
  sessionMode: AISessionMode;
  esolLevel?: string | null;
  topic?: string;
  turns: IAISessionTurn[];
  safeguardingFlagged: boolean;
  safeguardingAlertId?: Types.ObjectId;
  assessmentSummary?: string;
  vocabIntroduced?: string[];
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;

  // ── Brief Function 5 additions ───────────────────────────────────
  session_source: AISessionSource;
  /** Rounded minutes — set explicitly by pre-platform imports and the
   *  ILR exporter; for live AI sessions, derive from completedAt - createdAt. */
  duration_mins?: number | null;
  /** ILR skill codes (Sc/Sd/Lr/Rt/Rs/Rw/Wt/Ws/Ww) practised in this
   *  session. Empty array if not declared. */
  skill_codes_covered?: string[];
  scenario_id?: Types.ObjectId | string | null;
  final_score?: number | null;
  passed?: boolean | null;

  // ── Brief Function 7 To-Do 5 additions ────────────────────────────
  /** Per-turn `turn_score` values, indexed by turn order. */
  turn_scores?: number[];
  /** Per-turn `mode` values (lowercase: anchor/bridge/immersion). The
   *  uppercase `sessionMode` field tracks the CURRENT mode; this array
   *  is the full history for the audit trail. */
  teaching_mode_sequence?: string[];

  // ── Brief Function 7 To-Do 6 additions ────────────────────────────
  stage3_objective_ids?: string[];
  esol_aim_type_at_start?: "regulated" | "non_regulated" | null;
  /** Aim type at SESSION-END — re-confirmed from User. See
   *  persistSessionOnEnd in aiSession.service.ts. */
  esol_aim_type?: "regulated" | "non_regulated" | null;
  nqf_level_at_start?: string | null;
  start_time?: Date | null;
  end_time?: Date | null;
}

export interface ICreateAISessionRequest {
  learnerId: string;
  teacherId: string;
  orgId: string;
  bookingId?: string;
  sessionMode?: AISessionMode;
  esolLevel: string;
  topic?: string;
}

export interface ISubmitTurnRequest {
  input: string;
}
