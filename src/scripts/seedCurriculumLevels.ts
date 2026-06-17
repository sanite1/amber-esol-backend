/**
 * Seed the CurriculumLevel collection from
 * src/data/curriculum/esol_curriculum.json (AI Tutor Build Brief §1.1).
 *
 * Idempotent per (level, version): re-running with the same curriculum
 * version skips existing docs; bump the source file's meta.date to cut
 * a new version. Read-only at runtime — never edit a level in place
 * once learner evidence references it.
 *
 * Run:
 *   npx ts-node src/scripts/seedCurriculumLevels.ts
 */

import "dotenv/config";
import path from "path";
import { readFileSync } from "fs";
import { connectDb } from "../config/db";
import CurriculumLevel, {
  BridgeMode,
  NqfLevel,
} from "../models/CurriculumLevel";
import logger from "../config/logger";

// Mode per level — stable from the ESOL Framework §3 Bridge-Method
// table; the curriculum JSON doesn't carry it as a field.
const MODE_BY_LEVEL: Record<NqfLevel, BridgeMode> = {
  E1: "ANCHOR",
  E2: "ANCHOR_BRIDGE",
  E3: "BRIDGE",
  L1: "BRIDGE_IMMERSION",
  L2: "IMMERSION",
};

// Developmentally-late forms (Framework §2 acquisition-order caveat):
// taught early, acquired late — recycled as long-horizon, never failed.
const LONG_HORIZON_FORMS = [
  "third person singular -s",
  "articles (a/the)",
  "question inversion",
];
const LONG_HORIZON_MATCH = [
  /third person/i,
  /\barticle/i,
  /inversion/i,
  /\ba\/the\b/i,
];

/** "500-750 cumulative…" / "3-5 new items" → { min, max }. */
const parseRange = (raw: string, fallback = { min: 0, max: 0 }) => {
  const m = String(raw).match(/(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)/);
  if (!m) {
    const single = String(raw).match(/(\d[\d,]*)/);
    if (single) {
      const n = Number(single[1].replace(/,/g, ""));
      return { min: n, max: n };
    }
    return fallback;
  }
  return {
    min: Number(m[1].replace(/,/g, "")),
    max: Number(m[2].replace(/,/g, "")),
  };
};

/**
 * "70:30 to 60:40 (L1:English)" → L1 fraction band { min: 0.6, max: 0.7 }.
 * Takes the L1 (first) number of each ratio; min/max across both ratios.
 */
const parseL1Ratio = (raw: string) => {
  const ratios = [...String(raw).matchAll(/(\d+)\s*:\s*(\d+)/g)].map((m) => {
    const l1 = Number(m[1]);
    const en = Number(m[2]);
    const total = l1 + en || 100;
    return l1 / total;
  });
  if (ratios.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...ratios), max: Math.max(...ratios) };
};

const main = async () => {
  await connectDb();

  const file = path.join(__dirname, "../data/curriculum/esol_curriculum.json");
  const doc = JSON.parse(readFileSync(file, "utf-8")) as {
    meta: { date: string; project: string };
    levels: Record<string, any>;
  };
  const version = `${doc.meta.date}`; // curriculum version stamp

  let inserted = 0;
  let skipped = 0;

  for (const level of Object.keys(doc.levels) as NqfLevel[]) {
    const L = doc.levels[level];

    const existing = await CurriculumLevel.findOne({ level, version }).lean();
    if (existing) {
      skipped++;
      continue;
    }

    const grammarTargets = (L.grammar_targets ?? []).map((form: string) => ({
      form,
      longHorizon: LONG_HORIZON_MATCH.some((re) => re.test(form)),
    }));

    await CurriculumLevel.create({
      level,
      cefr: L.cefr_equivalent ?? "",
      canDo: {
        listening: L.can_do?.listening ?? "",
        reading: L.can_do?.reading ?? "",
        spokenInteraction: L.can_do?.spoken_interaction ?? "",
        spokenProduction: L.can_do?.spoken_production ?? "",
        writing: L.can_do?.writing ?? "",
      },
      grammarTargets,
      longHorizonForms: LONG_HORIZON_FORMS,
      vocabTargetSize: parseRange(L.vocabulary_target_size, {
        min: 0,
        max: 0,
      }),
      vocabPerSession: parseRange(L.vocab_per_session, { min: 3, max: 5 }),
      bridgeL1Ratio: parseL1Ratio(L.bridge_l1_ratio ?? ""),
      mode: MODE_BY_LEVEL[level],
      anchorTriggers: L.anchor_triggers ?? [],
      immersionTriggers: L.immersion_triggers ?? [],
      retentionEncounters: parseRange(L.retention_encounters, {
        min: 8,
        max: 14,
      }),
      reinforcementInterval: L.reinforcement_interval ?? "",
      rarpaObjectives: {
        speakingListening: L.rarpa_objectives_bank?.speaking_listening ?? [],
        reading: L.rarpa_objectives_bank?.reading ?? [],
        writing: L.rarpa_objectives_bank?.writing ?? [],
      },
      source: "esol_curriculum.json",
      version,
    });
    inserted++;
  }

  logger.info(
    { inserted, skipped, version, total: Object.keys(doc.levels).length },
    "CurriculumLevel seed complete",
  );
  process.exit(0);
};

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "CurriculumLevel seed failed");
  process.exit(1);
});
