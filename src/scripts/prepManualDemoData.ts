// @ts-nocheck
// Dev seed script: deliberately loose Mongoose typings (documents are created with raw
// shapes and `as never`). Always run with `npx ts-node --transpile-only`, never compiled.
/**
 * prepManualDemoData — fills the seed-qa learner with believable data
 * for the USER-MANUAL screenshot captures (docs/manual in the mvp repo).
 *
 * Idempotent: safe to re-run before every capture session. Everything
 * goes through the REAL services where one exists (Stage 3 objectives,
 * vocab ledger) so the data matches what production writes; only the
 * session fixtures are direct model writes (a completed session +
 * an in-progress one for the "resume" screenshot).
 *
 * Usage:
 *   cd amber-esol-backend
 *   npx ts-node --transpile-only src/scripts/prepManualDemoData.ts
 *
 * Refuses to run when NODE_ENV === "production".
 */

import "dotenv/config";
import mongoose from "mongoose";

import User from "../models/User";
import AISession from "../models/AISession";
import TeacherMessage from "../models/TeacherMessage";
import TeacherReview from "../models/TeacherReview";
import Stage5Review from "../models/Stage5Review";
import SafeguardingAlert from "../models/SafeguardingAlert";
import { createHash } from "crypto";
import { createStage3ObjectivesFromPlacement } from "../services/rarpa.service";
import { updateLedgerForTurn } from "../services/vocabLedger.service";
import CurriculumLevelService from "../services/curriculumLevel.service";
import {
  recordTurnEvidence,
  recordSessionCompleteEvidence,
} from "../services/evidenceChain.service";

const LEARNER_EMAIL = "seed-qa-learner@example.com";
const TEACHER_EMAIL = "seed-qa-teacher@example.com";

const daysAgo = (n: number, hour = 10): Date => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 15, 0, 0);
  return d;
};

