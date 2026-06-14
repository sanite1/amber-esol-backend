/**
 * QA seed — Phase 1-5 manual test accounts.
 *
 * Creates one user per role under a single dedicated org, with the
 * exact state needed to land each user on their initial first-login
 * step for the new phases:
 *
 *   - Org admin lands on /roi-calculator?onboarding=true
 *     (Organisation.org_onboarding_completed_at = null)
 *   - Learner lands on /esol/home with the unread-messages modal
 *     blocking the dashboard on first paint (one fresh TeacherMessage,
 *     no sessionStorage dismissal)
 *   - Teacher lands on /teacher/dashboard with the assigned learner
 *     visible in their priority queue
 *   - Amber admin lands on /admin/overview with access to every org
 *
 * Idempotent: re-running drops + recreates the seeded users (matched
 * by their distinctive seed-* email prefix). The seed Org is kept
 * across runs — we never delete it because re-creating loses the
 * stable id paths the test docs reference. Re-running RESETS the
 * onboarding flag, the assigned-teacher pointer, the unread message,
 * and the password.
 *
 * Refusal: this script REQUIRES MONGODB_URI in the environment. It
 * will NOT run in DEMO_MODE — separate demo seed scripts exist for
 * that path (`seedDemoEnvironment.ts`).
 *
 * Invocation:
 *   npx ts-node --transpile-only src/scripts/seedQaUsers.ts
 *   # or
 *   npm run seed:qa     (after package.json wires it)
 */

import * as dotenv from "dotenv";
dotenv.config();

import bcrypt from "bcrypt";
import mongoose, { Types } from "mongoose";
import User from "../models/User";
import Organisation from "../models/Organisation";
import TeacherMessage from "../models/TeacherMessage";
import AuditLog from "../models/AuditLog";

const SALT_ROUNDS = 10;
const SEED_PASSWORD = "TestPass1!";
const SEED_TAG = "seed-qa";

// All four accounts share one stable suffix so a fresh run keeps
// hitting the same docs. Email domain is example.com — the RFC 2606
// reserved-for-documentation domain — so:
//   1. Joi's email validator accepts it (an earlier seed used
//      @test.local which fails Joi's TLD check).
//   2. A misconfigured outbound mailer can never deliver to a real
//      inbox; example.com discards all traffic by design.
const EMAIL = {
  amberAdmin: `${SEED_TAG}-admin@example.com`,
  orgAdmin: `${SEED_TAG}-orgadmin@example.com`,
  teacher: `${SEED_TAG}-teacher@example.com`,
  learner: `${SEED_TAG}-learner@example.com`,
} as const;

const ORG_SLUG = `${SEED_TAG}-organisation`;

// ─────────────────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────────────────

const PROD_URI = process.env.MONGODB_URI || "";
if (!PROD_URI) {
  // Loud refusal — we will NOT silently fall back to anything.
  console.error("[seedQaUsers] MONGODB_URI missing from environment.");
  process.exit(1);
}
if (process.env.DEMO_MODE === "true") {
  console.error(
    "[seedQaUsers] DEMO_MODE=true. Use seedDemoEnvironment instead — refusing to pollute the demo cluster from this script.",
  );
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const upsertOrg = async (): Promise<{
  orgId: Types.ObjectId;
  fresh: boolean;
}> => {
  const existing = await Organisation.findOne({ slug: ORG_SLUG });
  if (existing) {
    // Reset the onboarding flag so we land on the first-login intercept
    // again. Same path the QA tester would hit on a brand-new org.
    await Organisation.updateOne(
      { _id: existing._id },
      {
        $set: {
          org_onboarding_completed_at: null,
          isActive: true,
          billing_active: true,
        },
      },
    );
    return { orgId: existing._id as Types.ObjectId, fresh: false };
  }
  const created = await Organisation.create({
    name: "Seed QA Organisation",
    slug: ORG_SLUG,
    contactEmail: "ops@test.local",
    contactName: "Seed QA Operator",
    paymentModel: "invoiced",
    invoiceCycle: "monthly",
    isActive: true,
    billing_active: true,
    type: "college",
    // The onboarding intercept reads this; null = first-login flow.
    org_onboarding_completed_at: null,
    is_demo: false,
  });
  return { orgId: created._id as Types.ObjectId, fresh: true };
};

const upsertUser = async (input: {
  email: string;
  firstname: string;
  lastname: string;
  role: "admin" | "org_admin" | "tutor" | "student";
  orgId: Types.ObjectId | null;
  extra?: Record<string, unknown>;
}): Promise<Types.ObjectId> => {
  const hashed = await bcrypt.hash(SEED_PASSWORD, SALT_ROUNDS);
  const baseDoc = {
    firstname: input.firstname,
    lastname: input.lastname,
    email: input.email,
    password: hashed,
    phoneNumber: "07000000000",
    role: input.role,
    isActive: true,
    status: "active",
    verified: true,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.extra ?? {}),
  };

  const existing = await User.findOne({ email: input.email });
  if (existing) {
    await User.updateOne(
      { _id: existing._id },
      // Use $set with the full base doc — re-applies every field so a
      // tester who mid-flight clicked "Read later" on the unread modal
      // (which doesn't touch the User doc, but other test paths do)
      // returns to the canonical state on re-seed.
      { $set: baseDoc },
    );
    return existing._id as Types.ObjectId;
  }
  const created = await User.create(baseDoc);
  return created._id as Types.ObjectId;
};

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

