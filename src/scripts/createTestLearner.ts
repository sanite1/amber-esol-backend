/**
 * createTestLearner — one-shot CLI script to provision a working
 * ESOL learner you can log in with immediately to test the AI tutor.
 *
 * The legitimate onboarding chain (org-admin invite → email → join
 * wizard → email verification → placement) is 4+ steps and depends
 * on a working SMTP, REFERRAL_JWT_SECRET, and a pre-existing
 * org-admin account. For QA + demo purposes you don't need that
 * chain — you just need a learner that:
 *
 *   1. Has role: "student"
 *   2. Has verified: true   (login refuses unverified users)
 *   3. Has an orgId set     (roleHome sends students-with-no-org
 *                            to "/" instead of "/esol/home")
 *   4. Has esolLevel set    (ScenarioPicker filters by level)
 *
 * This script makes all four true. It is idempotent — re-running it
 * with the same email updates the existing record instead of crashing.
 *
 * Usage
 * -----
 *   cd amber-esol-backend
 *   npx ts-node src/scripts/createTestLearner.ts
 *
 * Optional env-var overrides:
 *   TEST_LEARNER_EMAIL=mariam@example.org
 *   TEST_LEARNER_PASSWORD=LearnerPass123!
 *   TEST_LEARNER_LEVEL=e2     # one of e1 | e2 | e3 | l1 | l2
 *                             # OR "fresh" (no level → learner is sent
 *                             # through /esol/placement on first login,
 *                             # AND any prior placement attempts /
 *                             # AI sessions / vocab for this user are
 *                             # wiped so the test starts cold)
 *   TEST_LEARNER_ORG_NAME="Hillview Adult Learning"
 *
 * Examples:
 *   # Placed learner at E2 (default):
 *   npx ts-node src/scripts/createTestLearner.ts
 *
 *   # Fresh learner who has NOT taken placement:
 *   TEST_LEARNER_EMAIL=fresh@example.org \
 *     TEST_LEARNER_LEVEL=fresh \
 *     npx ts-node src/scripts/createTestLearner.ts
 *
 * Refuses to run in production (NODE_ENV === "production") unless
 * ALLOW_TEST_LEARNER_IN_PROD=1 is also set. Test fixtures must not
 * end up in the production cluster by accident.
 */

import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import User from "../models/User";
import Organisation from "../models/Organisation";
import PlacementAttempt from "../models/PlacementAttempt";
import AISession from "../models/AISession";
import VocabLedger from "../models/VocabLedger";

const MONGO_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DEMO_MONGODB_URI ||
  "";

const EMAIL = process.env.TEST_LEARNER_EMAIL || "testlearner@example.org";
const PASSWORD = process.env.TEST_LEARNER_PASSWORD || "TestLearner123!";

// `fresh` (or empty) means: don't pre-assign a level; let the learner
// take the placement assessment themselves on first login. Otherwise
// one of the five CEFR-aligned levels.
const RAW_LEVEL = (process.env.TEST_LEARNER_LEVEL || "e2").toLowerCase();
const IS_FRESH =
  RAW_LEVEL === "fresh" || RAW_LEVEL === "" || RAW_LEVEL === "none";
const LEVEL = IS_FRESH ? null : (RAW_LEVEL as "e1" | "e2" | "e3" | "l1" | "l2");

const ORG_NAME = process.env.TEST_LEARNER_ORG_NAME || "Hillview Adult Learning";

