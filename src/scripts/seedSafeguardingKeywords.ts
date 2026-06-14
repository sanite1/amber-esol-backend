/**
 * Seed the SafeguardingKeyword collection from src/data/safeguarding-keywords.json.
 *
 * Idempotent: skips documents whose (language, pattern, category) tuple
 * already exists. Re-run after edits to safeguarding-keywords.json to
 * incrementally add new patterns without duplicating existing ones.
 *
 * Run:
 *   npx ts-node src/scripts/seedSafeguardingKeywords.ts
 */

import "dotenv/config";
import path from "path";
import { readFileSync } from "fs";
import { connectDb } from "../config/db";
import SafeguardingKeyword, {
  SafeguardingCategory,
  SafeguardingSeverity,
} from "../models/SafeguardingKeyword";
import logger from "../config/logger";

interface SeedEntry {
  language: string;
  pattern: string;
  category: SafeguardingCategory;
  severity: SafeguardingSeverity;
  notes?: string;
}

const main = async () => {
  await connectDb();

  const seedPath = path.join(__dirname, "../data/safeguarding-keywords.json");
  const seeds = JSON.parse(readFileSync(seedPath, "utf-8")) as SeedEntry[];

  let inserted = 0;
  let skipped = 0;

  for (const entry of seeds) {
    const existing = await SafeguardingKeyword.findOne({
      language: entry.language,
      pattern: entry.pattern,
      category: entry.category,
    }).lean();

    if (existing) {
      skipped++;
      continue;
    }

    await SafeguardingKeyword.create({
      ...entry,
      active: true,
    });
    inserted++;
  }

  logger.info(
    { inserted, skipped, total: seeds.length },
    "SafeguardingKeyword seed complete",
  );
  process.exit(0);
};

main().catch((err) => {
  logger.fatal(
    { err: (err as Error).message },
    "SafeguardingKeyword seed failed",
  );
  process.exit(1);
});
