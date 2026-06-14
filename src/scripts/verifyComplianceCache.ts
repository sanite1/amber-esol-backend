/**
 * One-off verification that the compliance config cache works end-to-end.
 *
 * Usage:
 *   npx ts-node src/scripts/verifyComplianceCache.ts
 *
 * Prints each domain's cache hit + a key field from its rules so you can
 * confirm both the seed and the loader are working as expected.
 */

import "dotenv/config";
import { connectDb } from "../config/db";
import ComplianceConfigService from "../services/ComplianceConfigService";

const main = async () => {
  await connectDb();
  await ComplianceConfigService.loadAll();

  const currentYear = ComplianceConfigService.currentAcademicYear();
  console.log("Current academic year:", currentYear);
  console.log("");

  const ilr = ComplianceConfigService.getConfig("ilr", currentYear);
  console.log("ILR config found:", !!ilr);
  if (ilr) {
    const rules = ilr.rules as Record<string, unknown>;
    console.log("  fund_model:        ", rules.fund_model);
    console.log("  aim_type_default:  ", rules.aim_type_default);
    console.log(
      "  valid_sof_codes:   ",
      (rules.valid_sof_codes as string[])?.length,
      "codes",
    );
    console.log("  llddt_remapping:   ", rules.llddt_remapping);
  }
  console.log("");

  const rarpa = ComplianceConfigService.getConfig("rarpa", currentYear);
  console.log("RARPA config found:", !!rarpa);
  if (rarpa) {
    const rules = rarpa.rules as Record<string, unknown>;
    console.log("  stage_5_required: ", rules.stage_5_required);
    console.log("  stage_2_method:   ", rules.stage_2_method);
  }
  console.log("");

  const asf = ComplianceConfigService.getConfig("asf-routing", currentYear);
  console.log("ASF routing config found:", !!asf);
  if (asf) {
    const rules = asf.rules as {
      sof_authority_map: Record<
        string,
        { name: string; needs_verification: boolean }
      >;
      default_sof: string;
    };
    const map = rules.sof_authority_map;
    const verified = Object.values(map).filter(
      (v) => !v.needs_verification,
    ).length;
    const unverified = Object.values(map).filter(
      (v) => v.needs_verification,
    ).length;
    console.log("  default_sof:      ", rules.default_sof);
    console.log("  total entries:    ", Object.keys(map).length);
    console.log("  verified:         ", verified);
    console.log("  needs verification:", unverified);
    console.log("  sample (105):     ", map["105"]?.name);
    console.log("  sample (121):     ", map["121"]?.name);
  }

  process.exit(0);
};

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
