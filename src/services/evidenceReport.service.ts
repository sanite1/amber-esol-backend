/**
 * Evidence-report PDF generator — brief Function 14 To-Do 2.
 *
 * Composes the consolidated RARPA evidence report PDF whose template
 * is documented in [docs/EVIDENCE_REPORT_TEMPLATE.md](../../docs/EVIDENCE_REPORT_TEMPLATE.md).
 *
 * Pipeline:
 *
 *   1. Build the data payload — cohort summary, Stages 1–5, teacher
 *      oversight, ILR summary, safeguarding metadata.
 *   2. Render Handlebars template at `src/templates/evidenceReport.handlebars`.
 *   3. Reuse the existing `generatePdfFromHtml` (puppeteer-core + sparticuz/chromium)
 *      from pdfGenerator.service.ts.
 *   4. Persist the PDF to disk under `${EVIDENCE_REPORT_DIR}/<report_id>.pdf`
 *      for the report-cache route (Function 14 To-Do 5).
 *   5. Return `{ pdf_buffer, report_id }`.
 *
 * Privacy invariants enforced at the data layer (not just the template):
 *   - Safeguarding section is aggregate-only — counts by category +
 *     resolution metrics. NO learner_id, NO messageContentHash, NO
 *     alert detail crosses this boundary.
 *   - Stage 4 turn excerpts identify learners by ULN only, and
 *     skip any session that has `safeguardingFlagged: true`.
 *   - The Stage5Review snapshot of stage3_objectives is read
 *     verbatim — no re-fetching from the User doc, so the report
 *     reflects what was assessed at the level just completed even
 *     if objectives have since been edited.
 *
 * Storage: the PDF lands at `${EVIDENCE_REPORT_DIR}/<report_id>.pdf`
 * with a default of `/tmp/evidence-reports`, matching the
 * ILR-export pattern. Function 14 To-Do 5 builds the route that
 * downloads it; this service just produces + caches the artefact.
 */

import { mkdir, writeFile } from "fs/promises";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash, randomUUID } from "crypto";
import { Types } from "mongoose";
import Handlebars from "handlebars";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import VocabLedger from "../models/VocabLedger";
import LevelChange from "../models/LevelChange";
import Stage5Review from "../models/Stage5Review";
import TeacherReview from "../models/TeacherReview";
import SafeguardingAlert from "../models/SafeguardingAlert";
import IdempotencyKey from "../models/IdempotencyKey";
import { ILR_CODE_TO_DOMAIN, ForSkillsDomain } from "./esolSkills";
import { generatePdfFromHtml } from "./pdfGenerator.service";
import ApiError from "../errors/apiError";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const EVIDENCE_REPORT_DIR =
  process.env.EVIDENCE_REPORT_DIR ?? "/tmp/evidence-reports";

const TEMPLATE_PATH = resolve(__dirname, "../templates/evidenceReport.handlebars");

const LEVEL_LABELS: Record<string, string> = {
  e1: "Entry Level 1",
  e2: "Entry Level 2",
  e3: "Entry Level 3",
  l1: "Level 1",
  l2: "Level 2",
};

const REVIEW_TYPE_LABELS: Record<string, string> = {
  async_review: "Async review",
  contact_session: "Contact session",
  pathway_adjustment: "Pathway adjustment",
  rarpa_signoff: "RARPA sign-off",
};

const CATEGORY_LABELS: Record<string, string> = {
  self_harm: "Self harm",
  domestic_abuse: "Domestic abuse",
  radicalisation: "Radicalisation",
  child_concern: "Child concern",
  child_protection: "Child protection",
  exploitation: "Exploitation",
  mental_health_crisis: "Mental health crisis",
};

const RETAINED_VOCAB_TOP_N = 10;
const SAMPLE_EXCERPTS_PER_LEARNER = 3;

// ─────────────────────────────────────────────────────────────────────
// Handlebars helpers + compiled template (cached at module load)
// ─────────────────────────────────────────────────────────────────────

Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
Handlebars.registerHelper("gt", (a: number, b: number) => a > b);
Handlebars.registerHelper("formatDate", (iso: string | Date | null | undefined) => {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
});
Handlebars.registerHelper("formatDateTime", (iso: string | Date | null | undefined) => {
  if (!iso) return "—";
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
  });
});
Handlebars.registerHelper("round1", (n: unknown) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0.0";
  return (Math.round(n * 10) / 10).toFixed(1);
});

let compiledTemplate: HandlebarsTemplateDelegate<unknown> | null = null;
const getTemplate = (): HandlebarsTemplateDelegate<unknown> => {
  if (compiledTemplate) return compiledTemplate;
  const src = readFileSync(TEMPLATE_PATH, "utf8");
  compiledTemplate = Handlebars.compile(src, { noEscape: false });
  return compiledTemplate;
};

// ─────────────────────────────────────────────────────────────────────
// Payload shape — what the Handlebars template renders against
// ─────────────────────────────────────────────────────────────────────

