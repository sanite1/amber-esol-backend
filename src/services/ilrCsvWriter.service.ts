/**
 * ILR CSV writer — brief Function 13 To-Do 4.
 *
 * Serialises the validated `IlrRow[]` to RFC-4180 CSV. Applies the
 * compliance config's `field_name_overrides` at column-header time
 * (the rows themselves carry canonical names per Function 13 To-Do 2
 * §3 — only the header line is rewritten).
 *
 * Also produces the companion JSON metadata file per the brief: GLH
 * totals split by source (AI vs imported vs teacher contact),
 * learner_count, rows_exported / rows_blocked, the warnings list,
 * and the compliance_config_version pinned at export time.
 *
 * Storage: writes to `${EXPORT_DIR}/<export_id>.{csv,json}`. EXPORT_DIR
 * defaults to /tmp/ilr-exports per the brief's MVP guidance; an
 * env-driven override lets ops swap to a mounted volume without
 * touching code.
 */

import { mkdir, writeFile } from "fs/promises";
import { resolve } from "path";
import { applyFieldNameOverrides } from "./ilrExport.service";
import type {
  IlrRow,
  BlockedRow,
  ValidationWarning,
} from "./ilrExport.service";
import ComplianceConfigService from "./ComplianceConfigService";
import logger from "../config/logger";

// ─────────────────────────────────────────────────────────────────────
// Storage location — env override for ops; /tmp default for MVP.
// ─────────────────────────────────────────────────────────────────────

export const EXPORT_DIR =
  process.env.ILR_EXPORT_DIR ?? "/tmp/ilr-exports";

const ensureDir = async () => {
  await mkdir(EXPORT_DIR, { recursive: true });
};

// ─────────────────────────────────────────────────────────────────────
// Column order — brief Section 13.1 lists the canonical order.
// Internal `_*` fields are stripped before serialisation.
// ─────────────────────────────────────────────────────────────────────

const CANONICAL_COLUMNS: ReadonlyArray<keyof IlrRow> = [
  // Learner block
  "ULN",
  "FamilyName",
  "GivenNames",
  "DateOfBirth",
  "Sex",
  "Ethnicity",
  "LLDDHealthProb",
  "LearnerEntryDate",
  "PostcodePrior",
  "NINumber",
  // Learning-aim block
  "LearnAimRef",
  "AimType",
  "AimSeqNumber",
  "LearnStartDate",
  "LearnPlanEndDate",
  "LearnActEndDate",
  "Outcome",
  "CompStatus",
  "FundModel",
  "SOF",
  "AddHours",
  "EnglishProgType",
  // LearnDelFAM is serialised as `LearnDelFAM_Type_<n>` and
  // `LearnDelFAM_Code_<n>` columns at emit time; not listed here
  // because the column count depends on the largest row's DAM list.
] as const;

// ─────────────────────────────────────────────────────────────────────
// CSV escaping — RFC 4180
// ─────────────────────────────────────────────────────────────────────

const csvField = (v: unknown): string => {
  if (v === null || v === undefined) return '""';
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
};

/**
 * Serialise an array of validated IlrRows to a CSV string. Pure —
 * no IO. The writer below calls this and writes the bytes.
 */
export const serialiseRowsToCsv = (
  rows: IlrRow[],
  fieldNameOverrides: Record<string, string> = {},
): string => {
  // Discover the widest DAM list — the column count is bounded by
  // the row with the most LearnDelFAM entries.
  const maxDamCount = rows.reduce(
    (max, r) => Math.max(max, r.LearnDelFAM?.length ?? 0),
    0,
  );

  // Build headers (canonical → renamed via field_name_overrides)
  const headers: string[] = CANONICAL_COLUMNS.map((c) =>
    applyFieldNameOverrides(String(c), fieldNameOverrides),
  );
  for (let i = 1; i <= maxDamCount; i++) {
    headers.push(
      applyFieldNameOverrides(`LearnDelFAM_Type_${i}`, fieldNameOverrides),
    );
    headers.push(
      applyFieldNameOverrides(`LearnDelFAM_Code_${i}`, fieldNameOverrides),
    );
  }

  const lines: string[] = [headers.map(csvField).join(",")];
  for (const row of rows) {
    const cells: unknown[] = CANONICAL_COLUMNS.map((c) => row[c]);
    const dam = row.LearnDelFAM ?? [];
    for (let i = 0; i < maxDamCount; i++) {
      cells.push(dam[i]?.Type ?? "");
      cells.push(dam[i]?.Code ?? "");
    }
    lines.push(cells.map(csvField).join(","));
  }

  // \r\n per RFC 4180 — Excel parses both but the spec is \r\n.
  return lines.join("\r\n");
};

// ─────────────────────────────────────────────────────────────────────
// GLH totals — brief Section 13.4 / Function 13 To-Do 4 JSON shape
// ─────────────────────────────────────────────────────────────────────