const main = async () => {
  console.log(
    "[seedQaUsers] connecting to",
    PROD_URI.replace(/:\/\/.*@/, "://***@"),
  );
  await mongoose.connect(PROD_URI, { serverSelectionTimeoutMS: 8000 });
  console.log("[seedQaUsers] connected");

  // 0. Hygiene — drop any seed users that were created under an
  //    earlier email domain. The first revision of this script used
  //    `@test.local` which Joi's email validator rejects on /login,
  //    so those rows can never authenticate and are dead weight in
  //    the user table. Matched by the `seed-qa-` prefix + the legacy
  //    domain so a real user with @test.local (unlikely but
  //    possible) is never touched. Idempotent — no-op when nothing
  //    matches.
  const legacy = await User.deleteMany({
    email: { $regex: `^${SEED_TAG}-.*@test\\.local$`, $options: "i" },
  });
  if (legacy.deletedCount > 0) {
    console.log(
      `[seedQaUsers] hygiene: removed ${legacy.deletedCount} legacy @test.local seed user(s)`,
    );
  }

  // 1. Org
  const { orgId, fresh: orgFresh } = await upsertOrg();
  console.log(
    `[seedQaUsers] org ${orgFresh ? "CREATED" : "RESET"} :: id=${orgId.toString()}`,
  );

  // 2. Amber super-admin — no orgId; full platform access.
  const amberAdminId = await upsertUser({
    email: EMAIL.amberAdmin,
    firstname: "Amber",
    lastname: "Admin",
    role: "admin",
    orgId: null,
  });

  // 3. Org admin — onboarding flag is on the Org, not the User.
  //    Logging in will trigger the redirect to /roi-calculator?onboarding=true.
  const orgAdminId = await upsertUser({
    email: EMAIL.orgAdmin,
    firstname: "Orla",
    lastname: "Admin",
    role: "org_admin",
    orgId,
  });
  // The Organisation needs an adminUserId pointer; idempotent set.
  await Organisation.updateOne(
    { _id: orgId },
    { $set: { adminUserId: orgAdminId } },
  );

  // 4. Teacher — needs both approval gates green to reach /teacher/*.
  const teacherId = await upsertUser({
    email: EMAIL.teacher,
    firstname: "Theo",
    lastname: "Teacher",
    role: "tutor",
    orgId,
    extra: {
      esolTeacherApproved: true,
      dbsCheckStatus: "cleared",
      auto_re_engagement_enabled: true,
    },
  });
  // Make sure the teacher is on the org's assigned-teacher roster.
  await Organisation.updateOne(
    { _id: orgId },
    { $addToSet: { assigned_teacher_ids: teacherId } },
  );

  // 5. Learner — ESOL-active so the Compliance Timeline section
  //    renders on /profile (gated on esolLevel) and the Phase 3
  //    blocking modal can be exercised.
  const learnerId = await upsertUser({
    email: EMAIL.learner,
    firstname: "Lara",
    lastname: "Learner",
    role: "student",
    orgId,
    extra: {
      esolLevel: "e3",
      assigned_teacher_id: teacherId,
      cohort_status: "active",
      // ULN populated so the MIS sync-now button on Phase 4 has a
      // candidate to push (worker will skip without an adapter
      // configured — that's expected and surfaces in the activity log).
      uln: "8001234567",
      eligibility_status: "eligible",
      employment_status: "unemployed",
      nativeLanguage: "english",
    },
  });

  // 6. Seed one unread TeacherMessage so Phase 3's blocking modal pops
  //    on the learner's first /esol/home visit. Idempotent: drop any
  //    prior seeded message first so the tester always sees exactly
  //    one to walk through. TeacherMessage doesn't carry the append-
  //    only lock that AuditLog does — direct collection wipe via the
  //    matching tag in `message_text` keeps us inside the model API.
  await TeacherMessage.deleteMany({
    learner_id: learnerId,
    teacher_id: teacherId,
    message_text: { $regex: /\[seed-qa\]/ },
  });
  await TeacherMessage.create({
    teacher_id: teacherId,
    learner_id: learnerId,
    org_id: orgId,
    message_text:
      "[seed-qa] Hi Lara — welcome back! Let's pick up your Stage 3 objective on ordering food in a café this week.",
    language: "en",
    trigger: "manual",
    sent_at: new Date(),
    read_at: null,
  });

  // 7. Seed a handful of AuditLog rows so both Phase 1 surfaces
  //    (learner /profile timeline, teacher Activity tab, org-admin
  //    Audit Log) show real content out of the box.
  //
  //    AuditLog is append-only — the `blockMutation` pre-hook
  //    refuses delete/update by design. We respect that here by
  //    insert-if-absent semantics: count the seeded rows by their
  //    `[seed-qa]` tag and only insert when none are present. A
  //    re-seed therefore preserves the original seeded audit
  //    history instead of duplicating it.
  const existingSeedAudit = await AuditLog.countDocuments({
    learner_id: learnerId,
    reason: { $regex: /\[seed-qa\]/ },
  });
  const skippedAudit = existingSeedAudit > 0;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  if (!skippedAudit)
    await AuditLog.insertMany([
      {
        timestamp: new Date(now - 5 * day),
        actor_type: "system",
        actor_id: null,
        org_id: orgId,
        learner_id: learnerId,
        action: "learner_registered",
        reason: "[seed-qa] Learner account created via QA seed script.",
        before_state: null,
        after_state: null,
        compliance_config_version: null,
      },
      {
        timestamp: new Date(now - 4 * day),
        actor_type: "learner",
        actor_id: learnerId,
        org_id: orgId,
        learner_id: learnerId,
        action: "placement_completed",
        reason:
          "[seed-qa] Placement assessment finished; Gemini scorer assigned E3 with 78% confidence.",
        before_state: null,
        after_state: { esolLevel: "e3" },
        compliance_config_version: null,
      },
      {
        timestamp: new Date(now - 3 * day),
        actor_type: "learner",
        actor_id: learnerId,
        org_id: orgId,
        learner_id: learnerId,
        action: "session_completed",
        reason: "[seed-qa] AI tutor session: ordering food in a café (passed).",
        before_state: null,
        after_state: null,
        compliance_config_version: null,
      },
      {
        timestamp: new Date(now - 2 * day),
        actor_type: "amber_admin",
        actor_id: amberAdminId,
        org_id: orgId,
        learner_id: learnerId,
        action: "eligibility_declared",
        reason:
          "[seed-qa] Funding eligibility confirmed (postcode check + employment status: unemployed).",
        before_state: null,
        after_state: { eligibility_status: "eligible" },
        compliance_config_version: null,
      },
      {
        timestamp: new Date(now - 1 * day),
        actor_type: "teacher",
        actor_id: teacherId,
        org_id: orgId,
        learner_id: learnerId,
        action: "teacher_message_sent",
        reason:
          "[seed-qa] Teacher sent a welcome-back message ahead of this week's session.",
        before_state: null,
        after_state: null,
        compliance_config_version: null,
      },
    ]);

  console.log("");
  console.log(
    "┌──────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "│   QA SEED COMPLETE — login credentials                       │",
  );
  console.log(
    "├──────────────────────────────────────────────────────────────┤",
  );
  console.log(
    `│ Password (every account): ${SEED_PASSWORD}                          │`,
  );
  console.log(
    "├──────────────────────────────────────────────────────────────┤",
  );
  console.log(`│ AMBER ADMIN  : ${EMAIL.amberAdmin}                  │`);
  console.log(`│ ORG ADMIN    : ${EMAIL.orgAdmin}              │`);
  console.log(`│ TEACHER      : ${EMAIL.teacher}                │`);
  console.log(`│ LEARNER      : ${EMAIL.learner}                │`);
  console.log(
    "├──────────────────────────────────────────────────────────────┤",
  );
  console.log(`│ Org id  : ${orgId.toString()}                       │`);
  console.log(`│ Teacher : ${teacherId.toString()}                       │`);
  console.log(`│ Learner : ${learnerId.toString()}                       │`);
  console.log(
    "└──────────────────────────────────────────────────────────────┘",
  );
  console.log("");
  console.log("First-login state:");
  console.log(
    "  • Org admin → /roi-calculator?onboarding=true intercept fires",
  );
  console.log(
    "  • Learner   → 1 unread teacher message → blocking modal pops on /esol/home",
  );
  console.log(
    `  • Learner   → ${skippedAudit ? "audit-log rows already seeded (kept — AuditLog is append-only)" : "5 audit-log rows seeded → Compliance Timeline populated"}`,
  );
  console.log(
    "  • Teacher   → Lara assigned + audit rows visible → Activity tab populated",
  );
  console.log("  • Amber     → access /admin/orgs/<orgId> to test MIS sync UI");

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error("[seedQaUsers] FAILED", err);
  process.exit(1);
});