export interface EvidenceReportPayload {
  report_id: string;
  generated_at: string;
  generated_at_human: string;
  period_start: string;
  period_end: string;
  period_start_human: string;
  period_end_human: string;
  org: { id: string; name: string; logo_url: string | null };
  cohort: {
    total_learners: number;
    total_glh: number;
    ai_glh: number;
    imported_glh: number;
    teacher_contact_glh: number;
    level_progression_count: number;
    level_progression_breakdown: string;
    scenarios_passed_total: number;
    by_level: Array<{ level: string; label: string; count: number; percent: string }>;
  };
  stage1_rows: Array<{
    uln: string | null;
    assessment_date_human: string;
    source_label: string;
    recommended_level: string;
  }>;
  stage2_rows: Array<{
    uln: string | null;
    source_label: string;
    assessment_date_human: string;
    scores: { reading: number; writing: number; listening: number; speaking: number } | null;
    recommended_level: string;
    weakness_flags_human: string;
    weakness_flags_count: number;
  }>;
  stage3_rows: Array<{
    uln: string | null;
    grouped_by_level: Array<{
      level: string;
      level_label: string;
      objectives: Array<{ skill_domain: string; description: string; source_label: string }>;
    }>;
  }>;
  stage4_rows: Array<{
    uln: string | null;
    session_count: number;
    scenarios_passed: number;
    vocab_retention_pct: number;
    top_10_retained: string[];
    excerpts: Array<{
      session_date_human: string;
      scenario_id_human: string;
      turns: Array<{ role: "learner" | "tutor"; text: string }>;
    }>;
  }>;
  stage5: {
    completed_count: number;
    pending_count: number;
    completed: Array<{
      uln: string | null;
      old_level_label: string;
      new_level_label: string;
      confirmed_at_human: string;
      confirmed_by_name: string;
      learner_self_assessment: string;
      ai_tutor_summary: string;
      next_steps: string;
    }>;
    pending: Array<{ uln: string | null; created_at_human: string }>;
  };
  teacher_oversight_rows: Array<{
    uln: string | null;
    teacher_name_or_dash: string;
    total_teacher_glh: string;
    counts: {
      async_review: number;
      contact_session: number;
      pathway_adjustment: number;
      rarpa_signoff: number;
    };
    last_review_human: string;
  }>;
  /**
   * Final Addendum §12 — cohort-level summary that sits ABOVE the
   * per-learner table in the PDF. Three numbers Joey called out
   * as the org admin's "did teacher oversight actually happen?"
   * glance-test:
   *   - total_cohort_glh         : sum of every learner's
   *                                glh_teacher_contact
   *   - average_reviews_per_learner : reviews-in-period / learner-count
   *   - top_reviewers_by_glh     : ranked list, capped at TOP_REVIEWER_LIMIT
   *
   * Strings (not numbers) for the GLH values to match the row
   * shape — keeps Handlebars rendering uniform (no conditional
   * `{{this.total_cohort_glh.toFixed}}` in the template).
   */
  teacher_oversight_aggregates: {
    total_cohort_glh: string;
    average_reviews_per_learner: string;
    learner_count: number;
    review_count: number;
    top_reviewers_by_glh: Array<{
      teacher_name: string;
      total_glh: string;
      review_count: number;
    }>;
  };
  ilr: {
    has_linked_export: boolean;
    export_id: string | null;
    generated_at_human: string;
    period_start_human: string;
    period_end_human: string;
    compliance_config_version: number | null;
    rows_exported: number;
    rows_blocked: number;
    warnings_count: number;
    warnings_by_type: Array<{ type: string; count: number }>;
  };
  safeguarding: {
    period_start_human: string;
    period_end_human: string;
    total: number;
    by_category: Array<{ category_label: string; count: number }>;
    resolved_count: number;
    resolution_rate_pct: number;
    avg_resolution_days: string;
    median_resolution_days: string;
    oldest_unresolved_days: number | "—";
  };
}

export interface GenerateEvidenceReportResult {
  pdf_buffer: Buffer;
  report_id: string;
  payload: EvidenceReportPayload;
}

// ─────────────────────────────────────────────────────────────────────
// Sub-builders — one per template section
// ─────────────────────────────────────────────────────────────────────