const main = async () => {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run against production.");
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI || "");
  console.log("✓ Mongo connected");
  await CurriculumLevelService.loadAll();

  const learner = await User.findOne({ email: LEARNER_EMAIL });
  const teacher = await User.findOne({ email: TEACHER_EMAIL });
  if (!learner)
    throw new Error(`${LEARNER_EMAIL} not found — run seed:qa first`);
  const learnerId = learner._id.toString();

  // ── 1. Stage 3 objectives (real service → curriculum bank + audit) ──
  if ((learner.stage3_objectives ?? []).length === 0) {
    const objs = await createStage3ObjectivesFromPlacement(learnerId, "e3", [
      "Sc",
      "Lr",
    ]);
    console.log(`✓ Stage 3 objectives created: ${objs.length}`);
  } else {
    console.log(
      `· Stage 3 objectives already present (${learner.stage3_objectives!.length})`,
    );
  }

  // ── 2. Vocab ledger (real service; encounters shape retained/in-progress) ──
  const ctxBase = {
    orgId: learner.orgId?.toString() ?? null,
    esolLevel: "e3",
  };
  // Retained words: enough encounters at good scores to flip `retained`.
  const retainedWords = [
    "appointment",
    "receptionist",
    "symptoms",
    "prescription",
    "surgery",
  ];
  for (let i = 0; i < 6; i += 1) {
    await updateLedgerForTurn(
      learnerId,
      retainedWords,
      0.85,
      "s1_gp_appointment",
      null,
      {
        ...ctxBase,
        topic: "Booking a GP appointment",
      },
    );
  }
  // In-progress words: 1–2 encounters, mixed scores.
  await updateLedgerForTurn(
    learnerId,
    ["gross pay", "net pay", "deduction", "payslip"],
    0.6,
    "s2_payslip",
    null,
    { ...ctxBase, topic: "Understanding your payslip" },
  );
  await updateLedgerForTurn(
    learnerId,
    ["tenancy", "landlord", "repairs", "deposit"],
    0.55,
    "s3_housing_rights",
    null,
    { ...ctxBase, topic: "Your housing rights" },
  );
  console.log("✓ Vocab ledger populated (5 retained, 8 in progress)");

  // ── 3. Session fixtures ────────────────────────────────────────────
  // (a) A second COMPLETED session so the history list has depth.
  const completedTopic = "Your housing rights";
  const haveCompleted = await AISession.findOne({
    learnerId: learner._id,
    topic: completedTopic,
    completedAt: { $ne: null },
  });
  if (!haveCompleted) {
    await AISession.create({
      learnerId: learner._id,
      orgId: learner.orgId,
      teacherId: teacher?._id ?? null,
      sessionMode: "BRIDGE",
      esolLevel: "e3",
      topic: completedTopic,
      scenario_id: "s3_housing_rights",
      session_source: "ai_tutor",
      duration_mins: 22,
      final_score: 0.78,
      passed: true,
      turns: [
        {
          turnIndex: 0,
          originalInput:
            "My window is broken and the landlord does not answer my messages.",
          scrubbed: false,
          deepSeekResponse:
            "I'm sorry to hear that. Let's practise what you can say. Try: 'I reported the repair two weeks ago. When will it be fixed?'",
          timestamp: daysAgo(3),
        },
        {
          turnIndex: 1,
          originalInput:
            "I reported the repair two weeks ago. When will it be fixed?",
          scrubbed: false,
          deepSeekResponse:
            "Excellent — clear and polite. You used the past tense correctly. Now let's practise asking who to contact if nothing happens.",
          timestamp: daysAgo(3),
        },
      ],
      turn_scores: [0.7, 0.85],
      teaching_mode_sequence: ["bridge", "bridge"],
      vocabIntroduced: ["tenancy", "landlord", "repairs"],
      assessmentSummary:
        "You explained a housing problem clearly and used the past tense well. Next time we will practise formal emails to your landlord.",
      completedAt: daysAgo(3, 11),
      start_time: daysAgo(3),
      end_time: daysAgo(3, 11),
      beat: "complete",
      micro_stage_index: 3,
      micro_stages_completed: [true, true, true, true],
      createdAt: daysAgo(3),
    } as never);
    console.log("✓ Completed housing session created");
  } else {
    console.log("· Completed housing session already present");
  }

  // (b) An IN-PROGRESS session with turns — the "resume" screenshot.
  const inProgressTopic = "Understanding your payslip";
  const haveInProgress = await AISession.findOne({
    learnerId: learner._id,
    topic: inProgressTopic,
    completedAt: null,
  });
  if (!haveInProgress) {
    await AISession.create({
      learnerId: learner._id,
      orgId: learner.orgId,
      teacherId: teacher?._id ?? null,
      sessionMode: "BRIDGE",
      esolLevel: "e3",
      topic: inProgressTopic,
      scenario_id: "s2_payslip",
      session_source: "ai_tutor",
      turns: [
        {
          turnIndex: 0,
          originalInput: "I do not understand the line that says deduction.",
          scrubbed: false,
          deepSeekResponse:
            "Good question! A deduction is money taken away from your pay — for example tax. Look at your payslip: gross pay is the total before deductions, net pay is what you receive. Can you tell me your gross pay from the example?",
          timestamp: daysAgo(1),
        },
      ],
      turn_scores: [0.65],
      teaching_mode_sequence: ["bridge"],
      vocabIntroduced: ["deduction", "gross pay", "net pay"],
      beat: "roleplay",
      micro_stage_index: 1,
      micro_stages_completed: [true, false, false, false],
      start_time: daysAgo(1),
      createdAt: daysAgo(1),
    } as never);
    console.log("✓ In-progress payslip session created");
  } else {
    console.log("· In-progress payslip session already present");
  }

  // ── 3c. A teacher review (Reviews tab + GLH contribution) ──────────
  if (teacher) {
    const haveReview = await TeacherReview.findOne({
      learner_id: learner._id,
      teacher_id: teacher._id,
    });
    if (!haveReview) {
      await TeacherReview.create({
        learner_id: learner._id,
        teacher_id: teacher._id,
        org_id: learner.orgId,
        review_type: "contact_session",
        duration_mins: 30,
        notes:
          "30 minute consolidation call. Lara is confident with GP vocabulary; we practised spelling her postcode aloud. Next focus: payslip vocabulary before her workplace scenario.",
        ai_recommendation_acted_on: true,
        created_at: daysAgo(2, 15),
      } as never);
      console.log("✓ Teacher review created (contact_session, 30 mins)");
    } else {
      console.log("· Teacher review already present");
    }
  }

  // ── 4. Unread teacher message (blocking-modal + Messages page) ─────
  if (teacher) {
    const unread = await TeacherMessage.findOne({
      learner_id: learner._id,
      read_at: null,
    });
    if (!unread) {
      await TeacherMessage.create({
        teacher_id: teacher._id,
        learner_id: learner._id,
        org_id: learner.orgId,
        message_text:
          "Well done on your GP appointment practice this week, Lara! Before our next session, try the payslip scenario — it will help with the vocabulary we discussed.",
        language: "en",
        read_at: null,
      } as never);
      console.log("✓ Unread teacher message created");
    } else {
      console.log("· Unread teacher message already present");
    }
  }

  // ── 4b. Evidence chain rows for the completed housing session ──────
  // Written through the real evidenceChain service (the same writes the
  // capture-evidence worker performs), so the org admin Evidence Chain
  // tab shows genuine mapped records.
  const housing = await AISession.findOne({
    learnerId: learner._id,
    topic: "Your housing rights",
    completedAt: { $ne: null },
  }).select("_id turn_scores");
  if (housing) {
    const sessionId = housing._id.toString();
    await recordTurnEvidence({
      learnerId,
      orgId: learner.orgId?.toString() ?? null,
      sessionId,
      turnIndex: 0,
      turnScore: 0.7,
      skillCodesUsed: ["Sc", "Lr"],
      vocabularyItemsUsed: ["landlord", "repairs"],
      mode: "bridge",
      recastApplied: true,
    });
    await recordTurnEvidence({
      learnerId,
      orgId: learner.orgId?.toString() ?? null,
      sessionId,
      turnIndex: 1,
      turnScore: 0.85,
      skillCodesUsed: ["Sc"],
      vocabularyItemsUsed: ["tenancy", "deposit"],
      mode: "bridge",
      recastApplied: false,
    });
    await recordSessionCompleteEvidence({
      learnerId,
      orgId: learner.orgId?.toString() ?? null,
      sessionId,
      sessionSummary:
        "You explained a housing problem clearly and used the past tense well. Next time we will practise formal emails to your landlord.",
    });
    console.log("✓ Evidence chain rows written for housing session");
  }

  // Teacher hours: the direct TeacherReview fixture bypassed the service
  // that increments the learner's teacher contact hours, so set it here.
  if ((learner.glh_teacher_contact ?? 0) < 0.5) {
    await User.updateOne(
      { _id: learner._id },
      { $set: { glh_teacher_contact: 0.5 } },
    );
    console.log("✓ Teacher contact hours set to 0.5");
  }

  // ── 5. Stage 5 review awaiting ORG ADMIN approval ──────────────────
  // The state that exercises the approval surfaces: learner self
  // assessment submitted, AI summary generated, teacher signed off,
  // org admin confirmation still pending (the honesty gate final step).
  const freshLearner = await User.findById(learner._id)
    .select("stage3_objectives orgId")
    .lean();
  const objsSnapshot = (freshLearner?.stage3_objectives ?? []) as Array<{
    id: string;
    description: string;
  }>;
  const haveStage5 = await Stage5Review.findOne({
    learner_id: learner._id,
    org_admin_confirmed_at: null,
  });
  if (!haveStage5 && objsSnapshot.length > 0) {
    const objectiveRatings: Record<string, string> = {};
    for (const o of objsSnapshot) objectiveRatings[o.id] = "confident";
    await Stage5Review.create({
      learner_id: learner._id,
      org_id: learner.orgId,
      level_completed: "e3",
      stage3_objectives: objsSnapshot,
      learner_self_assessment: {
        confidence_rating: "high",
        objective_ratings: objectiveRatings,
        submitted_at: daysAgo(1, 9).toISOString(),
      },
      ai_tutor_summary: {
        summary:
          "Lara has completed her Entry 3 pathway with steady, confident progress. She opens conversations politely, describes past events accurately, and recovers well when she does not understand. Her GP appointment and housing sessions show she can handle real UK situations independently. She is ready to be stretched at the next level.",
        key_achievements: [
          "Booked a GP appointment unprompted, giving her details clearly",
          "Used the past simple correctly across two consecutive sessions",
          "Retained 5 core vocabulary items including appointment and prescription",
        ],
        readiness_for_next_level: "high",
        generated_at: daysAgo(1, 10).toISOString(),
        model: "gemini-2.5-flash",
        input_tokens: 2400,
        output_tokens: 320,
      },
      teacher_signed_off_at: daysAgo(1, 14),
      teacher_id: teacher?._id ?? null,
      org_admin_confirmed_at: null,
    } as never);
    console.log("✓ Stage 5 review created (awaiting org admin approval)");
  } else {
    console.log("· Stage 5 review already present or no objectives");
  }

  // ── 6. A safeguarding alert (Amber admin queue) ────────────────────
  // Attached to Stephen (a seed learner other than Lara) so the learner
  // chapter's narrative stays untouched. A dedicated session carries it
  // so the alert links to something real.
  const stephen = await User.findOne({
    firstname: "Stephen",
    orgId: learner.orgId,
  });
  if (stephen) {
    const haveAlert = await SafeguardingAlert.findOne({
      learnerId: stephen._id,
    });
    if (!haveAlert) {
      const sgSession = await AISession.create({
        learnerId: stephen._id,
        orgId: stephen.orgId,
        teacherId: teacher?._id ?? null,
        sessionMode: "ANCHOR",
        esolLevel: "e2",
        topic: "Booking a GP appointment",
        scenario_id: "s1_gp_appointment",
        session_source: "ai_tutor",
        safeguardingFlagged: true,
        turns: [],
        start_time: daysAgo(0, 9),
        createdAt: daysAgo(0, 9),
      } as never);
      await SafeguardingAlert.create({
        learnerId: stephen._id,
        orgId: stephen.orgId,
        sessionId: sgSession._id,
        alertLevel: "high",
        messageContentHash: createHash("sha256")
          .update("manual-demo-disclosure")
          .digest("hex"),
        triggerCategory: "domestic_abuse",
        triggerSource: "keyword",
        status: "open",
      } as never);
      console.log("✓ Safeguarding alert created (Stephen, open, high)");
    } else {
      console.log("· Safeguarding alert already present");
    }
  }

  console.log("\nDone. Learner data ready for manual captures.");
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
