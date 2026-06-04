import ApiError from "../errors/apiError";
import User from "../models/User";
import Organisation from "../models/Organisation";
import Booking from "../models/Booking";
import AISession from "../models/AISession";
import LevelChange from "../models/LevelChange";
import VocabLedger from "../models/VocabLedger";
import SafeguardingAlert from "../models/SafeguardingAlert";
import SessionFeedback from "../models/SessionFeedback";
import {
  buildIntegrationReadinessHtml,
  IntegrationReadinessData,
} from "./templates/integrationReadinessTemplate";
import { generatePdfFromHtml } from "./pdfGenerator.service";

/**
 * Hours contributed by one AISession to GLH totals.
 *
 * Live AI tutor sessions store the span implicitly: `completedAt -
 * createdAt`. Pre-platform imports (brief Function 5) set both fields
 * to `session_date`, so the span is zero — the real duration lives in
 * `duration_mins` because the importer wrote it there explicitly.
 *
 *   - If `duration_mins` is set → use it (convert minutes → hours).
 *   - Else if `completedAt` is set → fall back to the span calc.
 *   - Else → 0 (session is still in progress).
 *
 * Always clamped to ≥ 0 so a clock-skewed timestamp can't subtract
 * from the cohort total.
 */
const sessionHours = (s: {
  duration_mins?: number | null;
  completedAt?: Date | null;
  createdAt?: Date;
}): number => {
  if (typeof s.duration_mins === "number" && s.duration_mins > 0) {
    return s.duration_mins / 60;
  }
  if (s.completedAt && s.createdAt) {
    const dur =
      (s.completedAt.getTime() - new Date(s.createdAt).getTime()) /
      (1000 * 60 * 60);
    return Math.max(0, dur);
  }
  return 0;
};

/**
 * ILR fields per spec D3.6 — official names so a college MIS can import directly.
 * Critical fields cause learner record validation failure if missing.
 */
interface IlrRow {
  LearnRefNumber: string;
  ULN: string;
  GivenNames: string;
  FamilyName: string;
  DateOfBirth: string;
  Ethnicity: string;
  LLDDHealthProb: string;
  LearnStartDate: string;
  LearnPlanEndDate: string;
  FundModel: string;
  LearnAimRef: string;
  PlannedHours: string;
  ActualHours: string;
  Outcome: string;
  Postcode: string;
  ProviderRef: string;
}

const ILR_HEADERS: { key: keyof IlrRow; label: string }[] = [
  { key: "LearnRefNumber", label: "LearnRefNumber" },
  { key: "ULN", label: "ULN" },
  { key: "GivenNames", label: "GivenNames" },
  { key: "FamilyName", label: "FamilyName" },
  { key: "DateOfBirth", label: "DateOfBirth" },
  { key: "Ethnicity", label: "Ethnicity" },
  { key: "LLDDHealthProb", label: "LLDDHealthProb" },
  { key: "LearnStartDate", label: "LearnStartDate" },
  { key: "LearnPlanEndDate", label: "LearnPlanEndDate" },
  { key: "FundModel", label: "FundModel" },
  { key: "LearnAimRef", label: "LearnAimRef" },
  { key: "PlannedHours", label: "PlannedHours" },
  { key: "ActualHours", label: "ActualHours" },
  { key: "Outcome", label: "Outcome" },
  { key: "Postcode", label: "Postcode" },
  { key: "ProviderRef", label: "ProviderRef" },
];

/**
 * Map ESOL NQF level to ILR LearnAimRef code (FALA — ESFA placeholder codes).
 * Real codes maintained by Amber admin in the LearnAimRef mapping table.
 */
const LEARN_AIM_REF_MAP: Record<string, string> = {
  "Entry 1": "60185751",
  "Entry 2": "60185763",
  "Entry 3": "60185775",
  "Level 1": "60185787",
  "Level 2": "60185799",
};

const csvEscape = (value: string): string => {
  if (value == null) return "";
  let str = String(value);
  // Neutralise CSV/spreadsheet formula-injection: cells that begin with
  // =, +, -, @, tab, or CR are interpreted as formulas by Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const formatIsoDate = (d?: Date | string | null): string => {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "";
  return date.toISOString().split("T")[0];
};

const computeHours = (
  startTime: string,
  endTime: string
): number => {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  return Math.max(0, (endMin - startMin) / 60);
};

export interface IlrReport {
  csv: string;
  filename: string;
  rowCount: number;
}

