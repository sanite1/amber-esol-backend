/**
 * Daily re-engagement cron — Final Addendum §11.
 *
 *   GET /api/cron/re-engagement
 *
 * Weekdays at 09:00 UTC the cron sweeps every dormant learner
 * who's been quiet for 15+ days, finds an eligible teacher to
 * "send" from, renders the dormant_re_engagement template, and
 * delegates to `autoSendTeacherMessage` for the durable write +
 * audit + email plumbing.
 *
 * Eligibility filters (in order)
 * ==============================
 *
 *   1. `User.cohort_status === "dormant"` (set by the Phase 13.4
 *      cohort-status cron).
 *   2. `last_session_at < now − 15d` — the dormant cohort_status
 *      can include learners who were JUST flagged dormant; the
 *      15-day window is the brief's "really gone quiet" threshold.
 *   3. No `TeacherMessage` with `trigger: "re_engagement_cron"`
 *      sent to this learner in the last 14 days — don't nag the
 *      same learner every weekday.
 *   4. `assigned_teacher_id` is set AND the teacher's
 *      `auto_re_engagement_enabled !== false`. Teachers who
 *      explicitly turned the auto-send off are skipped; the
 *      learner stays in the dormant pool but doesn't get a
 *      message from this teacher on this run.
 *
 * Cap + ordering
 * ==============
 *
 * Oldest dormant learners (by `last_session_at` ASC) first, capped
 * at `MAX_PER_RUN` to keep cron wall-clock bounded and avoid a
 * single-day spam. Learners not reached in this run stay at the
 * top of the queue tomorrow.
 *
 * Atomicity
 * =========
 *
 * Each `autoSendTeacherMessage` call is independent — translation
 * failures or notification-enqueue failures on one learner do not
 * block the rest of the batch. The summary audit row records
 * tallies for ops.
 */

import { Types } from "mongoose";
import User from "../models/User";
import TeacherMessage from "../models/TeacherMessage";
import { writeAuditLog } from "./auditLog.service";
import { autoSendTeacherMessage } from "./teacherMessageAutoSend.service";
import logger from "../config/logger";
// Template deck — loaded once at module init.
import teacherMessageTemplates from "../data/teacher-message-templates.json";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DORMANT_DAYS = 15;
const REENGAGEMENT_COOLDOWN_DAYS = 14;
const MAX_PER_RUN = 50;
const TEMPLATE_ID = "dormant_re_engagement";

// ─────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────

export interface FanOutReEngagementResult {
  date: string;
  dormant_cohort_size: number;
  candidates_considered: number;
  messages_sent: number;
  skipped: {
    no_assigned_teacher: number;
    teacher_opted_out: number;
    recently_messaged: number;
    translation_failed: number;
    create_failed: number;
    template_missing: number;
  };
}

// ─────────────────────────────────────────────────────────────────────
// Template renderer
// ─────────────────────────────────────────────────────────────────────

type TemplateDeck = Record<string, Record<string, unknown>>;

/**
 * Render the named template into English. The cron always feeds the
 * `en` slot through Gemini for L1 translation downstream (so we
 * don't keep multiple translated copies of the same templated
 * message in sync at the file level).
 *
 * Returns null when the template id is missing — defensive against
 * a future deck reshuffle that drops the dormant key.
 */
const renderTeacherMessageTemplate = (
  templateId: string,
  firstname: string,
): string | null => {
  const deck = teacherMessageTemplates as unknown as TemplateDeck;
  const slot = deck[templateId];
  if (!slot || typeof slot !== "object") return null;
  const en = (slot as { en?: unknown }).en;
  if (typeof en !== "string" || en.length === 0) return null;
  // {{firstname}} is the only interpolation today. Replace ALL
  // occurrences so a future template using the name twice doesn't
  // surprise authors.
  return en.replace(/\{\{firstname\}\}/g, firstname || "there");
};

// ─────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────

