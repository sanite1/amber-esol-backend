import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * Configuration-driven compliance rules.
 *
 * Every ILR / RARPA / ASF-routing constant lives here, not in code. Annual
 * regulatory updates (new SOF codes, expired LLDD codes, changed
 * field-name conventions, etc.) become a single config write — no code
 * release required.
 *
 * Lifecycle:
 *   - One document per (domain, academic_year, version)
 *   - At most one active: true per (domain, academic_year)
 *   - update() creates a new version and deactivates the prior one
 *   - Old versions stay on disk as an audit trail
 *
 * Reads happen at startup (loadAll) and on-demand (getConfig). Both go
 * through ComplianceConfigService — never query this model directly from
 * a service that processes requests.
 */

export type ComplianceDomain =
  | "ilr"
  | "rarpa"
  | "asf-routing"
  // Bridge-Method mode-controller thresholds (F26). Optional — the
  // mode controller falls back to DEFAULT_MODE_THRESHOLDS when no
  // active "bridge-mode" config exists, so the platform runs correctly
  // before any admin seeds an override.
  | "bridge-mode";

export interface IComplianceConfig extends Document {
  domain: ComplianceDomain;
  academic_year: string; // e.g. "2025/26"
  version: number; // 1, 2, 3 ...
  active: boolean; // exactly one true per (domain, academic_year)
  rules: unknown; // domain-specific structure; cast by caller
  updated_by: Types.ObjectId | null;
  updated_at: Date;
  changelog: string;
}

const complianceConfigSchema = new Schema<IComplianceConfig>(
  {
    domain: {
      type: String,
      enum: ["ilr", "rarpa", "asf-routing", "bridge-mode"],
      required: true,
    },
    academic_year: { type: String, required: true, index: true },
    version: { type: Number, required: true, default: 1 },
    active: { type: Boolean, required: true, default: true },
    rules: { type: Schema.Types.Mixed, required: true },
    updated_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    updated_at: { type: Date, default: Date.now },
    changelog: { type: String, default: "" },
  },
  { collection: "compliance_configs", versionKey: false },
);

// Compound index per the brief — supports the cache-warm-up query
// `find({ active: true })` and the hot lookup by domain+year.
complianceConfigSchema.index({ domain: 1, academic_year: 1, active: 1 });

// Defence-in-depth: enforce "at most one active per (domain, academic_year)"
// at the database level. The pre-save hook catches it at the app layer; this
// catches the race where two save() calls land between read and write.
complianceConfigSchema.index(
  { domain: 1, academic_year: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: "unique_active_per_domain_year",
  },
);

// Validation hook: refuse to save a second active config for the same
// (domain, academic_year). Service code is expected to flip the prior
// version's `active` to false BEFORE creating the new one.
complianceConfigSchema.pre("save", async function (next) {
  if (!this.active) return next();
  const existing = await ComplianceConfig.findOne({
    domain: this.domain,
    academic_year: this.academic_year,
    active: true,
    _id: { $ne: this._id },
  }).lean();
  if (existing) {
    return next(
      new Error(
        `ComplianceConfig: another active config already exists for ${this.domain}/${this.academic_year}. ` +
          `Deactivate it before creating a new active version.`,
      ),
    );
  }
  next();
});

const ComplianceConfig = mongoose.model<IComplianceConfig>(
  "ComplianceConfig",
  complianceConfigSchema,
);

export default ComplianceConfig;