export const generateIlrCsvService = async (params: {
  orgId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<IlrReport> => {
  const org = await Organisation.findById(params.orgId);
  if (!org) {
    throw new ApiError(404, "Organisation not found");
  }

  const periodStart = new Date(params.periodStart);
  const periodEnd = new Date(params.periodEnd);
  if (periodEnd < periodStart) {
    throw new ApiError(400, "Period end must be after period start");
  }

  // Find all learners in this org (excluding demo data)
  const learners = await User.find({
    role: "student",
    orgId: org._id,
  }).select(
    "firstname lastname email uln dateOfBirth address esolLevel l1Language fundingStatus esolOnboardedAt ethnicity lldd_health_prob current_level"
  );

  // Aggregate hours per learner from completed org-invoiced bookings in the period
  const bookings = await Booking.find({
    orgId: org._id,
    paymentStatus: "org_invoiced",
    status: "completed",
    completedAt: { $gte: periodStart, $lte: periodEnd },
  }).select("studentId startTime endTime");

  const hoursByLearner: Record<string, { hours: number; sessions: number }> = {};
  for (const b of bookings) {
    const id = b.studentId.toString();
    if (!hoursByLearner[id]) hoursByLearner[id] = { hours: 0, sessions: 0 };
    hoursByLearner[id].hours += computeHours(b.startTime, b.endTime);
    hoursByLearner[id].sessions += 1;
  }

  const planEndDate = org.contractEnd
    ? formatIsoDate(org.contractEnd)
    : formatIsoDate(
        new Date(periodEnd.getFullYear() + 1, periodEnd.getMonth(), periodEnd.getDate())
      );

  const rows: IlrRow[] = learners.map((l: any) => {
    const stats = hoursByLearner[l._id.toString()] ?? {
      hours: 0,
      sessions: 0,
    };
    const level = l.current_level ?? l.esolLevel ?? "Entry 1";
    return {
      LearnRefNumber: String(l._id).slice(-12),
      ULN: l.uln ?? "",
      GivenNames: l.firstname ?? "",
      FamilyName: l.lastname ?? "",
      DateOfBirth: formatIsoDate(l.dateOfBirth),
      Ethnicity: l.ethnicity ?? "",
      LLDDHealthProb: String(l.lldd_health_prob ?? 9),
      LearnStartDate: formatIsoDate(l.esolOnboardedAt),
      LearnPlanEndDate: planEndDate,
      FundModel: "38", // FM38 — Adult Skills formula-funded
      LearnAimRef: LEARN_AIM_REF_MAP[level] ?? "",
      PlannedHours: stats.hours.toFixed(0),
      ActualHours: stats.hours.toFixed(0),
      Outcome: "2", // 2 = Continuing (default until learner withdraws or achieves)
      Postcode: l.address?.postcode ?? "",
      ProviderRef: org.ilrProviderRef ?? "",
    };
  });

  // Build CSV
  const headerLine = ILR_HEADERS.map((h) => csvEscape(h.label)).join(",");
  const rowLines = rows.map((row) =>
    ILR_HEADERS.map((h) => csvEscape(row[h.key] ?? "")).join(",")
  );
  const csv = [headerLine, ...rowLines].join("\n");

  const startStr = formatIsoDate(periodStart);
  const endStr = formatIsoDate(periodEnd);
  const filename = `ilr-${org.slug}-${startStr}-to-${endStr}.csv`;

  return {
    csv,
    filename,
    rowCount: rows.length,
  };
};

/* ── Integration Readiness Report (8-section monthly PDF) ── */

export const generateIntegrationReadinessPdf = async (params: {
  orgId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<{ pdf: Buffer; filename: string }> => {
  const org = await Organisation.findById(params.orgId);
  if (!org) throw new ApiError(404, "Organisation not found");

  const periodStart = new Date(params.periodStart);
  const periodEnd = new Date(params.periodEnd);

  // Cohort
  const learners = await User.find({ role: "student", orgId: org._id }).select(
    "firstname lastname uln esolOnboardedAt current_level esolLevel last_active_at"
  );

  const sessionsThisPeriod = await AISession.find({
    orgId: org._id,
    createdAt: { $gte: periodStart, $lte: periodEnd },
  }).select(
    // duration_mins + session_source added in brief Function 5 — pre-platform
    // imports store their span as duration_mins because their createdAt and
    // completedAt are the same instant (session_date).
    "learnerId completedAt turns vocabIntroduced duration_mins session_source"
  );

  const totalHours = sessionsThisPeriod.reduce(
    (sum, s) => sum + sessionHours(s),
    0
  );
  const avgHours = learners.length ? totalHours / learners.length : 0;

  const activeLearnerIds = new Set(
    sessionsThisPeriod.map((s) => s.learnerId.toString())
  );

  // Level progression
  const levelChanges = await LevelChange.find({
    orgId: org._id,
    createdAt: { $gte: periodStart, $lte: periodEnd },
  }).populate("learnerId", "firstname lastname");

  const progressionMap: Record<string, number> = {};
  for (const lc of levelChanges) {
    const key = `${lc.fromLevel || "(unset)"}→${lc.toLevel}`;
    progressionMap[key] = (progressionMap[key] || 0) + 1;
  }
  const levelProgression = Object.entries(progressionMap).map(([key, count]) => {
    const [fromLevel, toLevel] = key.split("→");
    return { fromLevel, toLevel, count };
  });

  // Individual learner records
  const learnerStatsMap: Record<
    string,
    { hours: number; scenarios: Set<string>; vocab: Set<string> }
  > = {};
  for (const s of sessionsThisPeriod) {
    const id = s.learnerId.toString();
    if (!learnerStatsMap[id]) {
      learnerStatsMap[id] = { hours: 0, scenarios: new Set(), vocab: new Set() };
    }
    const dur = sessionHours(s);
    if (dur > 0) {
      learnerStatsMap[id].hours += dur;
      if ((s as any).topic) learnerStatsMap[id].scenarios.add((s as any).topic);
    }
    for (const v of s.vocabIntroduced ?? []) {
      learnerStatsMap[id].vocab.add(v);
    }
  }

  const individualLearners = learners.map((l: any) => {
    const stats = learnerStatsMap[l._id.toString()] ?? {
      hours: 0,
      scenarios: new Set(),
      vocab: new Set(),
    };
    return {
      name: `${l.firstname} ${l.lastname}`,
      uln: l.uln ?? "",
      startDate: l.esolOnboardedAt ?? null,
      currentLevel: l.current_level ?? l.esolLevel ?? "—",
      hours: stats.hours,
      scenarios: stats.scenarios.size,
      vocabRetained: stats.vocab.size,
      lastActive: l.last_active_at ?? null,
    };
  });

  // Curriculum coverage
  const curriculumCoverage = await Promise.all(
    learners.slice(0, 12).map(async (l: any) => {
      const ls = sessionsThisPeriod.filter(
        (s) => s.learnerId.toString() === l._id.toString()
      );
      const codes = new Set<string>();
      for (const s of ls) {
        for (const t of s.turns ?? []) {
          // skill codes embedded in turn, if available
          const tt = t as any;
          if (tt.skill_codes_used) {
            for (const c of tt.skill_codes_used) codes.add(c);
          }
        }
      }
      return {
        learnerName: `${l.firstname} ${l.lastname}`,
        skillCodes: Array.from(codes),
      };
    })
  );

  // Safeguarding
  const alerts = await SafeguardingAlert.find({
    orgId: org._id,
    createdAt: { $gte: periodStart, $lte: periodEnd },
  });

  // Learner voice (only positive ratings)
  const feedback = await SessionFeedback.find({
    orgId: org._id,
    createdAt: { $gte: periodStart, $lte: periodEnd },
    $or: [{ emojiRating: "okay" }, { emojiRating: "confident" }],
  })
    .limit(5)
    .select("learnerComment emojiRating");

  const data: IntegrationReadinessData = {
    orgName: org.name,
    periodStart,
    periodEnd,
    cohort: {
      activeLearners: activeLearnerIds.size,
      avgHours,
      retentionRate: learners.length
        ? activeLearnerIds.size / learners.length
        : 0,
      momChange: 0, // would need previous month — placeholder
    },
    levelProgression,
    individualLearners,
    curriculumCoverage,
    transitionReady: [], // populated by progression matrix in a future iteration
    certificates: levelChanges.map((lc: any) => ({
      name:
        typeof lc.learnerId === "object"
          ? `${lc.learnerId.firstname} ${lc.learnerId.lastname}`
          : "Learner",
      fromLevel: lc.fromLevel || "(unset)",
      toLevel: lc.toLevel,
      date: lc.createdAt,
    })),
    safeguarding: {
      totalAlerts: alerts.length,
      open: alerts.filter((a) => a.status === "open").length,
      reviewed: alerts.filter((a) => a.status === "reviewed").length,
      escalated: alerts.filter((a) => a.status === "escalated").length,
      resolved: alerts.filter((a) => a.status === "resolved").length,
      dismissed: alerts.filter((a) => a.status === "dismissed").length,
    },
    learnerVoice: feedback
      .filter((f) => f.learnerComment)
      .map((f) => ({
        quote: f.learnerComment!,
        rating: (f as any).emojiRating as "okay" | "confident",
      })),
  };

  const html = buildIntegrationReadinessHtml(data);
  const pdf = await generatePdfFromHtml(html);
  const filename = `integration-readiness-${org.slug}-${formatIsoDate(periodEnd)}.pdf`;
  return { pdf, filename };
};