export interface GlhBreakdown {
  ai_glh: number;
  pre_platform_glh: number;
  teacher_contact_glh: number;
  total_glh: number;
}

/**
 * Aggregate GLH by source across the row set. Walks the row's
 * `_session_source` discriminator and `_total_glh_hours` field
 * produced by the row builder.
 *
 * `teacher_contact_glh` is read from `User.glh_teacher_contact`
 * accumulated into the row's `_total_glh_hours` field. To avoid
 * double-counting in the per-source breakdown we extract it
 * separately and subtract from each row's hours before bucketing.
 *
 * Brief Section 13.4: this is the GLH split the org admin sees on
 * the export's companion JSON; the inspector reads it before
 * funding claim approval.
 */
export const computeGlhBreakdown = (
  rows: IlrRow[],
  teacherContactByLearner: Map<string, number>,
): GlhBreakdown => {
  let ai = 0;
  let pre = 0;
  // Sum teacher-contact hours ONCE per learner — the row carries it
  // per row, but it's a cumulative value on the User.
  const accounted = new Set<string>();
  let teacher = 0;

  for (const row of rows) {
    // Subtract the teacher-contact portion from the row's total to
    // get the pure session-hours number.
    const learnerTeacher = teacherContactByLearner.get(row._learner_id) ?? 0;
    const sessionHours = Math.max(row._total_glh_hours - learnerTeacher, 0);

    if (row._session_source === "pre_platform") pre += sessionHours;
    else ai += sessionHours;

    if (!accounted.has(row._learner_id)) {
      accounted.add(row._learner_id);
      teacher += learnerTeacher;
    }
  }

  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    ai_glh: round(ai),
    pre_platform_glh: round(pre),
    teacher_contact_glh: round(teacher),
    total_glh: round(ai + pre + teacher),
  };
};

// ─────────────────────────────────────────────────────────────────────
// Companion JSON
// ─────────────────────────────────────────────────────────────────────

export interface IlrExportCompanion {
  export_id: string;
  generated_at: string;
  compliance_config_version: number | null;
  totals: GlhBreakdown;
  learner_count: number;
  rows_exported: number;
  rows_blocked: number;
  warnings: ValidationWarning[];
}

export const buildCompanionJson = (args: {
  exportId: string;
  generatedAt: Date;
  configVersion: number | null;
  validRows: IlrRow[];
  blockedRows: BlockedRow[];
  warnings: ValidationWarning[];
  teacherContactByLearner: Map<string, number>;
}): IlrExportCompanion => {
  const learnerIds = new Set([
    ...args.validRows.map((r) => r._learner_id),
    ...args.blockedRows.map((b) => b.row._learner_id),
  ]);
  return {
    export_id: args.exportId,
    generated_at: args.generatedAt.toISOString(),
    compliance_config_version: args.configVersion,
    totals: computeGlhBreakdown(args.validRows, args.teacherContactByLearner),
    learner_count: learnerIds.size,
    rows_exported: args.validRows.length,
    rows_blocked: args.blockedRows.length,
    warnings: args.warnings,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────

const pathFor = (exportId: string, kind: "csv" | "json"): string =>
  resolve(EXPORT_DIR, `${exportId}.${kind}`);

export interface PersistedExport {
  csv_path: string;
  json_path: string;
}

/**
 * Write the CSV + companion JSON to disk. Idempotent: overwrites
 * an existing file with the same export_id (the idempotency wrap
 * on the export route prevents normal re-runs, but a force-refresh
 * lands here too).
 */
export const persistExportArtifacts = async (args: {
  exportId: string;
  validRows: IlrRow[];
  fieldNameOverrides: Record<string, string>;
  companion: IlrExportCompanion;
}): Promise<PersistedExport> => {
  await ensureDir();

  const csv = serialiseRowsToCsv(args.validRows, args.fieldNameOverrides);
  const csvPath = pathFor(args.exportId, "csv");
  const jsonPath = pathFor(args.exportId, "json");

  await writeFile(csvPath, csv, "utf8");
  await writeFile(jsonPath, JSON.stringify(args.companion, null, 2), "utf8");

  logger.info(
    {
      exportId: args.exportId,
      rows: args.validRows.length,
      csvPath,
      jsonPath,
    },
    "persistExportArtifacts: wrote CSV + JSON to disk",
  );

  return { csv_path: csvPath, json_path: jsonPath };
};

/**
 * Pull the field_name_overrides map from the active compliance
 * config. Defensive: returns an empty map if the config is missing
 * so the writer can fall back to canonical names.
 */
export const fieldNameOverridesForYear = (
  academicYear: string,
): Record<string, string> => {
  const config = ComplianceConfigService.getConfig("ilr", academicYear);
  if (!config) return {};
  return (
    ((config.rules as Record<string, unknown>).field_name_overrides ?? {}) as Record<string, string>
  );
};

export const __internals__ = {
  pathFor,
  CANONICAL_COLUMNS,
};
