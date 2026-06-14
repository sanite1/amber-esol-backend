/**
 * Migrate existing User documents to include every Phase 1.6 + addendum
 * §4.1 field defined in src/models/User.ts.
 *
 * IDEMPOTENT: each field is only initialised on documents where the field
 * is not yet present (`$exists: false`). Safe to re-run after a partial
 * failure or after adding more fields later — already-migrated documents
 * are untouched.
 *
 * What this migration does NOT touch:
 *   - Any existing field with a value (we never overwrite)
 *   - Sub-document defaults (Mongoose handles those on save())
 *   - Indexes (those are created lazily by Mongo at first query)
 *
 * Why a script and not a runtime hook: a startup hook would run on every
 * boot, multiply the load against Mongo, and silently mask the migration
 * being incomplete. A one-shot script with logging is auditable.
 *
 * Run:
 *   npx ts-node src/scripts/migrateUserSchema.ts
 */

import "dotenv/config";
import { connectDb } from "../config/db";
import User from "../models/User";
import logger from "../config/logger";

// Field → default value to set when missing on existing docs.
// Order doesn't matter; each updateMany is independent.
const NEW_FIELDS: Record<string, unknown> = {
  // Phase 1.6 ESOL learner fields (snake_case)
  postcode_prior: null,
  sof_code: null,
  esol_aim_type: null,
  esol_eligibility_declared_at: null,
  stage3_objectives: [],
  cohort_status: "new",
  progression_notification_sent_at: null,

  // Addendum §4.1 teacher-multiplier fields
  assigned_teacher_id: null,
  teacher_last_reviewed_at: null,
  pathway_override: null,
  glh_teacher_contact: 0,
  teacher_priority_level: "p4",
  teacher_recommended_action: null,
  teacher_priority_updated_at: null,
};

const main = async () => {
  await connectDb();

  const totalUsers = await User.estimatedDocumentCount();
  logger.info({ totalUsers }, "Starting User schema migration");

  let totalUpdates = 0;
  const summary: Array<{ field: string; modified: number }> = [];

  for (const [field, defaultValue] of Object.entries(NEW_FIELDS)) {
    const result = await User.collection.updateMany(
      { [field]: { $exists: false } },
      { $set: { [field]: defaultValue } },
    );
    summary.push({ field, modified: result.modifiedCount });
    totalUpdates += result.modifiedCount;
    logger.info(
      { field, modified: result.modifiedCount, defaultValue },
      result.modifiedCount > 0
        ? "Initialised new field on existing docs"
        : "Field already present on all docs (no-op)",
    );
  }

  // One value-change migration (not a new field): existing schema had
  // `esolTeacherApproved` default of null, brief mandates default false.
  // Convert any lingering `null` values to explicit `false` so the type
  // narrows cleanly going forward. Documents where the field is already
  // true are untouched.
  const teacherApprovedResult = await User.collection.updateMany(
    { esolTeacherApproved: null },
    { $set: { esolTeacherApproved: false } },
  );
  summary.push({
    field: "esolTeacherApproved (null → false)",
    modified: teacherApprovedResult.modifiedCount,
  });
  totalUpdates += teacherApprovedResult.modifiedCount;
  logger.info(
    { modified: teacherApprovedResult.modifiedCount },
    "Normalised esolTeacherApproved null → false",
  );

  // Also handle docs where esolTeacherApproved is missing entirely (older
  // pre-ESOL records). Set to false to match the new default.
  const teacherApprovedMissing = await User.collection.updateMany(
    { esolTeacherApproved: { $exists: false } },
    { $set: { esolTeacherApproved: false } },
  );
  summary.push({
    field: "esolTeacherApproved (missing → false)",
    modified: teacherApprovedMissing.modifiedCount,
  });
  totalUpdates += teacherApprovedMissing.modifiedCount;

  logger.info({ totalUpdates, totalUsers }, "User schema migration complete");
  console.log("\n── Migration summary ──");
  for (const row of summary) {
    console.log(`  ${row.field.padEnd(48)} → ${row.modified} doc(s) updated`);
  }
  console.log(`\nTotal updates: ${totalUpdates} (across ${totalUsers} users)`);

  process.exit(0);
};

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "User schema migration failed");
  process.exit(1);
});