export const fanOutReEngagement =
  async (): Promise<FanOutReEngagementResult> => {
    const date = new Date().toISOString().slice(0, 10);
    const now = Date.now();
    const dormantCutoff = new Date(now - DORMANT_DAYS * MS_PER_DAY);
    const cooldownCutoff = new Date(
      now - REENGAGEMENT_COOLDOWN_DAYS * MS_PER_DAY,
    );

    // Headline cohort size first — useful for the audit row even
    // when the candidate list is then capped below.
    const dormantCohortSize = await User.countDocuments({
      role: "student",
      cohort_status: "dormant",
    });

    // ── Candidate pool ────────────────────────────────────────
    // Pull only the dormant learners who pass filters 1 + 2 + 4
    // at query time. Filter 3 (the 14-day re-engagement cooldown)
    // needs a join — easier in JS once the pool is bounded.
    //
    // We over-fetch (MAX_PER_RUN * 4) to leave headroom for
    // cooldown / teacher-opt-out filtering without a second pass.
    const overFetchLimit = MAX_PER_RUN * 4;
    const candidates = await User.find({
      role: "student",
      cohort_status: "dormant",
      last_session_at: { $lt: dormantCutoff, $ne: null },
    })
      .sort({ last_session_at: 1 }) // oldest-dormant first per brief
      .limit(overFetchLimit)
      .select(
        "_id firstname lastname email l1Language assigned_teacher_id orgId last_session_at",
      )
      .lean();

    const skipped = {
      no_assigned_teacher: 0,
      teacher_opted_out: 0,
      recently_messaged: 0,
      translation_failed: 0,
      create_failed: 0,
      template_missing: 0,
    };

    if (candidates.length === 0) {
      await writeSummaryAudit({
        date,
        dormant_cohort_size: dormantCohortSize,
        candidates_considered: 0,
        messages_sent: 0,
        skipped,
      });
      return {
        date,
        dormant_cohort_size: dormantCohortSize,
        candidates_considered: 0,
        messages_sent: 0,
        skipped,
      };
    }

    // ── Cooldown filter ────────────────────────────────────────
    // One query against TeacherMessage for the union of candidate
    // ids covers every learner at once — cheaper than per-learner
    // round-trips.
    const candidateIds = candidates.map((c) => c._id);
    const recentNudges = await TeacherMessage.find({
      learner_id: { $in: candidateIds },
      trigger: "re_engagement_cron",
      sent_at: { $gte: cooldownCutoff },
    })
      .select("learner_id")
      .lean();
    const recentlyNudged = new Set(
      recentNudges.map((m) => (m.learner_id as Types.ObjectId).toString()),
    );

    // ── Teacher batch lookup ─────────────────────────────────
    // Fetch every distinct assigned teacher in one round-trip.
    const teacherIds = Array.from(
      new Set(
        candidates
          .map(
            (c) =>
              (
                c as { assigned_teacher_id?: Types.ObjectId | null }
              ).assigned_teacher_id?.toString() ?? "",
          )
          .filter(Boolean),
      ),
    ).map((id) => new Types.ObjectId(id));

    const teachers = await User.find({ _id: { $in: teacherIds } })
      .select("_id auto_re_engagement_enabled")
      .lean();
    const teacherById = new Map<
      string,
      { auto_re_engagement_enabled?: boolean }
    >(teachers.map((t) => [(t._id as Types.ObjectId).toString(), t]));

    // ── Per-learner send loop ────────────────────────────────
    let sent = 0;
    let consideredAfterFilters = 0;
    for (const learner of candidates) {
      if (sent >= MAX_PER_RUN) break;
      const learnerId = (learner._id as Types.ObjectId).toString();

      // Filter 4a — assignment present?
      const teacherIdRaw = (
        learner as { assigned_teacher_id?: Types.ObjectId | null }
      ).assigned_teacher_id;
      if (!teacherIdRaw) {
        skipped.no_assigned_teacher += 1;
        continue;
      }
      const teacherId = teacherIdRaw.toString();

      // Filter 4b — teacher opted out?
      const teacher = teacherById.get(teacherId);
      if (teacher && teacher.auto_re_engagement_enabled === false) {
        skipped.teacher_opted_out += 1;
        continue;
      }

      // Filter 3 — recently nudged?
      if (recentlyNudged.has(learnerId)) {
        skipped.recently_messaged += 1;
        continue;
      }

      consideredAfterFilters += 1;

      // Render template
      const firstname = (learner as { firstname?: string }).firstname ?? "";
      const messageText = renderTeacherMessageTemplate(TEMPLATE_ID, firstname);
      if (!messageText) {
        skipped.template_missing += 1;
        logger.error(
          { templateId: TEMPLATE_ID },
          "fanOutReEngagement: dormant template missing — aborting batch",
        );
        // Hard stop — no point looping if the template is broken.
        break;
      }

      const orgId =
        (learner as { orgId?: Types.ObjectId | null }).orgId?.toString() ?? "";
      if (!orgId) {
        skipped.create_failed += 1;
        logger.warn(
          { learnerId },
          "fanOutReEngagement: learner has no orgId — skipping",
        );
        continue;
      }

      const result = await autoSendTeacherMessage({
        teacher_id: teacherId,
        learner_id: learnerId,
        org_id: orgId,
        message_text: messageText,
        translate_to_l1: true,
        trigger: "re_engagement_cron",
        learner_email: (learner as { email?: string | null }).email ?? null,
        learner_l1_language:
          (learner as { l1Language?: string | null }).l1Language ?? null,
      });

      if (result.status === "ok") {
        sent += 1;
      } else if (result.status === "translation_failed") {
        skipped.translation_failed += 1;
      } else {
        skipped.create_failed += 1;
      }
    }

    // ── Summary audit row ────────────────────────────────────
    await writeSummaryAudit({
      date,
      dormant_cohort_size: dormantCohortSize,
      candidates_considered: consideredAfterFilters,
      messages_sent: sent,
      skipped,
    });

    logger.info(
      {
        date,
        dormant_cohort_size: dormantCohortSize,
        candidates_considered: consideredAfterFilters,
        messages_sent: sent,
        skipped,
      },
      "fanOutReEngagement: complete",
    );

    return {
      date,
      dormant_cohort_size: dormantCohortSize,
      candidates_considered: consideredAfterFilters,
      messages_sent: sent,
      skipped,
    };
  };

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const writeSummaryAudit = async (
  payload: FanOutReEngagementResult,
): Promise<void> => {
  await writeAuditLog({
    actor_type: "system",
    actor_id: null,
    org_id: null,
    learner_id: null,
    action: "re_engagement_cron_dispatched",
    before_state: null,
    after_state: payload,
    reason:
      `Re-engagement cron dispatched: ${payload.messages_sent} message${payload.messages_sent === 1 ? "" : "s"} sent ` +
      `from a dormant cohort of ${payload.dormant_cohort_size}. ` +
      `Considered ${payload.candidates_considered} after filters; ` +
      `skipped ${payload.skipped.recently_messaged} recently-nudged, ` +
      `${payload.skipped.teacher_opted_out} teacher-opted-out, ` +
      `${payload.skipped.no_assigned_teacher} unassigned, ` +
      `${payload.skipped.translation_failed} translation-failed.`,
  });
};

export const __internals__ = {
  renderTeacherMessageTemplate,
  MAX_PER_RUN,
  DORMANT_DAYS,
  REENGAGEMENT_COOLDOWN_DAYS,
  TEMPLATE_ID,
};
