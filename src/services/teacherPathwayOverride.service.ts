/**
 * Teacher pathway-override service — Final Addendum §9, Todo 22.6.
 *
 *   POST /api/teacher/learners/:id/pathway
 *
 * The teacher hands us an explicit next-N list of scenario ids
 * that should take precedence over the platform's default scenario
 * selector for this learner. The override expires after 30 days —
 * enforcement of that expiry lives in `aiSession.service.ts` at
 * session start (Phase 9.6); this service writes the timestamp
 * the expiry reads.
 *
 * Pipeline
 * ========
 *
 *   1. Assignment gate — same 404-vs-403 disambiguation as the
 *      other teacher endpoints (404 only when the learner truly
 *      doesn't exist; 403 when it exists but isn't ours).
 *   2. Validate every scenario_id:
 *        - file exists (loadScenarioById hits the on-disk JSON)
 *        - learner's current `esolLevel` falls inside the
 *          scenario's `nqf_level_range.[min,max]`
 *      ALL-or-nothing: if any id fails either check, the whole
 *      override is rejected with a 400 listing every problem. A
 *      partial write would leave the learner with a confusing
 *      half-applied pathway.
 *   3. Set `User.pathway_override = { scenario_ids, set_by, set_at }`.
 *   4. Append-only `TeacherReview` row with
 *      `review_type: "pathway_adjustment"` + `duration_mins: 0` —
 *      the pathway-adjustment review carries no contact-hour
 *      contribution. Audit-trail purpose.
 *   5. AuditLog `pathway_override_set` with before/after snapshots
 *      so an org admin reading the log sees the swap.
 *
 * Atomicity
 * =========
 *
 * Same staged ordering as the review-log service (Todo 22.5):
 * User update first, TeacherReview second, AuditLog last. A
 * failure between User-update-and-TeacherReview leaves a pathway
 * override without an audit-trail review row — the AuditLog row
 * still lands (it's written third), so the action is recoverable
 * from the audit trail.
 *
 * No queue dispatch
 * =================
 *
 * Unlike review-log (which fires a priority recalc), pathway
 * override doesn't trigger a priority recalc directly. The next
 * session start reads `pathway_override` and the priority signal
 * shifts naturally as the learner works through the new pathway.
 * Phase 23 may revisit if the recency signal feels stale.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { Types } from "mongoose";
import { Request } from "express";
import ApiError from "../errors/apiError";
import ApiResponse from "../errors/apiResponse";
import User from "../models/User";
import TeacherReview from "../models/TeacherReview";
import logger from "../config/logger";
import { glhContributionHours } from "./teacherGlhContribution";
import { writeAuditLog } from "./auditLog.service";
import { enqueueLearnerPriorityRecalc } from "./priorityQueueRecalc.service";
import { EsolLevel, normaliseEsolLevel } from "./esolSkills";
import { IScenarioFile } from "../interfaces/scenario.interface";

// ─────────────────────────────────────────────────────────────────────
// Local helpers — duplicated from aiSession.service / levelProgression
// (third call site). Future refactor lifts to esolSkills.ts.
// ─────────────────────────────────────────────────────────────────────

const SCENARIOS_DIR = resolve(__dirname, "../data/scenarios");
const scenarioCache = new Map<string, IScenarioFile | null>();

const loadScenarioById = (scenarioId: string): IScenarioFile | null => {
  if (scenarioCache.has(scenarioId)) return scenarioCache.get(scenarioId)!;
  try {
    const path = resolve(SCENARIOS_DIR, `${scenarioId}.json`);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as IScenarioFile;
    scenarioCache.set(scenarioId, parsed);
    return parsed;
  } catch {
    scenarioCache.set(scenarioId, null);
    return null;
  }
};

const LEVEL_LADDER: ReadonlyArray<EsolLevel> = ["e1", "e2", "e3", "l1", "l2"];

const isLevelInRange = (
  level: EsolLevel,
  min: EsolLevel,
  max: EsolLevel,
): boolean => {
  const li = LEVEL_LADDER.indexOf(level);
  const mn = LEVEL_LADDER.indexOf(min);
  const mx = LEVEL_LADDER.indexOf(max);
  if (li < 0 || mn < 0 || mx < 0) return false;
  return li >= mn && li <= mx;
};

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface SetPathwayOverrideBody {
  scenario_ids: string[];
}

export interface SetPathwayOverrideInput {
  learner_id: string;
  teacher_id: string;
  body: SetPathwayOverrideBody;
  req?: Request;
}

export interface SetPathwayOverrideResult {
  pathway_override: {
    scenario_ids: string[];
    set_by: string;
    set_at: string;
    /** Convenience — the 30-day expiry the session-start code enforces. */
    expires_at: string;
  };
  /** TeacherReview row id created as the audit-trail companion. */
  teacher_review_id: string;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