const main = async (): Promise<void> => {
  // Safety: refuse to run in production unless explicit opt-in.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_TEST_LEARNER_IN_PROD !== "1"
  ) {
    console.error(
      "❌ Refused: NODE_ENV=production. Set ALLOW_TEST_LEARNER_IN_PROD=1 to override.",
    );
    process.exit(1);
  }
  if (!MONGO_URI) {
    console.error(
      "❌ No MONGODB_URI / MONGO_URI / DEMO_MONGODB_URI in env. " +
        "Set one to your connection string and re-run.",
    );
    process.exit(1);
  }

  console.log("→ Connecting to Mongo…");
  await mongoose.connect(MONGO_URI);
  console.log("✓ Connected");

  // ── 1. Get-or-create the org ──────────────────────────────────────
  // Slug is derived from the org name (lowercased, spaces → dashes).
  const slug = ORG_NAME.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  let org = await Organisation.findOne({ slug });
  if (!org) {
    console.log(`→ Creating org "${ORG_NAME}" (slug: ${slug})…`);
    org = await Organisation.create({
      name: ORG_NAME,
      slug,
      paymentModel: "invoiced",
      invoiceCycle: "monthly",
      isActive: true,
      billing_active: true,
      type: "college",
      max_learners_per_teacher: 150,
      misType: "none",
    });
    console.log(`✓ Org created (_id: ${org._id})`);
  } else {
    console.log(`✓ Reusing existing org (_id: ${org._id})`);
  }

  // ── 2. Get-or-create the learner ─────────────────────────────────
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  let learnerId: mongoose.Types.ObjectId;
  const existing = await User.findOne({ email: EMAIL.toLowerCase() });
  if (existing) {
    console.log(`→ Updating existing user ${EMAIL}…`);
    existing.password = passwordHash;
    existing.role = "student";
    existing.verified = true;
    existing.orgId = org._id;
    // For fresh mode, explicitly null the level so the /esol/home
    // placement banner reappears. For levelled mode, set it.
    existing.esolLevel = LEVEL as string | null;
    existing.firstname = existing.firstname || "Test";
    existing.lastname = existing.lastname || "Learner";
    await existing.save();
    learnerId = existing._id as mongoose.Types.ObjectId;
    console.log(`✓ User updated (_id: ${existing._id})`);
  } else {
    console.log(`→ Creating learner ${EMAIL}…`);
    const created = await User.create({
      firstname: "Test",
      lastname: "Learner",
      email: EMAIL.toLowerCase(),
      phoneNumber: "+447700900000", // schema requires; UK reserved test range
      password: passwordHash,
      role: "student",
      status: "active",
      verified: true, // bypass the "Please verify your email" gate
      isActive: true,
      orgId: org._id,
      // null in fresh mode; otherwise the assigned CEFR band.
      esolLevel: LEVEL,
      totalLessonsTaken: 0,
      totalHoursLearned: 0,
      currentStreak: 0,
      longestStreak: 0,
    });
    learnerId = created._id as mongoose.Types.ObjectId;
    console.log(`✓ User created (_id: ${created._id})`);
  }

  // ── 3. (Fresh mode only) Wipe related per-learner state ──────────
  // The User update above clears `esolLevel` on the JWT, but other
  // collections still hold the learner's history — placement
  // attempts, AI sessions, vocab — which would make the "fresh"
  // run not actually fresh. Delete them for a true cold start.
  // Safe because we just confirmed the user is the test learner and
  // we're not in prod.
  if (IS_FRESH) {
    const [pa, ai, vl] = await Promise.all([
      PlacementAttempt.deleteMany({ learnerId }),
      AISession.deleteMany({ learnerId }),
      VocabLedger.deleteMany({ learnerId }),
    ]);
    console.log(
      `✓ Cleared prior progress — placement: ${pa.deletedCount}, ai_sessions: ${ai.deletedCount}, vocab: ${vl.deletedCount}`,
    );
  }

  // ── 3. Print the credentials so the operator can copy/paste ─────
  console.log("");
  console.log("─".repeat(60));
  console.log("READY TO LOG IN");
  console.log("─".repeat(60));
  console.log(`  URL:      <your frontend>/login`);
  console.log(`  Email:    ${EMAIL}`);
  console.log(`  Password: ${PASSWORD}`);
  console.log(`  Role:     student`);
  console.log(`  Org:      ${ORG_NAME}`);
  console.log(`  Level:    ${LEVEL ?? "(unplaced — placement required)"}`);
  console.log("─".repeat(60));
  console.log("");
  if (IS_FRESH) {
    console.log("Fresh learner — esolLevel is null. After login you'll see");
    console.log("the 'Take placement assessment' banner on /esol/home. Click");
    console.log("through the 20-question assessment to get assigned a level.");
  } else {
    console.log("After login you should land on /esol/home with the");
    console.log("scenario picker showing the cards available for this level.");
  }
  console.log("");

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error("❌ Script failed:", err);
  process.exit(1);
});
