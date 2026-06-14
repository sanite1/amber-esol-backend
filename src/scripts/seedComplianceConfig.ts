/**
 * Seed the 2025/26 ComplianceConfig documents.
 *
 * Idempotent: if an active config already exists for a given (domain, year)
 * it is left alone. Re-run safely after a fresh DB or after schema changes.
 *
 * Run:
 *   npx ts-node src/scripts/seedComplianceConfig.ts
 *
 * The seeded ILR rules are sourced from Phase 14 of the original brief.
 * The seeded RARPA rules are placeholders — Joey populates the real stage
 * criteria text. The seeded ASF routing map contains the SOF codes I can
 * verify from public DfE/ESFA documentation; codes marked
 * `needs_verification: true` must be confirmed against the official DfE
 * 2025/26 postcode master file before this seed is treated as authoritative.
 */

import "dotenv/config";
import { connectDb } from "../config/db";
import ComplianceConfig from "../models/ComplianceConfig";
import logger from "../config/logger";

const ACADEMIC_YEAR = "2025/26";

// ── ILR rules (Phase 14, 2025/26 spec) ──────────────────────────────────
const ilrRules = {
  field_name_overrides: { SOC2000: "SOC" },
  valid_sof_codes: [
    "105",
    "106",
    "107",
    "108",
    "109",
    "110",
    "111",
    "112",
    "113",
    "114",
    "115",
    "116",
    "117",
    "118",
    "119",
    "120",
    "121",
    "122",
    "123",
  ],
  expired_llddt_codes: ["15"],
  llddt_remapping: { "15": "14" },
  add_hours_suppression_rule: "non_regulated",
  valid_dam_codes: ["085", "086", "087"],
  fund_model: 38,
  aim_type_default: 4,
};

// ── RARPA stage criteria (placeholder — Joey populates) ─────────────────
const rarpaRules = {
  stage_2_method: "ai_adaptive_test_or_forskills_import",
  stage_3_min_objectives: 2,
  stage_4_min_evidence_items_per_objective: 3,
  stage_5_required: true,
};

// ── ASF routing — SOF code → MCA authority name ─────────────────────────
// Codes flagged needs_verification have NOT been independently confirmed
// against the DfE 2025/26 postcode master file (see brief §1 Task 11).
// Do NOT trust these for funding routing in production until verified.
const asfRoutingRules = {
  sof_authority_map: {
    "105": {
      name: "ESFA / DfE Direct (non-devolved national pool)",
      needs_verification: false,
    },
    "106": { name: "(Reserved / TBD)", needs_verification: true },
    "107": { name: "(Reserved / TBD)", needs_verification: true },
    "108": {
      name: "Cambridgeshire & Peterborough CA (CPCA)",
      needs_verification: true,
    },
    "109": {
      name: "West of England Combined Authority (WECA)",
      needs_verification: true,
    },
    "110": {
      name: "Greater Manchester Combined Authority (GMCA)",
      needs_verification: false,
    },
    "111": {
      name: "Liverpool City Region CA (LCRCA)",
      needs_verification: false,
    },
    "112": {
      name: "West Midlands Combined Authority (WMCA)",
      needs_verification: false,
    },
    "113": {
      name: "Tees Valley Combined Authority (TVCA)",
      needs_verification: false,
    },
    "114": { name: "South Yorkshire MCA (SYMCA)", needs_verification: false },
    "115": {
      name: "West Yorkshire Combined Authority (WYCA)",
      needs_verification: false,
    },
    "116": {
      name: "Greater London Authority (GLA)",
      needs_verification: false,
    },
    "117": { name: "(Reserved / TBD)", needs_verification: true },
    "118": {
      name: "North East Combined Authority (NECA)",
      needs_verification: true,
    },
    "119": { name: "(Reserved / TBD)", needs_verification: true },
    "120": { name: "(Reserved / TBD)", needs_verification: true },
    "121": {
      name: "East Midlands Combined County Authority (EMCCA)",
      needs_verification: false,
    },
    "122": {
      name: "York and North Yorkshire Combined Authority (YNYCA)",
      needs_verification: false,
    },
    "123": { name: "Cornwall Council", needs_verification: false },
  },
  default_sof: "105",
  // Authorities that apply higher earnings thresholds than the DfE default.
  // GLA uses London Living Wage; everywhere else uses the national figure.
  higher_earnings_threshold_authorities: ["116"],
};

const seeds: Array<{
  domain: "ilr" | "rarpa" | "asf-routing";
  rules: unknown;
  changelog: string;
}> = [
  {
    domain: "ilr",
    rules: ilrRules,
    changelog:
      "Initial 2025/26 seed. SOC2000→SOC rename; new SOF codes 121/122/123; LLDD 15→14 remap; AddHours suppressed for non-regulated aims; FM38; aim_type default 4.",
  },
  {
    domain: "rarpa",
    rules: rarpaRules,
    changelog:
      "Initial 2025/26 seed (placeholder). Stage 2–5 thresholds. Content to be populated by Joey with ESOL practitioner.",
  },
  {
    domain: "asf-routing",
    rules: asfRoutingRules,
    changelog:
      "Initial 2025/26 seed. SOF→authority map covering 19 codes. Several entries marked needs_verification: true — confirm against DfE postcode master file before production use.",
  },
];

const main = async () => {
  await connectDb();

  for (const seed of seeds) {
    const existing = await ComplianceConfig.findOne({
      domain: seed.domain,
      academic_year: ACADEMIC_YEAR,
      active: true,
    }).lean();

    if (existing) {
      logger.info(
        {
          domain: seed.domain,
          academic_year: ACADEMIC_YEAR,
          version: existing.version,
        },
        "Skip: active config already exists",
      );
      continue;
    }

    await ComplianceConfig.create({
      domain: seed.domain,
      academic_year: ACADEMIC_YEAR,
      version: 1,
      active: true,
      rules: seed.rules,
      updated_by: null,
      updated_at: new Date(),
      changelog: seed.changelog,
    });

    logger.info(
      { domain: seed.domain, academic_year: ACADEMIC_YEAR },
      "Seeded compliance config",
    );
  }

  logger.info("ComplianceConfig seed complete");
  process.exit(0);
};

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "ComplianceConfig seed failed");
  process.exit(1);
});