const OVERRIDE_TTL_DAYS = 30;

export const setPathwayOverrideService = async (
  input: SetPathwayOverrideInput,
): Promise<ApiResponse> => {
  // ── Input validation ───────────────────────────────────────────
  if (!input.learner_id || !Types.ObjectId.isValid(input.learner_id)) {
    throw new ApiError(400, "learner id must be a valid ObjectId");
  }
  if (!input.teacher_id || !Types.ObjectId.isValid(input.teacher_id)) {
    throw new ApiError(400, "Authenticated teacher id required");
  }
  const scenario_ids = input.body?.scenario_ids;
  if (!Array.isArray(scenario_ids) || scenario_ids.length === 0) {
    throw new ApiError(400, "scenario_ids is required and must be non-empty");
  }

  const learnerObjectId = new Types.ObjectId(input.learner_id);
  const teacherObjectId = new Types.ObjectId(input.teacher_id);

  // ── 1. Assignment gate ────────────────────────────────────────
  const learner = await User.findById(learnerObjectId)
    .select("_id role assigned_teacher_id orgId esolLevel pathway_override")
    .lean();
  if (!learner || learner.role !== "student") {
    throw new ApiError(404, "Learner not found");
  }
  const assignedTo = (
    learner as { assigned_teacher_id?: Types.ObjectId | null }
  ).assigned_teacher_id;
  if (!assignedTo || assignedTo.toString() !== input.teacher_id) {
    throw new ApiError(403, "Forbidden — this learner is not assigned to you.");
  }
  const orgId = (learner as { orgId?: Types.ObjectId | null }).orgId;
  if (!orgId) {
    throw new ApiError(
      500,
      "Learner has no org assignment — cannot pin TeacherReview without one",
    );
  }
  const learnerLevel = normaliseEsolLevel(
    (learner as { esolLevel?: string | null }).esolLevel,
  );
  if (!learnerLevel) {
    throw new ApiError(
      400,
      `Learner's esol_level is missing or invalid — cannot validate scenarios against it.`,
    );
  }

  // ── 2. Validate every scenario (ALL-or-nothing) ───────────────
  // We collect EVERY problem before throwing so a teacher fixing a
  // bad list sees all the issues in one round-trip, not a one-at-
  // a-time guessing game.
  const problems: Array<{ scenario_id: string; problem: string }> = [];
  for (const sid of scenario_ids) {
    const scenario = loadScenarioById(sid);
    if (!scenario) {
      problems.push({
        scenario_id: sid,
        problem: `Scenario "${sid}" not found in the scenario bank.`,
      });
      continue;
    }
    const min = normaliseEsolLevel(scenario.nqf_level_range?.min);
    const max = normaliseEsolLevel(scenario.nqf_level_range?.max);
    if (!min || !max) {
      problems.push({
        scenario_id: sid,
        problem: `Scenario "${sid}" has a malformed nqf_level_range — file an issue against the scenario bank.`,
      });
      continue;
    }
    if (!isLevelInRange(learnerLevel, min, max)) {
      problems.push({
        scenario_id: sid,
        problem: `Scenario "${sid}" is for levels ${min}–${max}; learner is ${learnerLevel}.`,
      });
    }
  }
  if (problems.length > 0) {
    const message =
      `Pathway override rejected — ${problems.length} scenario(s) failed validation: ` +
      problems.map((p) => p.problem).join(" ");
    throw new ApiError(400, message);
  }

  // ── Capture before-state for the audit row ───────────────────
  const before_override =
    (
      learner as {
        pathway_override?: unknown;
      }
    ).pathway_override ?? null;

  // ── 3. Write the override ────────────────────────────────────
  const set_at = new Date();
  const expires_at = new Date(
    set_at.getTime() + OVERRIDE_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  const newOverride = {
    scenario_ids,
    set_by: teacherObjectId,
    set_at,
  };
  // pathway_override is Schema.Types.Mixed — Mongoose doesn't
  // change-track Mixed by default, so $set on the field is the
  // safe write path.
  await User.findByIdAndUpdate(
    learnerObjectId,
    { $set: { pathway_override: newOverride } },
    { new: false },
  );

  // ── 4. Append-only TeacherReview row ─────────────────────────
  // duration_mins stays 0 (there's no wall-clock contact), but the
  // activity still earns its FIXED GLH credit — Final Addendum §4.3
  // sets pathway_adjustment at 0.25h regardless of duration.
  const reviewDoc = await TeacherReview.create({
    learner_id: learnerObjectId,
    teacher_id: teacherObjectId,
    org_id: orgId,
    review_type: "pathway_adjustment",
    duration_mins: 0,
    notes:
      `Pathway override set to ${scenario_ids.length} scenario(s): ` +
      scenario_ids.join(", "),
    ai_recommendation_acted_on: false,
    created_at: set_at,
  });

  // ── 4b. GLH credit + review timestamp (§4.3 / §12) ───────────
  await User.updateOne(
    { _id: learnerObjectId },
    {
      $inc: {
        glh_teacher_contact: glhContributionHours("pathway_adjustment", 0),
      },
      $set: { teacher_last_reviewed_at: set_at },
    },
  );

  // ── 5. AuditLog row ──────────────────────────────────────────
  await writeAuditLog(
    {
      actor_type: "teacher",
      actor_id: input.teacher_id,
      org_id: orgId,
      learner_id: input.learner_id,
      action: "pathway_override_set",
      before_state: {
        pathway_override: serialiseOverrideForAudit(before_override),
      },
      after_state: {
        pathway_override: {
          scenario_ids,
          set_by: input.teacher_id,
          set_at: set_at.toISOString(),
          expires_at: expires_at.toISOString(),
        },
        teacher_review_id: (reviewDoc._id as Types.ObjectId).toString(),
      },
      reason:
        `Teacher set pathway override to ${scenario_ids.length} scenario(s) ` +
        `(${scenario_ids.join(", ")}); expires ${expires_at.toISOString().slice(0, 10)}.`,
    },
    { req: input.req },
  );

  // ── 6. Enqueue single-learner priority recalc — best-effort ──
  // Todo 23.4 — per-minute dedupe collapses bursty teacher
  // actions onto one recalc job. Queue write failures are
  // swallowed inside the helper; the daily per-org cron is the
  // safety net.
  await enqueueLearnerPriorityRecalc(input.learner_id, "pathway_override_set");

  logger.info(
    {
      learner_id: input.learner_id,
      teacher_id: input.teacher_id,
      scenario_count: scenario_ids.length,
      expires_at: expires_at.toISOString(),
      teacher_review_id: (reviewDoc._id as Types.ObjectId).toString(),
    },
    "setPathwayOverride: complete",
  );

  const result: SetPathwayOverrideResult = {
    pathway_override: {
      scenario_ids,
      set_by: input.teacher_id,
      set_at: set_at.toISOString(),
      expires_at: expires_at.toISOString(),
    },
    teacher_review_id: (reviewDoc._id as Types.ObjectId).toString(),
  };
  return new ApiResponse(200, "Pathway override set", result);
};

// ─────────────────────────────────────────────────────────────────────
// Audit serialisation helper
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalise the pre-existing pathway_override (which can be null,
 * an old object with ObjectId fields, or a partially-shaped doc)
 * to a JSON-safe shape for the audit row's `before_state`.
 */
const serialiseOverrideForAudit = (raw: unknown): unknown => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return raw;
  const r = raw as Record<string, unknown>;
  return {
    scenario_ids: Array.isArray(r.scenario_ids) ? r.scenario_ids : [],
    set_by:
      r.set_by instanceof Types.ObjectId
        ? r.set_by.toString()
        : typeof r.set_by === "string"
          ? r.set_by
          : null,
    set_at:
      r.set_at instanceof Date
        ? r.set_at.toISOString()
        : typeof r.set_at === "string"
          ? r.set_at
          : null,
  };
};

// Re-export for tests
export const __internals__ = {
  loadScenarioById,
  LEVEL_LADDER,
  isLevelInRange,
  serialiseOverrideForAudit,
  OVERRIDE_TTL_DAYS,
};