const buildCohortSection = (
  learners: Array<{ esolLevel?: string | null }>,
  sessions: Array<{ session_source?: string; duration_mins?: number | null; passed?: boolean | null }>,
  levelChanges: Array<{ fromLevel: string; toLevel: string }>,
  teacherContactByLearner: Map<string, number>,
): EvidenceReportPayload["cohort"] => {
  // Headline totals
  const total_learners = learners.length;
  let ai_mins = 0;
  let imported_mins = 0;
  let scenarios_passed_total = 0;
  for (const s of sessions) {
    if (s.session_source === "pre_platform") imported_mins += s.duration_mins ?? 0;
    else ai_mins += s.duration_mins ?? 0;
    if (s.passed) scenarios_passed_total += 1;
  }
  const teacher_contact_glh =
    Array.from(teacherContactByLearner.values()).reduce((a, b) => a + b, 0);

  const ai_glh = ai_mins / 60;
  const imported_glh = imported_mins / 60;
  const total_glh = ai_glh + imported_glh + teacher_contact_glh;

  // Level breakdown
  const counts = new Map<string, number>();
  for (const lvl of ["e1", "e2", "e3", "l1", "l2"]) counts.set(lvl, 0);
  for (const l of learners) {
    const k = (l.esolLevel ?? "").toLowerCase();
    if (counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const by_level = Array.from(counts.entries()).map(([level, count]) => ({
    level,
    label: LEVEL_LABELS[level] ?? level.toUpperCase(),
    count,
    percent: total_learners > 0 ? ((count / total_learners) * 100).toFixed(1) : "0.0",
  }));

  // Level progression breakdown (e1→e2: 5, e2→e3: 4, …)
  const progressionCounts = new Map<string, number>();
  for (const lc of levelChanges) {
    const key = `${lc.fromLevel}→${lc.toLevel}`;
    progressionCounts.set(key, (progressionCounts.get(key) ?? 0) + 1);
  }
  const level_progression_breakdown = Array.from(progressionCounts.entries())
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ") || "(none)";

  return {
    total_learners,
    total_glh: Math.round(total_glh * 10) / 10,
    ai_glh: Math.round(ai_glh * 10) / 10,
    imported_glh: Math.round(imported_glh * 10) / 10,
    teacher_contact_glh: Math.round(teacher_contact_glh * 10) / 10,
    level_progression_count: levelChanges.length,
    level_progression_breakdown,
    scenarios_passed_total,
    by_level,
  };
};

interface LearnerForReport {
  _id: Types.ObjectId;
  firstname?: string;
  lastname?: string;
  uln?: string | null;
  esolLevel?: string | null;
  starting_level?: string | null;
  esolOnboardedAt?: Date | null;
  assessment_score?: number | null;
  placement_confidence?: number | null;
  skillWeaknessFlags?: string[];
  stage3_objectives?: Array<{
    skill_domain: string;
    description: string;
    set_from?: string | null;
    target_level?: string | null;
  }>;
  assigned_teacher_id?: Types.ObjectId | null;
  glh_teacher_contact?: number;
}

const buildStage1Rows = (
  learners: LearnerForReport[],
): EvidenceReportPayload["stage1_rows"] =>
  learners.map((l) => ({
    uln: l.uln ?? null,
    assessment_date_human:
      l.esolOnboardedAt instanceof Date
        ? l.esolOnboardedAt.toLocaleDateString("en-GB", {
            day: "2-digit", month: "2-digit", year: "2-digit",
          })
        : "—",
    source_label:
      l.assessment_score !== null && l.assessment_score !== undefined
        ? "Platform placement"
        // ForSkills imports may or may not set assessment_score depending
        // on the importer's logic; the absence-of-score heuristic is the
        // best we can do without a dedicated `assessment_source` field.
        : "ForSkills import",
    recommended_level: (l.starting_level ?? l.esolLevel ?? "—").toUpperCase(),
  }));

const buildStage2Rows = (
  learners: LearnerForReport[],
): EvidenceReportPayload["stage2_rows"] =>
  learners.map((l) => {
    // ForSkills sub-scores are imported per-domain; the User doc
    // doesn't currently store them as separate fields (they're
    // aggregated into skillWeaknessFlags at import time). For MVP
    // we show whatever is on the User; if a future ForSkills
    // import populates per-domain scores, swap this projection.
    const flags = l.skillWeaknessFlags ?? [];
    const weakDomains = new Set<ForSkillsDomain>();
    for (const f of flags) {
      const d = ILR_CODE_TO_DOMAIN[f as keyof typeof ILR_CODE_TO_DOMAIN];
      if (d) weakDomains.add(d);
    }
    return {
      uln: l.uln ?? null,
      source_label:
        l.assessment_score !== null && l.assessment_score !== undefined
          ? "Platform placement"
          : "ForSkills import",
      assessment_date_human:
        l.esolOnboardedAt instanceof Date
          ? l.esolOnboardedAt.toLocaleDateString("en-GB", {
              day: "2-digit", month: "2-digit", year: "2-digit",
            })
          : "—",
      // Sub-scores are not on the schema today — render null and the
      // template branches to "Platform placement details" copy.
      scores: null,
      recommended_level: (l.starting_level ?? l.esolLevel ?? "—").toUpperCase(),
      weakness_flags_human: Array.from(weakDomains).join(", ") || "(none)",
      weakness_flags_count: weakDomains.size,
    };
  });

const buildStage3Rows = (
  learners: LearnerForReport[],
): EvidenceReportPayload["stage3_rows"] =>
  learners.map((l) => {
    const objectives = l.stage3_objectives ?? [];
    const grouped = new Map<string, EvidenceReportPayload["stage3_rows"][number]["grouped_by_level"][number]>();
    for (const o of objectives) {
      const level = o.target_level ?? "unspecified";
      if (!grouped.has(level)) {
        grouped.set(level, {
          level,
          level_label:
            level === "unspecified"
              ? "(no level)"
              : LEVEL_LABELS[level] ?? level.toUpperCase(),
          objectives: [],
        });
      }
      grouped.get(level)!.objectives.push({
        skill_domain: o.skill_domain,
        description: o.description,
        source_label:
          o.set_from === "placement_assessment"
            ? "Placement"
            : o.set_from === "level_change"
              ? "Level change"
              : o.set_from === "teacher_override"
                ? "Teacher override"
                : o.set_from ?? "—",
      });
    }
    return {
      uln: l.uln ?? null,
      grouped_by_level: Array.from(grouped.values()),
    };
  });

const buildStage4Rows = async (
  learners: LearnerForReport[],
  sessionsByLearner: Map<string, Array<{
    _id: Types.ObjectId;
    scenario_id?: unknown;
    passed?: boolean | null;
    completedAt?: Date | null;
    createdAt?: Date;
    safeguardingFlagged?: boolean;
    turns?: Array<{ originalInput?: string; deepSeekResponse?: string }>;
  }>>,
): Promise<EvidenceReportPayload["stage4_rows"]> => {
  // Vocab ledger — bulk read once, group by learner
  const vocabRows = await VocabLedger.find({
    learnerId: { $in: learners.map((l) => l._id) },
  })
    .select("learnerId word retained times_encountered last_seen_at")
    .lean();
  const vocabByLearner = new Map<string, typeof vocabRows>();
  for (const v of vocabRows) {
    const k = (v.learnerId as Types.ObjectId).toString();
    if (!vocabByLearner.has(k)) vocabByLearner.set(k, []);
    vocabByLearner.get(k)!.push(v);
  }

  return learners.map((l) => {
    const lk = l._id.toString();
    const sessions = sessionsByLearner.get(lk) ?? [];
    // Filter OUT safeguarding-flagged sessions before any excerpt
    // selection — privacy invariant, brief Function 14 To-Do 1.
    const safeSessions = sessions.filter((s) => s.safeguardingFlagged !== true);

    const vocab = vocabByLearner.get(lk) ?? [];
    const retained = vocab.filter((v) => v.retained === true);
    const total = vocab.length;
    const retention_pct = total > 0 ? Math.round((retained.length / total) * 100) : 0;

    // Top N retained — sort by times_encountered DESC then last_seen_at DESC
    const top_10_retained = retained
      .slice()
      .sort((a, b) => {
        const ax = a as { times_encountered?: number; last_seen_at?: Date };
        const bx = b as { times_encountered?: number; last_seen_at?: Date };
        const tdiff = (bx.times_encountered ?? 0) - (ax.times_encountered ?? 0);
        if (tdiff !== 0) return tdiff;
        const at = ax.last_seen_at ? new Date(ax.last_seen_at).getTime() : 0;
        const bt = bx.last_seen_at ? new Date(bx.last_seen_at).getTime() : 0;
        return bt - at;
      })
      .slice(0, RETAINED_VOCAB_TOP_N)
      .map((v) => (v as { word: string }).word);

    // Excerpt selection — early / mid / late sample of the safe set.
    // Algorithm: sort by completedAt asc, pick indices floor(0/3),
    // floor(N/2), floor(N-1). Falls back gracefully for short sets.
    const ordered = safeSessions
      .slice()
      .sort((a, b) => {
        const at = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        const bt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
        return at - bt;
      });
    const pickIndices: number[] = [];
    if (ordered.length === 0) {
      // no excerpts
    } else if (ordered.length <= SAMPLE_EXCERPTS_PER_LEARNER) {
      for (let i = 0; i < ordered.length; i++) pickIndices.push(i);
    } else {
      pickIndices.push(0);
      pickIndices.push(Math.floor(ordered.length / 2));
      pickIndices.push(ordered.length - 1);
    }
    const excerpts = pickIndices.map((i) => {
      const s = ordered[i];
      const turns = (s.turns ?? []).slice(0, 3); // first 3 turns of the session
      return {
        session_date_human:
          s.completedAt
            ? new Date(s.completedAt).toLocaleDateString("en-GB", {
                day: "numeric", month: "short", year: "numeric",
              })
            : "—",
        scenario_id_human: typeof s.scenario_id === "string" ? s.scenario_id : "general",
        turns: turns.flatMap<{ role: "learner" | "tutor"; text: string }>((t) => {
          const lines: Array<{ role: "learner" | "tutor"; text: string }> = [];
          if (t.originalInput) lines.push({ role: "learner", text: t.originalInput });
          if (t.deepSeekResponse) lines.push({ role: "tutor", text: t.deepSeekResponse });
          return lines;
        }),
      };
    });

    return {
      uln: l.uln ?? null,
      session_count: safeSessions.length,
      scenarios_passed: safeSessions.filter((s) => s.passed === true).length,
      vocab_retention_pct: retention_pct,
      top_10_retained,
      excerpts,
    };
  });
};

const buildStage5Section = async (
  orgId: Types.ObjectId,
  learnerIds: Types.ObjectId[],
  ulnByLearner: Map<string, string | null>,
): Promise<EvidenceReportPayload["stage5"]> => {
  if (learnerIds.length === 0) {
    return { completed_count: 0, pending_count: 0, completed: [], pending: [] };
  }
  const reviews = await Stage5Review.find({
    org_id: orgId,
    learner_id: { $in: learnerIds },
  })
    .sort({ createdAt: 1 })
    .lean();

  // Resolve confirmed_by names (one lookup, deduped)
  const confirmerIds = Array.from(
    new Set(
      reviews
        .filter((r) => (r as { org_admin_confirmed_at?: Date | null }).org_admin_confirmed_at)
        .map((r) => (r as { confirmed_by?: Types.ObjectId }).confirmed_by)
        .filter((id): id is Types.ObjectId => Boolean(id)),
    ),
  );
  const confirmers = confirmerIds.length
    ? await User.find({ _id: { $in: confirmerIds } })
        .select("firstname lastname")
        .lean()
    : [];
  const confirmerNameById = new Map<string, string>();
  for (const c of confirmers) {
    confirmerNameById.set(
      (c._id as Types.ObjectId).toString(),
      `${c.firstname ?? ""} ${c.lastname ?? ""}`.trim() || "(unknown)",
    );
  }

  const completed: EvidenceReportPayload["stage5"]["completed"] = [];
  const pending: EvidenceReportPayload["stage5"]["pending"] = [];

  for (const r of reviews) {
    const lk = ((r as { learner_id: Types.ObjectId }).learner_id).toString();
    const uln = ulnByLearner.get(lk) ?? null;
    const levelCompleted = ((r as { level_completed?: string }).level_completed ?? "").toLowerCase();

    if ((r as { org_admin_confirmed_at?: Date | null }).org_admin_confirmed_at) {
      completed.push({
        uln,
        old_level_label: LEVEL_LABELS[levelCompleted] ?? (levelCompleted.toUpperCase() || "—"),
        // We don't store the "to" level directly on Stage5Review; infer
        // from the next level on the ladder. Renders as the next NQF
        // step ("E2 → E3"). Not ideal — a future LevelChange snapshot
        // on Stage5Review would be cleaner.
        new_level_label: nextLevelLabel(levelCompleted),
        confirmed_at_human: formatDateHuman(
          (r as { org_admin_confirmed_at?: Date }).org_admin_confirmed_at,
        ),
        confirmed_by_name:
          confirmerNameById.get(
            ((r as { confirmed_by?: Types.ObjectId }).confirmed_by ?? new Types.ObjectId()).toString(),
          ) ?? "Org admin",
        learner_self_assessment:
          (r as { learner_self_assessment?: unknown }).learner_self_assessment
            ? String((r as { learner_self_assessment: unknown }).learner_self_assessment)
            : "Not yet recorded — Phase 18 enhancement",
        ai_tutor_summary:
          (r as { ai_tutor_summary?: unknown }).ai_tutor_summary
            ? String((r as { ai_tutor_summary: unknown }).ai_tutor_summary)
            : "Not yet recorded — Phase 18 enhancement",
        next_steps:
          (r as { next_steps?: string | null }).next_steps ??
          `Continue at ${nextLevelLabel(levelCompleted)} with focus on Stage 3 objectives at the new level.`,
      });
    } else {
      pending.push({
        uln,
        created_at_human: formatDateHuman((r as { createdAt?: Date }).createdAt),
      });
    }
  }

  return {
    completed_count: completed.length,
    pending_count: pending.length,
    completed,
    pending,
  };
};

const buildTeacherOversightRows = async (
  learners: LearnerForReport[],
  ulnByLearner: Map<string, string | null>,
  periodStart: Date,
  periodEnd: Date,
): Promise<{
  rows: EvidenceReportPayload["teacher_oversight_rows"];
  aggregates: EvidenceReportPayload["teacher_oversight_aggregates"];
}> => {
  // Pull all teacher reviews for these learners in the period.
  const reviews = await TeacherReview.find({
    learner_id: { $in: learners.map((l) => l._id) },
    created_at: { $gte: periodStart, $lte: periodEnd },
  })
    .select("learner_id teacher_id review_type duration_mins created_at")
    .lean();

  // Resolve teacher names — one round-trip, deduped
  const teacherIds = Array.from(
    new Set(
      learners
        .map((l) => l.assigned_teacher_id)
        .filter((id): id is Types.ObjectId => Boolean(id)),
    ),
  );
  const teachers = teacherIds.length
    ? await User.find({ _id: { $in: teacherIds } })
        .select("firstname lastname")
        .lean()
    : [];
  const teacherNameById = new Map<string, string>();
  for (const t of teachers) {
    teacherNameById.set(
      (t._id as Types.ObjectId).toString(),
      `${t.firstname ?? ""} ${t.lastname ?? ""}`.trim() || "(unnamed)",
    );
  }

  // Group reviews by learner
  const reviewsByLearner = new Map<string, typeof reviews>();
  for (const r of reviews) {
    const lk = ((r as { learner_id: Types.ObjectId }).learner_id).toString();
    if (!reviewsByLearner.has(lk)) reviewsByLearner.set(lk, []);
    reviewsByLearner.get(lk)!.push(r);
  }

  const rows = learners.map((l) => {
    const lk = l._id.toString();
    const teacherId = l.assigned_teacher_id?.toString();
    const learnerReviews = reviewsByLearner.get(lk) ?? [];
    const counts = {
      async_review: 0,
      contact_session: 0,
      pathway_adjustment: 0,
      rarpa_signoff: 0,
    };
    let lastReview: Date | null = null;
    for (const r of learnerReviews) {
      const t = (r as { review_type: keyof typeof counts }).review_type;
      if (t in counts) counts[t] += 1;
      const at = (r as { created_at?: Date }).created_at;
      if (at && (!lastReview || at > lastReview)) lastReview = at;
    }

    return {
      uln: ulnByLearner.get(lk) ?? null,
      teacher_name_or_dash: teacherId
        ? teacherNameById.get(teacherId) ?? "(unnamed)"
        : "(none)",
      total_teacher_glh: (l.glh_teacher_contact ?? 0).toFixed(1),
      counts,
      last_review_human: lastReview ? formatDateHuman(lastReview) : "(none)",
    };
  });

  // Sort: highest total_teacher_glh desc, matches the brief's "the
  // learners with the most teacher contact appear first".
  rows.sort((a, b) => parseFloat(b.total_teacher_glh) - parseFloat(a.total_teacher_glh));

  // ── Cohort aggregates — Final Addendum §12 ────────────────────
  // total_cohort_glh        — sum of every learner's glh_teacher_contact
  // average_reviews_per_learner — reviews-in-period / learner-count
  // top_reviewers_by_glh    — by total period-window GLH contributed
  //                           (duration_mins summed per teacher_id),
  //                           NOT by review COUNT — a teacher who logs
  //                           10 quick async_reviews is below one who
  //                           logged a single 90-min contact session.
  //
  // The TOP_REVIEWER_LIMIT cap keeps the PDF tidy on large orgs
  // and matches the dashboard's leaderboard convention.
  const TOP_REVIEWER_LIMIT = 5;
  const learnerCount = learners.length;
  const reviewCount = reviews.length;

  const cohortGlhRaw = learners.reduce(
    (sum, l) => sum + (l.glh_teacher_contact ?? 0),
    0,
  );

  // Per-teacher GLH from this period's reviews. We tally
  // duration_mins (not glh_teacher_contact on the User) because
  // the aggregates section is scoped to the REPORTING WINDOW —
  // a teacher who logged 50h last year and 5h this period
  // shouldn't dominate the period's leaderboard. Bonus: this
  // also captures contributions from teachers who aren't the
  // currently-assigned teacher (legacy reassignments).
  const glhByTeacher = new Map<string, number>();
  const reviewCountByTeacher = new Map<string, number>();
  for (const r of reviews) {
    const teacherKey = (r as { teacher_id?: Types.ObjectId }).teacher_id?.toString();
    if (!teacherKey) continue;
    const mins = (r as { duration_mins?: number }).duration_mins ?? 0;
    glhByTeacher.set(
      teacherKey,
      (glhByTeacher.get(teacherKey) ?? 0) + mins / 60,
    );
    reviewCountByTeacher.set(
      teacherKey,
      (reviewCountByTeacher.get(teacherKey) ?? 0) + 1,
    );
  }

  // Resolve teacher names for the top-N (may include teachers
  // we didn't fetch above — anyone who reviewed a learner in the
  // period but isn't currently the assigned teacher).
  const extraTeacherIds = Array.from(glhByTeacher.keys())
    .filter((id) => !teacherNameById.has(id))
    .map((id) => new Types.ObjectId(id));
  if (extraTeacherIds.length > 0) {
    const extra = await User.find({ _id: { $in: extraTeacherIds } })
      .select("firstname lastname")
      .lean();
    for (const t of extra) {
      teacherNameById.set(
        (t._id as Types.ObjectId).toString(),
        `${t.firstname ?? ""} ${t.lastname ?? ""}`.trim() || "(unnamed)",
      );
    }
  }

  const topReviewers = Array.from(glhByTeacher.entries())
    .sort((a, b) => b[1] - a[1]) // GLH desc
    .slice(0, TOP_REVIEWER_LIMIT)
    .map(([teacherId, glh]) => ({
      teacher_name: teacherNameById.get(teacherId) ?? "(unnamed)",
      total_glh: glh.toFixed(1),
      review_count: reviewCountByTeacher.get(teacherId) ?? 0,
    }));

  // Average is reviews/learner — guards a zero-learner edge case
  // (an org with no students at all shouldn't divide-by-zero;
  // the row count would already be 0 and the section's empty
  // state covers the rendering).
  const averageReviewsPerLearner =
    learnerCount > 0 ? reviewCount / learnerCount : 0;

  const aggregates: EvidenceReportPayload["teacher_oversight_aggregates"] = {
    total_cohort_glh: cohortGlhRaw.toFixed(1),
    average_reviews_per_learner: averageReviewsPerLearner.toFixed(1),
    learner_count: learnerCount,
    review_count: reviewCount,
    top_reviewers_by_glh: topReviewers,
  };

  return { rows, aggregates };
};

/**
 * ILR summary — read the latest completed ILR export for this org
 * (if any) from the IdempotencyKey collection. Per the brief, the
 * evidence report LINKS to the export; it doesn't reproduce the
 * rows. If there's no completed export, the section flags it.
 */
const buildIlrSection = async (
  orgId: Types.ObjectId,
): Promise<EvidenceReportPayload["ilr"]> => {
  const lock = await IdempotencyKey.findOne({
    operation: "ilr-export",
    org_id: orgId,
    status: "completed",
  })
    .sort({ created_at: -1 })
    .lean();

  if (!lock || !lock.result) {
    return {
      has_linked_export: false,
      export_id: null,
      generated_at_human: "—",
      period_start_human: "—",
      period_end_human: "—",
      compliance_config_version: null,
      rows_exported: 0,
      rows_blocked: 0,
      warnings_count: 0,
      warnings_by_type: [],
    };
  }

  const r = lock.result as {
    export_id?: string;
    period_start?: string;
    period_end?: string;
    config_version?: number | null;
    valid_rows?: unknown[];
    blocked_rows?: unknown[];
    warnings?: Array<{ issue?: { rule?: string } }>;
  };

  const byType = new Map<string, number>();
  for (const w of r.warnings ?? []) {
    const t = w.issue?.rule ?? "unknown";
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }

  return {
    has_linked_export: true,
    export_id: r.export_id ?? null,
    generated_at_human: formatDateHuman((lock as { created_at?: Date }).created_at),
    period_start_human: formatDateHuman(r.period_start),
    period_end_human: formatDateHuman(r.period_end),
    compliance_config_version: r.config_version ?? null,
    rows_exported: (r.valid_rows ?? []).length,
    rows_blocked: (r.blocked_rows ?? []).length,
    warnings_count: (r.warnings ?? []).length,
    warnings_by_type: Array.from(byType.entries()).map(([type, count]) => ({ type, count })),
  };
};

/**
 * Safeguarding section — aggregate-only.
 *
 * The data we project here is COUNTS by category + resolution
 * timings. NO learner_id, NO messageContentHash, NO alert detail
 * crosses this boundary. Brief Function 10 + Function 14 To-Do 1.
 */
const buildSafeguardingSection = async (
  orgId: Types.ObjectId,
  periodStart: Date,
  periodEnd: Date,
): Promise<EvidenceReportPayload["safeguarding"]> => {
  const alerts = await SafeguardingAlert.find({
    orgId,
    createdAt: { $gte: periodStart, $lte: periodEnd },
  })
    .select("triggerCategory createdAt resolvedAt")
    .lean();

  const byCategoryMap = new Map<string, number>();
  let resolved_count = 0;
  const resolutionDays: number[] = [];
  let oldestUnresolvedDays: number | null = null;
  const now = Date.now();

  for (const a of alerts) {
    const cat = (a as { triggerCategory?: string }).triggerCategory ?? "other";
    byCategoryMap.set(cat, (byCategoryMap.get(cat) ?? 0) + 1);
    const createdAt = (a as { createdAt: Date }).createdAt;
    const resolvedAt = (a as { resolvedAt?: Date | null }).resolvedAt;
    if (resolvedAt) {
      resolved_count += 1;
      const ms = resolvedAt.getTime() - createdAt.getTime();
      resolutionDays.push(ms / (24 * 60 * 60 * 1000));
    } else {
      const days = Math.floor((now - createdAt.getTime()) / (24 * 60 * 60 * 1000));
      if (oldestUnresolvedDays === null || days > oldestUnresolvedDays) {
        oldestUnresolvedDays = days;
      }
    }
  }

  resolutionDays.sort((a, b) => a - b);
  const avg = resolutionDays.length
    ? resolutionDays.reduce((s, n) => s + n, 0) / resolutionDays.length
    : 0;
  const median = resolutionDays.length
    ? resolutionDays[Math.floor(resolutionDays.length / 2)]
    : 0;

  return {
    period_start_human: formatDateHuman(periodStart),
    period_end_human: formatDateHuman(periodEnd),
    total: alerts.length,
    by_category: Array.from(byCategoryMap.entries()).map(([cat, count]) => ({
      category_label: CATEGORY_LABELS[cat] ?? cat,
      count,
    })),
    resolved_count,
    resolution_rate_pct:
      alerts.length > 0 ? Math.round((resolved_count / alerts.length) * 100) : 0,
    avg_resolution_days: avg.toFixed(1),
    median_resolution_days: median.toFixed(1),
    oldest_unresolved_days: oldestUnresolvedDays ?? "—",
  };
};

// ─────────────────────────────────────────────────────────────────────
// Small formatting helpers
// ─────────────────────────────────────────────────────────────────────

const formatDateHuman = (v: Date | string | null | undefined): string => {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });
};

