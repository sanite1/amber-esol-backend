import { readFileSync } from "fs";
import { resolve } from "path";

import logger from "../config/logger";
import { EvidenceBeat } from "../models/EvidenceRecord";

/**
 * Evidence-mapping reader — AI Tutor Build Brief F29.
 *
 * Loads `src/data/curriculum/evidence_mapping.json` once and exposes a
 * synchronous lookup: given a beat + data point, return the ILR fields,
 * RARPA stage and human-confirmation requirement the curriculum task
 * declared for it. The evidence-chain writer reads this so the
 * data_point → ilr_field → rarpa_stage mapping is single-sourced from
 * the JSON, never duplicated in code (the same discipline as Layers 2/3
 * being built from system_prompt_spec.json).
 */

const MAPPING_PATH = resolve(
  __dirname,
  "../data/curriculum/evidence_mapping.json",
);

export interface EvidenceMappingEntry {
  data_point: string;
  ilr_fields: string[];
  rarpa_stage: string;
  human_confirm: boolean;
  note?: string;
}

interface EvidenceMappingFile {
  meta?: { date?: string };
  [section: string]: unknown;
}

interface LoadedMapping {
  version: string | null;
  /** beat → (data_point → entry) */
  byBeat: Map<EvidenceBeat, Map<string, EvidenceMappingEntry>>;
}

let _cache: LoadedMapping | null = null;

const BEAT_KEYS: EvidenceBeat[] = [
  "pre_session",
  "beat_1_prepare",
  "beat_2_roleplay",
  "beat_3_complete",
  "review_point",
];

const load = (): LoadedMapping => {
  if (_cache) return _cache;

  let parsed: EvidenceMappingFile;
  try {
    parsed = JSON.parse(
      readFileSync(MAPPING_PATH, "utf8"),
    ) as EvidenceMappingFile;
  } catch (err) {
    logger.error(
      { err, path: MAPPING_PATH },
      "evidence_mapping.json missing/unparseable — evidence chain will use empty mapping (records still written, fields blank)",
    );
    _cache = { version: null, byBeat: new Map() };
    return _cache;
  }

  const byBeat = new Map<EvidenceBeat, Map<string, EvidenceMappingEntry>>();
  for (const beat of BEAT_KEYS) {
    const section = parsed[beat];
    const entries = new Map<string, EvidenceMappingEntry>();
    if (Array.isArray(section)) {
      for (const raw of section as Array<Record<string, unknown>>) {
        const dp = typeof raw.data_point === "string" ? raw.data_point : null;
        if (!dp) continue;
        entries.set(dp, {
          data_point: dp,
          ilr_fields: Array.isArray(raw.ilr_fields)
            ? (raw.ilr_fields as string[])
            : [],
          rarpa_stage:
            typeof raw.rarpa_stage === "string" ? raw.rarpa_stage : "",
          human_confirm: raw.human_confirm === true,
          note: typeof raw.note === "string" ? raw.note : undefined,
        });
      }
    }
    byBeat.set(beat, entries);
  }

  _cache = {
    version: parsed.meta?.date ?? null,
    byBeat,
  };
  logger.info(
    { version: _cache.version, beats: byBeat.size },
    "Evidence mapping loaded",
  );
  return _cache;
};

/** Lookup the mapping entry for a (beat, data_point). Null if unmapped. */
export const getEvidenceMapping = (
  beat: EvidenceBeat,
  dataPoint: string,
): EvidenceMappingEntry | null => {
  const { byBeat } = load();
  return byBeat.get(beat)?.get(dataPoint) ?? null;
};

/** The loaded mapping version (evidence_mapping.json meta.date). */
export const getEvidenceMappingVersion = (): string | null => load().version;

/** Test hook — drop the cache so a test can mutate the file on disk. */
export const __resetEvidenceMappingCache = (): void => {
  _cache = null;
};