const nextLevelLabel = (lvl: string): string => {
  const ladder = ["e1", "e2", "e3", "l1", "l2"];
  const i = ladder.indexOf(lvl);
  if (i < 0 || i === ladder.length - 1) return "—";
  return LEVEL_LABELS[ladder[i + 1]];
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry — generateEvidenceReport
// ─────────────────────────────────────────────────────────────────────

const ensureExportDir = async () => {
  await mkdir(EVIDENCE_REPORT_DIR, { recursive: true });
};

/**
 * Deterministic idempotency key for the evidence-report pipeline —
 * brief Function 14 To-Do 5.
 *
 *   key = sha256(`${org_id}|${period_start}|${period_end}|evidence_report`)
 *
 * The trailing `evidence_report` literal namespaces this key against
 * future report types over the same period window (e.g. an "audit
 * pack" or a "termly summary" we might add later) so they don't
 * collide on the same IdempotencyKey row.
 *
 * Used as:
 *   - the IdempotencyKey lock (TTL 90 days; "30-day cache" target in
 *     the brief is satisfied with margin to spare)
 *   - the on-disk PDF filename `${EVIDENCE_REPORT_DIR}/<reportId>.pdf`
 *
 * The route layer computes this ahead of enqueueing so the cache check
 * can short-circuit the whole pipeline without touching the queue.
 */
export const computeEvidenceReportIdempotencyKey = (input: {
  org_id: string;
  period_start: string;
  period_end: string;
}): string =>
  createHash("sha256")
    .update(
      `${input.org_id}|${input.period_start}|${input.period_end}|evidence_report`,
    )
    .digest("hex");

export const generateEvidenceReport = async (
  orgId: string,
  periodStart: string,
  periodEnd: string,
  options: { reportId?: string } = {},
): Promise<GenerateEvidenceReportResult> => {
  // ── Input validation ──────────────────────────────────────────────
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    throw new ApiError(400, "org_id must be a valid ObjectId");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart)) {
    throw new ApiError(400, "period_start must be YYYY-MM-DD");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    throw new ApiError(400, "period_end must be YYYY-MM-DD");
  }
  const periodStartDate = new Date(`${periodStart}T00:00:00.000Z`);
  const periodEndDate = new Date(`${periodEnd}T23:59:59.999Z`);
  if (periodStartDate > periodEndDate) {
    throw new ApiError(400, "period_start must be on or before period_end");
  }

  const orgObjectId = new Types.ObjectId(orgId);

  // ── Load core entities ────────────────────────────────────────────
  const org = await Organisation.findById(orgObjectId)
    .select("name logo_url")
    .lean();
  if (!org) throw new ApiError(404, "Organisation not found");

  const learners = (await User.find({
    orgId: orgObjectId,
    role: "student",
  })
    .select(
      "_id firstname lastname uln esolLevel starting_level esolOnboardedAt " +
        "assessment_score placement_confidence skillWeaknessFlags " +
        "stage3_objectives assigned_teacher_id glh_teacher_contact",
    )
    .lean()) as LearnerForReport[];

  const learnerIds = learners.map((l) => l._id);
  const ulnByLearner = new Map<string, string | null>(
    learners.map((l) => [l._id.toString(), l.uln ?? null]),
  );

  const sessions = await AISession.find({
    learnerId: { $in: learnerIds },
    orgId: orgObjectId,
    createdAt: { $gte: periodStartDate, $lte: periodEndDate },
  })
    .select(
      "_id learnerId scenario_id session_source duration_mins passed completedAt createdAt safeguardingFlagged turns",
    )
    .lean();

  const sessionsByLearner = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const k = (s.learnerId as Types.ObjectId).toString();
    if (!sessionsByLearner.has(k)) sessionsByLearner.set(k, []);
    sessionsByLearner.get(k)!.push(s);
  }

  const levelChanges = await LevelChange.find({
    learnerId: { $in: learnerIds },
    effectiveDate: { $gte: periodStartDate, $lte: periodEndDate },
  })
    .select("fromLevel toLevel effectiveDate")
    .lean();

  const teacherContactByLearner = new Map<string, number>(
    learners.map((l) => [l._id.toString(), l.glh_teacher_contact ?? 0]),
  );

  // ── Compose payload ──────────────────────────────────────────────
  // Caller (worker) passes the deterministic idempotency key so the
  // on-disk file lines up with the download URL. Standalone callers
  // (tests, manual one-offs) get a randomUUID fallback.
  const reportId = options.reportId ?? randomUUID();
  const now = new Date();

  const payload: EvidenceReportPayload = {
    report_id: reportId,
    generated_at: now.toISOString(),
    generated_at_human: now.toLocaleString("en-GB", {
      day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/London",
    }),
    period_start: periodStart,
    period_end: periodEnd,
    period_start_human: formatDateHuman(periodStart),
    period_end_human: formatDateHuman(periodEnd),
    org: {
      id: orgObjectId.toString(),
      name: org.name ?? "(unnamed organisation)",
      logo_url: (org as { logo_url?: string | null }).logo_url ?? null,
    },
    cohort: buildCohortSection(learners, sessions, levelChanges, teacherContactByLearner),
    stage1_rows: buildStage1Rows(learners),
    stage2_rows: buildStage2Rows(learners),
    stage3_rows: buildStage3Rows(learners),
    stage4_rows: await buildStage4Rows(learners, sessionsByLearner),
    stage5: await buildStage5Section(orgObjectId, learnerIds, ulnByLearner),
    // Final Addendum §12 — teacher oversight builder now returns
    // both rows + aggregates. Destructure inline so the payload
    // composition reads top-to-bottom without an intermediate.
    ...(await (async () => {
      const { rows, aggregates } = await buildTeacherOversightRows(
        learners,
        ulnByLearner,
        periodStartDate,
        periodEndDate,
      );
      return {
        teacher_oversight_rows: rows,
        teacher_oversight_aggregates: aggregates,
      };
    })()),
    ilr: await buildIlrSection(orgObjectId),
    safeguarding: await buildSafeguardingSection(
      orgObjectId,
      periodStartDate,
      periodEndDate,
    ),
  };

  // ── Render HTML ──────────────────────────────────────────────────
  const html = getTemplate()(payload);

  // ── Render PDF via the existing puppeteer pipeline ───────────────
  const pdfBuffer = await generatePdfFromHtml(html, { format: "A4" });

  // ── Cache to disk (Function 14 To-Do 5) ──────────────────────────
  // Best-effort write — the buffer is returned regardless. The route
  // layer that downloads from disk falls back to a fresh regenerate
  // if the file is missing.
  await ensureExportDir().catch(() => undefined);
  const pdfPath = resolve(EVIDENCE_REPORT_DIR, `${reportId}.pdf`);
  await writeFile(pdfPath, pdfBuffer).catch((err) =>
    logger.error(
      { err: (err as Error).message, reportId, pdfPath },
      "generateEvidenceReport: PDF cache write failed (buffer still returned)",
    ),
  );

  logger.info(
    {
      reportId,
      orgId,
      period_start: periodStart,
      period_end: periodEnd,
      learner_count: learners.length,
      pdf_bytes: pdfBuffer.length,
    },
    "generateEvidenceReport: complete",
  );

  return { pdf_buffer: pdfBuffer, report_id: reportId, payload };
};

// Re-exports for tests
export const __internals__ = {
  buildCohortSection,
  buildStage1Rows,
  buildStage2Rows,
  buildStage3Rows,
  buildStage4Rows,
  buildStage5Section,
  buildTeacherOversightRows,
  buildIlrSection,
  buildSafeguardingSection,
  nextLevelLabel,
  formatDateHuman,
  getTemplate,
  LEVEL_LABELS,
  REVIEW_TYPE_LABELS,
  CATEGORY_LABELS,
};
