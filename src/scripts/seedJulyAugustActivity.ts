// @ts-nocheck
// Dev seed script: deliberately loose Mongoose typings (documents are created with raw
// shapes and `as never`). Always run with `npx ts-node --transpile-only`, never compiled.
/**
 * seedJulyAugustActivity.ts
 *
 * Backfills realistic, fully connected demo activity for 1 July – 19 Aug 2026
 * so every dashboard (learner / teacher / org admin / amber admin) shows a
 * busy, internally consistent system.
 *
 * Everything a real service would have derived is set here explicitly and
 * consistently with the backdated history:
 *   - AISession rows carry turns, scores, vocab, evidence + audit rows
 *   - VocabLedger rows obey the retention rule (retained ⇒ ≥5 encounters)
 *   - TeacherReview rows credit User.glh_teacher_contact via the same
 *     per-type contribution the live endpoint uses
 *   - User.last_session_at / cohort_status / teacher_priority_* mirror what
 *     the daily crons would compute from this history
 *
 * Idempotency: aborts if the sentinel user (emre.kaya@example.org) exists.
 * Run:  npx ts-node --transpile-only src/scripts/seedJulyAugustActivity.ts
 */
import "dotenv/config";
import mongoose, { Types } from "mongoose";
import bcrypt from "bcrypt";
import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";

import User from "../models/User";
import Organisation from "../models/Organisation";
import AISession from "../models/AISession";
import AuditLog from "../models/AuditLog";
import TeacherReview from "../models/TeacherReview";
import TeacherMessage from "../models/TeacherMessage";
import VocabLedger from "../models/VocabLedger";
import EvidenceRecord from "../models/EvidenceRecord";
import Stage5Review from "../models/Stage5Review";
import SafeguardingAlert from "../models/SafeguardingAlert";
import ReferralToken from "../models/ReferralToken";
import PlacementAttempt from "../models/PlacementAttempt";
import Notification from "../models/Notification";
import OrgInvoice from "../models/OrgInvoice";

/* ── deterministic PRNG so re-runs (after wipe) produce identical data ── */
let prngState = 0x5eed2026;
const rand = (): number => {
  prngState |= 0;
  prngState = (prngState + 0x6d2b79f5) | 0;
  let t = Math.imul(prngState ^ (prngState >>> 15), 1 | prngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ── date helpers (UTC, year 2026) ── */
const D = (m: number, d: number, h = 10, min = 15) =>
  new Date(Date.UTC(2026, m - 1, d, h, min, 0, 0));
const addMins = (d: Date, mins: number) => new Date(d.getTime() + mins * 60000);

/* ── evidence mapping (same JSON the live service reads) ── */
const mappingPath = path.join(
  __dirname,
  "../data/curriculum/evidence_mapping.json",
);
const evidenceMapping = JSON.parse(fs.readFileSync(mappingPath, "utf8"));
const mappingVersion: number = evidenceMapping?.meta?.version ?? 1;
const mapFor = (beat: string, dataPoint: string) => {
  const list = evidenceMapping[beat] ?? [];
  const hit = list.find(
    (e: { data_point: string }) => e.data_point === dataPoint,
  );
  return {
    ilr_fields: hit?.ilr_fields ?? [],
    rarpa_stage: hit?.rarpa_stage ?? "Stage 4 (formative)",
    human_confirm: hit?.human_confirm ?? false,
  };
};

/* ── scenario content banks ── */
type ScenKey = "s1" | "s2" | "s3" | "s4";
const SCENARIOS: Record<
  ScenKey,
  {
    id: string;
    topic: string;
    vocab: string[];
    skills: string[];
    turns: Array<[string, string]>;
  }
> = {
  s1: {
    id: "s1_gp_appointment",
    topic: "Booking a GP appointment",
    vocab: [
      "appointment",
      "receptionist",
      "symptoms",
      "prescription",
      "surgery",
      "urgent",
      "temperature",
      "pharmacy",
    ],
    skills: ["Sc", "Lr"],
    turns: [
      [
        "Hello, I want to see doctor please. I have pain in my back for three days.",
        "Thank you for calling the surgery. I can help you book an appointment. Can you tell me a little more about the pain?",
      ],
      [
        "The pain is strong when I sit long time. I take paracetamol but not help much.",
        "I see, thank you for explaining. We have an appointment on Thursday morning at 9:40 with Dr Ellis. Would that suit you?",
      ],
      [
        "Yes Thursday morning is good for me. What I need to bring?",
        "Just bring a list of any medicine you take. Can I take your name and date of birth to confirm the booking?",
      ],
      [
        "My name is on my NHS card, I bring it too. Thank you for help.",
        "Perfect. You are booked for Thursday at 9:40. If it gets worse before then, call 111. Well done — you booked the appointment clearly and politely.",
      ],
    ],
  },
  s2: {
    id: "s2_payslip",
    topic: "Understanding your payslip",
    vocab: [
      "payslip",
      "gross pay",
      "net pay",
      "deduction",
      "tax code",
      "National Insurance",
      "overtime",
      "pension",
    ],
    skills: ["Rt", "Sc"],
    turns: [
      [
        "I look at my payslip but I not understand why the money is less than my contract say.",
        "Good question — that difference is usually deductions. Can you see a line that says gross pay, and another that says net pay?",
      ],
      [
        "Yes, gross pay is more big number and net pay is what I receive in bank.",
        "Exactly right. Gross pay is before deductions; net pay is after. Which deductions can you see listed?",
      ],
      [
        "I see tax, and National Insurance, and one line say pension 3 percent.",
        "Well done — those are the three most common. Tax and National Insurance go to the government; the pension is saved for you.",
      ],
      [
        "So if my tax code is wrong I can pay too much tax? Who I must call?",
        "Yes — if the code is wrong you can overpay. You would contact HMRC and your employer's payroll. You explained the payslip really clearly today.",
      ],
    ],
  },
  s3: {
    id: "s3_housing_rights",
    topic: "Your housing rights",
    vocab: [
      "tenancy",
      "landlord",
      "repairs",
      "deposit",
      "boiler",
      "damp",
      "notice",
      "inspection",
    ],
    skills: ["Sc", "Ws"],
    turns: [
      [
        "Hello, I am your tenant in flat 4. The boiler is broken since Monday and we have no hot water.",
        "Thank you for letting me know so clearly. I'm sorry about the boiler. When would be a good time for an engineer to visit?",
      ],
      [
        "Tomorrow morning I am home before 11. This is second time this year it break.",
        "Understood, I'll book the engineer for tomorrow before 11. As it keeps failing, I'll ask him about a replacement too.",
      ],
      [
        "Thank you. Also I want ask about the damp in the bedroom wall, it come back again.",
        "I'll ask the engineer to inspect the damp at the same visit. You are right to report it — damp is my responsibility to fix under the tenancy.",
      ],
    ],
  },
  s4: {
    id: "s4_pay_rise_negotiation",
    topic: "Negotiating a pay rise",
    vocab: [
      "salary",
      "negotiation",
      "appraisal",
      "benefits",
      "promotion",
      "probation",
      "contract",
      "review",
    ],
    skills: ["Sc", "Sd"],
    turns: [
      [
        "Thank you for meeting me. In my appraisal you said my work exceeded expectations, so I would like to discuss my salary.",
        "Of course, thank you for raising it directly. Can you talk me through the contribution you feel justifies a rise?",
      ],
      [
        "Over the last year I trained two new colleagues and took over the monthly reporting, which saved the team around a day each month.",
        "That's a strong, specific case. The budget review is next month; I can propose a four percent increase and an updated job title.",
      ],
      [
        "I appreciate that. Could we also put a date in the diary to review it again in six months?",
        "Yes, that's reasonable. I'll confirm the proposal in writing this week and we'll book the six month review now. You negotiated that very professionally.",
      ],
    ],
  },
};

/* ── glh contribution (mirror of teacherGlhContribution.ts) ── */
const glhFor = (type: string, mins: number): number => {
  switch (type) {
    case "async_review":
      return 0.25;
    case "pathway_adjustment":
      return 0.25;
    case "rarpa_signoff":
      return 0.5;
    case "contact_session":
      return Math.max(0, mins) / 60;
    default:
      return 0;
  }
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to run demo seed in production");
  }
  await mongoose.connect(process.env.MONGODB_URI || "");
  console.log("Connected.");

  const sentinel = await AISession.findOne({
    createdAt: { $gte: D(7, 1, 0, 0), $lt: D(7, 20, 0, 0) },
    session_source: "ai_tutor",
  });
  if (sentinel) {
    console.log("July sessions already present — already seeded. Aborting.");
    await mongoose.disconnect();
    return;
  }

  /* ── look up existing cast ── */
  const byEmail = async (email: string) => {
    const u = await User.findOne({ email });
    if (!u) throw new Error(`Missing expected user ${email}`);
    return u;
  };
  const amberAdmin = await byEmail("seed-qa-admin@example.com");
  const orla = await byEmail("seed-qa-orgadmin@example.com");
  const theo = await byEmail("seed-qa-teacher@example.com");
  const lara = await byEmail("seed-qa-learner@example.com");
  const stephen = await byEmail("bitecgroup1@gmail.com");
  const collins = await byEmail("renahconstructions@gmail.com");
  const amina = await byEmail("testlearner@example.org"); // rename → Amina Yusuf
  const wei = await byEmail("freshlearner@example.org"); // rename → Wei Chen
  const nadia = await byEmail("fresh@example.org"); // rename → Nadia Osman

  const seedOrg = await Organisation.findOne({ name: "Seed QA Organisation" });
  const hillview = await Organisation.findOne({
    name: "Hillview Adult Learning",
  });
  const burnex = await Organisation.findOne({ name: "Burnex Solutions" });
  if (!seedOrg || !hillview || !burnex)
    throw new Error("Missing an organisation");

  const hashed = await bcrypt.hash("TestPass1!", 10);

  /* ══ 1. NEW USERS (kept to three) ══ */
  console.log(
    "1) Creating Priya (Hillview teacher), Hana (Hillview org admin), Emre (Seed QA learner)…",
  );
  const createOrReuse = async (email: string, doc: Record<string, unknown>) => {
    const existing = await User.findOne({ email });
    if (existing) return existing;
    return User.create(doc as never);
  };
  const priya = await createOrReuse("hillview-teacher@example.org", {
    firstname: "Priya",
    lastname: "Sharma",
    email: "hillview-teacher@example.org",
    password: hashed,
    phoneNumber: "07100000201",
    role: "tutor",
    verified: true,
    isActive: true,
    status: "active",
    orgId: hillview._id,
    esolTeacherApproved: true,
    dbsCheckStatus: "clear",
    esolQualificationType: "CELTA",
    teaching_profile: {
      levels_taught: ["e1", "e2", "e3", "l1", "l2"],
      languages_spoken: ["Arabic", "Cantonese", "Somali"],
      specialisms: ["everyday_english", "employability"],
    },
    averageRating: 4.8,
    numberOfReviews: 6,
    lastLogin: D(8, 19, 8, 40),
    createdAt: D(6, 20, 9, 0),
  });

  const hana = await createOrReuse("hillview-admin@example.org", {
    firstname: "Hana",
    lastname: "Whitfield",
    email: "hillview-admin@example.org",
    password: hashed,
    phoneNumber: "07100000202",
    role: "org_admin",
    verified: true,
    isActive: true,
    status: "active",
    orgId: hillview._id,
    lastLogin: D(8, 18, 16, 5),
    createdAt: D(6, 20, 9, 0),
  });

  const emre = await createOrReuse("emre.kaya@example.org", {
    firstname: "Emre",
    lastname: "Kaya",
    email: "emre.kaya@example.org",
    password: hashed,
    phoneNumber: "07100000203",
    role: "student",
    verified: true,
    isActive: true,
    status: "active",
    orgId: seedOrg._id,
    esolLevel: "e2",
    starting_level: "e2",
    l1Language: "Turkish",
    uln: "4152098637",
    esol_aim_type: "regulated",
    assigned_teacher_id: theo._id,
    lastLogin: D(8, 17, 18, 30),
    createdAt: D(7, 14, 10, 5),
  });

  /* ══ 2. DATA QUALITY FIXES on existing users ══ */
  console.log("2) Fixing levels, names, L1, ULNs, last logins…");
  await User.updateOne(
    { _id: stephen._id },
    {
      $set: {
        esolLevel: "e2",
        starting_level: "e2",
        uln: "3067412985",
        esol_aim_type: "regulated",
        assigned_teacher_id: theo._id,
        lastLogin: D(8, 19, 9, 10),
      },
    },
  );
  await User.updateOne(
    { _id: collins._id },
    {
      $set: {
        esolLevel: "e1",
        starting_level: "e1",
        uln: "2098431756",
        esol_aim_type: "regulated",
        assigned_teacher_id: theo._id,
        lastLogin: D(8, 10, 19, 45),
      },
    },
  );
  await User.updateOne(
    { _id: lara._id },
    {
      $set: {
        l1Language: "Turkish",
        uln: "1049283746",
        starting_level: "e2",
        esol_aim_type: "regulated",
        assigned_teacher_id: theo._id,
      },
    },
  );
  await User.updateOne(
    { _id: amina._id },
    {
      $set: {
        firstname: "Amina",
        lastname: "Yusuf",
        l1Language: "Arabic",
        esolLevel: "e2",
        starting_level: "e2",
        uln: "5083716249",
        esol_aim_type: "regulated",
        assigned_teacher_id: priya._id,
        lastLogin: D(8, 15, 11, 20),
      },
    },
  );
  await User.updateOne(
    { _id: wei._id },
    {
      $set: {
        firstname: "Wei",
        lastname: "Chen",
        l1Language: "Cantonese",
        esolLevel: "l2",
        starting_level: "l1",
        uln: "6021573948",
        esol_aim_type: "regulated",
        assigned_teacher_id: priya._id,
        lastLogin: D(8, 18, 20, 10),
      },
    },
  );
  await User.updateOne(
    { _id: nadia._id },
    {
      $set: {
        firstname: "Nadia",
        lastname: "Osman",
        l1Language: "Somali",
        assigned_teacher_id: priya._id,
        lastLogin: D(8, 18, 23, 5),
      },
    },
  );
  await User.updateOne(
    { _id: theo._id },
    {
      $set: {
        dbsCheckStatus: "clear",
        esolQualificationType: "DipTESOL",
        averageRating: 4.9,
        numberOfReviews: 11,
        teaching_profile: {
          levels_taught: ["e1", "e2", "e3"],
          languages_spoken: ["French", "Turkish"],
          specialisms: ["everyday_english", "exam_preparation"],
        },
      },
    },
  );
  // Legacy accounts: give the two "never logged in" users a real date.
  await User.updateOne(
    { email: "jennifer.iloan@gmail.com" },
    { $set: { lastLogin: D(7, 22, 13, 40) } },
  );
  await User.updateOne(
    { email: "bahdguy496@gmail.com" },
    { $set: { lastLogin: D(7, 3, 9, 25) } },
  );

  /* ══ 3. ORGANISATIONS: contracts, fees, contacts, teacher rosters ══ */
  console.log("3) Updating organisations…");
  await Organisation.updateOne(
    { _id: seedOrg._id },
    {
      $set: {
        contractStart: D(6, 1, 0, 0),
        contractEnd: new Date(Date.UTC(2027, 4, 31)),
        monthly_fee_per_head: 12,
        billing_active: true,
      },
      $addToSet: { assigned_teacher_ids: theo._id },
    },
  );
  await Organisation.updateOne(
    { _id: hillview._id },
    {
      $set: {
        adminUserId: hana._id,
        contactName: "Hana Whitfield",
        contactEmail: "hillview-admin@example.org",
        contractStart: D(6, 1, 0, 0),
        contractEnd: new Date(Date.UTC(2027, 7, 31)),
        monthly_fee_per_head: 10,
        billing_active: true,
        paymentModel: "invoiced",
      },
      $addToSet: { assigned_teacher_ids: priya._id },
    },
  );

  /* ══ 4. STAGE 3 OBJECTIVES (direct, backdated set_at) ══ */
  console.log("4) Writing Stage 3 objectives…");
  const OBJ_TEXT: Record<string, Record<string, string>> = {
    Sc: {
      e1: "Take part in a short everyday conversation, for example greeting the GP receptionist and answering simple questions.",
      e2: "Hold a clear two way conversation about everyday services, asking follow up questions when something is unclear.",
      e3: "Explain a problem and negotiate a practical outcome in conversations about work, health, or housing.",
      l2: "Lead a formal discussion at work, presenting a case with evidence and responding to challenge confidently.",
    },
    Lr: {
      e1: "Understand the main point when someone speaks slowly about a familiar everyday topic.",
      e2: "Follow the key details of spoken information such as appointment times, prices, and instructions.",
      e3: "Follow extended speech about practical topics and pick out specific detail reliably.",
      l2: "Follow fast natural speech in meetings and identify speaker attitude as well as content.",
    },
    Rt: {
      e2: "Read short everyday documents such as a payslip or letter and find the specific facts needed.",
      e3: "Read longer everyday documents and work out unfamiliar words from context.",
      l2: "Read complex workplace documents critically, separating fact from opinion.",
    },
  };
  const mkObj = (skill: string, level: string, setAt: Date) => ({
    id: randomUUID(),
    skill_domain: skill,
    description:
      OBJ_TEXT[skill]?.[level] ??
      OBJ_TEXT[skill]?.e2 ??
      "Improve everyday English communication.",
    set_at: setAt,
    set_from: "placement_assessment",
    target_level: level,
  });
  const general = (level: string, setAt: Date) => ({
    id: randomUUID(),
    skill_domain: "general",
    description:
      "Build the confidence to handle everyday UK life in English without needing to prepare every sentence first.",
    set_at: setAt,
    set_from: "placement_assessment",
    target_level: level,
  });

  const ensureObjectives = async (
    u: { _id: Types.ObjectId },
    level: string,
    skills: string[],
    setAt: Date,
  ) => {
    const fresh = await User.findById(u._id).select(
      "stage3_objectives l1Language",
    );
    if (fresh && (fresh.stage3_objectives?.length ?? 0) > 0)
      return fresh.stage3_objectives;
    const objs = [
      ...skills.map((s) => mkObj(s, level, setAt)),
      general(level, setAt),
    ];
    await User.updateOne({ _id: u._id }, { $set: { stage3_objectives: objs } });
    return objs;
  };

  const objStephen = await ensureObjectives(
    stephen,
    "e2",
    ["Sc", "Lr"],
    D(6, 11, 10, 0),
  );
  const objCollins = await ensureObjectives(
    collins,
    "e1",
    ["Sc", "Lr"],
    D(6, 11, 12, 0),
  );
  const objEmre = await ensureObjectives(
    emre,
    "e2",
    ["Sc", "Rt"],
    D(7, 14, 11, 30),
  );
  const objAmina = await ensureObjectives(
    amina,
    "e2",
    ["Sc", "Rt"],
    D(6, 9, 12, 0),
  );
  const objWei = await ensureObjectives(
    wei,
    "l2",
    ["Sc", "Rt"],
    D(7, 12, 9, 30),
  );
  const objLara =
    (await User.findById(lara._id).select("stage3_objectives"))!
      .stage3_objectives ?? [];

  /* ══ 5. REFERRALS + PLACEMENT (the proper joining flow, backdated) ══ */
  console.log("5) Referral tokens + Emre placement…");
  await ReferralToken.deleteMany({ token: /^demo-/ });
  await PlacementAttempt.deleteMany({ learnerId: emre._id });
  await ReferralToken.create({
    orgId: seedOrg._id,
    token: `demo-${randomUUID()}`,
    email: "emre.kaya@example.org",
    esolLevel: null,
    usedBy: emre._id,
    usedAt: D(7, 14, 10, 5),
    isActive: false,
    expiresAt: D(8, 11, 0, 0),
    created_by: orla._id,
    usage_count: 1,
    createdAt: D(7, 12, 15, 20),
  } as never);
  await ReferralToken.create({
    orgId: hillview._id,
    token: `demo-${randomUUID()}`,
    email: "fresh@example.org",
    esolLevel: null,
    usedBy: nadia._id,
    usedAt: D(8, 18, 22, 40),
    isActive: false,
    expiresAt: D(9, 16, 0, 0),
    created_by: hana._id,
    usage_count: 1,
    createdAt: D(8, 17, 14, 10),
  } as never);
  await ReferralToken.create({
    orgId: hillview._id,
    token: `demo-${randomUUID()}`,
    email: undefined,
    esolLevel: null,
    usedBy: null,
    usedAt: null,
    isActive: true,
    expiresAt: D(9, 30, 0, 0),
    created_by: hana._id,
    usage_count: 0,
    createdAt: D(8, 14, 9, 45),
  } as never);

  const answers = Array.from({ length: 20 }, (_, i) => ({
    question_id: `b3_q${String(i + 1).padStart(2, "0")}`,
    answer: pick(["a", "b", "c", "d"]),
    was_correct: i < 13 ? rand() > 0.25 : rand() > 0.6,
    answered_at: addMins(D(7, 14, 10, 20), i),
  }));
  await PlacementAttempt.create({
    learnerId: emre._id,
    orgId: seedOrg._id,
    bank_version: 3,
    selected_question_ids: answers.map((a) => a.question_id),
    answers,
    status: "scored",
    recalc_applied_at: addMins(D(7, 14, 10, 20), 5),
    recalc_outcome: "mixed",
    startedAt: D(7, 14, 10, 18),
    result: {
      nqf_level: "e2",
      placement_confidence: 0.84,
      skill_breakdown: {
        speaking: 0.6,
        listening: 0.65,
        reading: 0.5,
        writing: 0.45,
      },
      weakness_flags: ["Rt", "Ww"],
      rationale:
        "Consistent performance at Entry 2 descriptors; reading and writing slightly weaker than speaking and listening.",
    },
  } as never);

  /* ══ 6. SESSION GENERATION (Jul 1 – Aug 19) ══ */
  console.log("6) Generating sessions…");
  type Plan = {
    user: { _id: Types.ObjectId };
    org: Types.ObjectId;
    teacher: Types.ObjectId;
    level: string;
    scens: ScenKey[];
    scoreLo: number;
    scoreHi: number;
    fromM: number;
    fromD: number;
    toM: number;
    toD: number;
    perWeek: number;
    modes: string[];
    objs: Array<{ id: string }>;
    improving?: boolean;
  };
  const plans: Record<string, Plan> = {
    lara: {
      user: lara,
      org: seedOrg._id,
      teacher: theo._id,
      level: "e3",
      scens: ["s1", "s2", "s3"],
      scoreLo: 0.68,
      scoreHi: 0.9,
      fromM: 7,
      fromD: 1,
      toM: 8,
      toD: 14,
      perWeek: 3,
      modes: ["bridge", "immersion"],
      objs: objLara as never,
    },
    stephen: {
      user: stephen,
      org: seedOrg._id,
      teacher: theo._id,
      level: "e2",
      scens: ["s1", "s2"],
      scoreLo: 0.32,
      scoreHi: 0.58,
      fromM: 7,
      fromD: 2,
      toM: 8,
      toD: 16,
      perWeek: 2,
      modes: ["anchor", "bridge"],
      objs: objStephen as never,
    },
    collins: {
      user: collins,
      org: seedOrg._id,
      teacher: theo._id,
      level: "e1",
      scens: ["s1"],
      scoreLo: 0.5,
      scoreHi: 0.7,
      fromM: 7,
      fromD: 1,
      toM: 8,
      toD: 10,
      perWeek: 2,
      modes: ["anchor", "bridge"],
      objs: objCollins as never,
    },
    emre: {
      user: emre,
      org: seedOrg._id,
      teacher: theo._id,
      level: "e2",
      scens: ["s1", "s2"],
      scoreLo: 0.55,
      scoreHi: 0.82,
      fromM: 7,
      fromD: 15,
      toM: 8,
      toD: 17,
      perWeek: 3,
      modes: ["bridge"],
      objs: objEmre as never,
      improving: true,
    },
    amina: {
      user: amina,
      org: hillview._id,
      teacher: priya._id,
      level: "e2",
      scens: ["s1", "s2"],
      scoreLo: 0.42,
      scoreHi: 0.55,
      fromM: 7,
      fromD: 1,
      toM: 8,
      toD: 15,
      perWeek: 2,
      modes: ["anchor", "bridge"],
      objs: objAmina as never,
    },
    wei: {
      user: wei,
      org: hillview._id,
      teacher: priya._id,
      level: "l2",
      scens: ["s2", "s4"],
      scoreLo: 0.78,
      scoreHi: 0.95,
      fromM: 7,
      fromD: 1,
      toM: 8,
      toD: 18,
      perWeek: 3,
      modes: ["immersion", "bridge"],
      objs: objWei as never,
    },
  };

  const sessionsByLearner: Record<
    string,
    Array<{
      id: Types.ObjectId;
      when: Date;
      score: number;
      scen: ScenKey;
      doc: Record<string, unknown>;
    }>
  > = {};
  const auditRows: Array<Record<string, unknown>> = [];
  const evidenceRows: Array<Record<string, unknown>> = [];
  const vocabAgg: Record<
    string,
    Map<
      string,
      {
        count: number;
        hiScore: number;
        first: Date;
        last: Date;
        scen: ScenKey;
        level: string;
        org: Types.ObjectId;
        sess: Types.ObjectId;
      }
    >
  > = {};

  for (const [key, p] of Object.entries(plans)) {
    sessionsByLearner[key] = [];
    vocabAgg[key] = new Map();
    const start = D(p.fromM, p.fromD);
    const end = D(p.toM, p.toD, 23, 59);
    const spanDays = Math.floor((end.getTime() - start.getTime()) / 86400000);
    const totalWeeks = Math.max(1, Math.round(spanDays / 7));
    let n = 0;
    for (let w = 0; w < totalWeeks; w++) {
      const inWeek = Math.max(1, Math.round(p.perWeek + (rand() - 0.5)));
      const usedDays = new Set<number>();
      for (let s = 0; s < inWeek; s++) {
        let dayOff = Math.floor(between(0, 6.99));
        while (usedDays.has(dayOff)) dayOff = (dayOff + 1) % 7;
        usedDays.add(dayOff);
        const dayStart = new Date(
          start.getTime() + (w * 7 + dayOff) * 86400000,
        );
        if (dayStart > end) continue;
        const hour = Math.floor(between(8, 21));
        const startAt = new Date(
          Date.UTC(
            2026,
            dayStart.getUTCMonth(),
            dayStart.getUTCDate(),
            hour,
            Math.floor(between(0, 59)),
          ),
        );
        const scen = pick(p.scens);
        const S = SCENARIOS[scen];
        const progress = p.improving ? n / 14 : rand();
        const base =
          p.scoreLo +
          (p.scoreHi - p.scoreLo) *
            (p.improving ? Math.min(1, 0.2 + progress) : rand());
        const nTurns = 2 + Math.floor(between(0, S.turns.length - 1.01));
        const turnScores = Array.from({ length: nTurns }, () =>
          round2(Math.min(0.98, Math.max(0.15, base + between(-0.07, 0.07)))),
        );
        const finalScore = round2(
          turnScores.reduce((a, b) => a + b, 0) / nTurns,
        );
        const durationMins = Math.round(between(9, 26));
        const endAt = addMins(startAt, durationMins);
        const mode = pick(p.modes);
        const vocabUsed = [...S.vocab]
          .sort(() => rand() - 0.5)
          .slice(0, 2 + Math.floor(between(0, 2.99)));
        const objIds = p.objs.length ? [pick(p.objs).id] : [];
        const sessId = new Types.ObjectId();
        const turns = S.turns.slice(0, nTurns).map((t, i) => ({
          turnIndex: i,
          originalInput: t[0],
          scrubbed: false,
          deepSeekResponse: t[1],
          timestamp: addMins(
            startAt,
            Math.round((i + 1) * (durationMins / (nTurns + 1))),
          ),
        }));
        const doc = {
          _id: sessId,
          learnerId: p.user._id,
          orgId: p.org,
          teacherId: p.teacher,
          sessionMode: mode.toUpperCase(),
          esolLevel: p.level,
          topic: S.topic,
          turns,
          safeguardingFlagged: false,
          assessmentSummary:
            finalScore >= 0.65
              ? `Confident ${S.topic.toLowerCase()} practice. Clear turn taking and good use of ${vocabUsed[0]} and ${vocabUsed[1]}.`
              : `Worked through ${S.topic.toLowerCase()} with support. Needs more practice with ${vocabUsed[0]} before the next attempt.`,
          vocabIntroduced: vocabUsed,
          completedAt: endAt,
          session_source: "ai_tutor",
          duration_mins: durationMins,
          skill_codes_covered: S.skills,
          scenario_id: S.id,
          final_score: finalScore,
          passed: finalScore >= 0.65,
          turn_scores: turnScores,
          teaching_mode_sequence: turns.map(() => mode),
          stage3_objective_ids: objIds,
          esol_aim_type_at_start: "regulated",
          esol_aim_type: "regulated",
          nqf_level_at_start: p.level,
          start_time: startAt,
          end_time: endAt,
          beat: "complete",
          micro_stage_index: 3,
          micro_stages_completed: [true, true, true, true],
          createdAt: startAt,
          updatedAt: endAt,
        };
        sessionsByLearner[key].push({
          id: sessId,
          when: endAt,
          score: finalScore,
          scen,
          doc,
        });
        n++;

        auditRows.push({
          timestamp: startAt,
          actor_type: "learner",
          actor_id: p.user._id,
          org_id: p.org,
          learner_id: p.user._id,
          action: "session_started",
          before_state: null,
          after_state: { topic: S.topic, scenario_id: S.id, mode },
          reason: "Learner started a new AI tutor session",
          compliance_config_version: 1,
        });
        auditRows.push({
          timestamp: endAt,
          actor_type: "learner",
          actor_id: p.user._id,
          org_id: p.org,
          learner_id: p.user._id,
          action: "session_completed",
          before_state: null,
          after_state: {
            topic: S.topic,
            final_score: finalScore,
            passed: finalScore >= 0.65,
            duration_mins: durationMins,
          },
          reason: "Session ended by learner",
          compliance_config_version: 1,
        });

        // Evidence chain (2 turns max per session + completion rows)
        const humanConfirmed = endAt < D(8, 1); // July evidence already signed off
        for (let ti = 0; ti < Math.min(2, nTurns); ti++) {
          const points: Array<[string, unknown]> = [
            ["turn_score", turnScores[ti]],
            ["skill_codes", S.skills],
            ["vocabulary_items_used", vocabUsed.slice(0, 2)],
            ["teaching_mode_and_transitions", mode],
            ["recast_uptake", ti === 0],
          ];
          for (const [dp, value] of points) {
            const m = mapFor("beat_2_roleplay", dp);
            evidenceRows.push({
              learnerId: p.user._id,
              orgId: p.org,
              sessionId: sessId,
              beat: "beat_2_roleplay",
              data_point: dp,
              ilr_fields: m.ilr_fields,
              rarpa_stage: m.rarpa_stage,
              human_confirm: m.human_confirm,
              human_confirmed: m.human_confirm ? humanConfirmed : false,
              human_confirmed_by:
                m.human_confirm && humanConfirmed ? p.teacher : null,
              human_confirmed_at:
                m.human_confirm && humanConfirmed
                  ? addMins(endAt, 60 * 24 * 2)
                  : null,
              value,
              turnIndex: ti,
              mapping_version: mappingVersion,
              captured_at: addMins(startAt, 2 + ti * 3),
              createdAt: addMins(startAt, 2 + ti * 3),
            });
          }
        }
        for (const [dp, value] of [
          ["session_complete", true],
          ["session_summary", doc.assessmentSummary],
        ] as Array<[string, unknown]>) {
          const m = mapFor("beat_3_complete", dp);
          evidenceRows.push({
            learnerId: p.user._id,
            orgId: p.org,
            sessionId: sessId,
            beat: "beat_3_complete",
            data_point: dp,
            ilr_fields: m.ilr_fields,
            rarpa_stage: m.rarpa_stage,
            human_confirm: m.human_confirm,
            human_confirmed: false,
            value,
            turnIndex: null,
            mapping_version: mappingVersion,
            captured_at: endAt,
            createdAt: endAt,
          });
        }

        // Vocab aggregation
        for (const word of vocabUsed) {
          const cur = vocabAgg[key].get(word);
          if (cur) {
            cur.count += 1;
            cur.hiScore = Math.max(cur.hiScore, finalScore);
            cur.last = endAt;
          } else {
            vocabAgg[key].set(word, {
              count: 1,
              hiScore: finalScore,
              first: startAt,
              last: endAt,
              scen,
              level: p.level,
              org: p.org,
              sess: sessId,
            });
          }
        }
      }
    }
    console.log(`   ${key}: ${sessionsByLearner[key].length} sessions`);
  }

  const allSessionDocs = Object.values(sessionsByLearner).flatMap((arr) =>
    arr.map((s) => s.doc),
  );
  await AISession.insertMany(allSessionDocs);

  /* pre-platform imported hours (claimable GLH) */
  console.log("   Imported (pre platform) hours…");
  const imported: Array<[typeof lara, Types.ObjectId, number, Date]> = [
    [lara, seedOrg._id, 360, D(7, 2, 9, 0)],
    [collins, seedOrg._id, 300, D(7, 2, 9, 20)],
    [amina, hillview._id, 480, D(7, 3, 9, 0)],
    [wei, hillview._id, 240, D(7, 3, 9, 30)],
  ];
  for (const [u, org, mins, when] of imported) {
    await AISession.create({
      learnerId: u._id,
      orgId: org,
      teacherId: null,
      sessionMode: "BRIDGE",
      esolLevel: (await User.findById(u._id))!.esolLevel,
      topic: "Imported classroom hours (pre platform)",
      turns: [],
      completedAt: when,
      session_source: "pre_platform",
      duration_mins: mins,
      scenario_id: null,
      final_score: null,
      passed: null,
      start_time: when,
      end_time: when,
      createdAt: when,
      updatedAt: when,
    } as never);
    auditRows.push({
      timestamp: when,
      actor_type: "org_admin",
      actor_id: org.equals(seedOrg._id) ? orla._id : hana._id,
      org_id: org,
      learner_id: u._id,
      action: "historical_session_imported",
      before_state: null,
      after_state: { minutes: mins, source: "provider_register" },
      reason: `Imported ${Math.round(mins / 60)} hours of pre platform classroom delivery from the provider register`,
      compliance_config_version: 1,
    });
  }

  /* ══ 7. VOCAB LEDGER ══ */
  console.log("7) Vocab ledger…");
  const DEFS: Record<string, string> = {
    appointment: "a time you agree to meet someone, for example a doctor",
    receptionist: "the person at the front desk who books appointments",
    symptoms: "the signs of an illness, like pain or a cough",
    prescription: "the paper or code the doctor gives you for medicine",
    surgery: "the building where GPs work",
    urgent: "very important, cannot wait",
    temperature: "how hot your body is",
    pharmacy: "the shop where you collect medicine",
    payslip: "the document that shows your pay each month",
    "gross pay": "your pay before anything is taken away",
    "net pay": "the money that actually reaches your bank",
    deduction: "money taken from your pay, like tax",
    "tax code": "the code that tells your employer how much tax to take",
    "National Insurance":
      "money paid to the government for benefits and pensions",
    overtime: "extra hours you work beyond your contract",
    pension: "money saved for when you stop working",
    tenancy: "your legal agreement to rent a home",
    landlord: "the person you rent your home from",
    repairs: "work to fix something broken",
    deposit: "money you pay at the start of renting, returned at the end",
    boiler: "the machine that heats your water and home",
    damp: "unwanted moisture in walls or ceilings",
    notice: "a formal warning that something will change",
    inspection: "an official check of the property",
    salary: "the fixed pay you receive for your job",
    negotiation: "a discussion to reach an agreement",
    appraisal: "a meeting to review how well you work",
    benefits: "extras from your employer, like holidays or a pension",
    promotion: "moving up to a more senior job",
    probation: "the trial period at the start of a job",
    contract: "the legal agreement about your job",
    review: "a check of progress after some time",
  };
  const vocabOps: Array<Record<string, unknown>> = [];
  for (const [key, p] of Object.entries(plans)) {
    for (const [word, v] of vocabAgg[key].entries()) {
      const retained = v.count >= 5 && v.hiScore >= 0.7;
      vocabOps.push({
        updateOne: {
          filter: { learnerId: p.user._id, word },
          update: {
            $setOnInsert: {
              learnerId: p.user._id,
              orgId: v.org,
              sessionId: v.sess,
              word,
              definition: DEFS[word] ?? "",
              definition_en: DEFS[word] ?? "",
              contextSentence: null,
              esolLevel: v.level,
              topic: SCENARIOS[v.scen].topic,
              introducedAt: v.first,
              scenario_first_seen: SCENARIOS[v.scen].id,
              stage3_objective_id: null,
              createdAt: v.first,
            },
            $max: {
              last_seen_at: v.last,
              masteryScore: round2(Math.min(0.95, v.hiScore)),
              retained,
            },
            $inc: { times_encountered: v.count },
          },
          upsert: true,
        },
      });
    }
  }
  await VocabLedger.bulkWrite(vocabOps as never);

  /* ══ 8. EVIDENCE ══ */
  console.log(`8) Evidence records (${evidenceRows.length})…`);
  await EvidenceRecord.insertMany(evidenceRows, { ordered: false }).catch(
    (e) => {
      console.log("   (some duplicates skipped)", e?.writeErrors?.length ?? "");
    },
  );

  /* ══ 9. TEACHER REVIEWS + MESSAGES ══ */
  console.log("9) Teacher reviews and messages…");
  type Rev = {
    learner: Types.ObjectId;
    teacher: Types.ObjectId;
    org: Types.ObjectId;
    type: string;
    mins: number;
    note: string;
    when: Date;
    acted?: boolean;
  };
  const reviews: Rev[] = [
    // Theo — Seed QA
    {
      learner: lara._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "async_review",
      mins: 15,
      when: D(7, 8, 15, 30),
      note: "Read the last three GP and payslip transcripts. Vocabulary range growing; recommended she tries the housing scenario next.",
      acted: true,
    },
    {
      learner: lara._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "contact_session",
      mins: 30,
      when: D(7, 22, 14, 0),
      note: "Video call. Worked on polite disagreement and follow up questions. Very strong session; ready for immersion mode more often.",
      acted: true,
    },
    {
      learner: lara._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "async_review",
      mins: 15,
      when: D(8, 5, 16, 10),
      note: "August check. Consistent scores above 0.75. Flagged for Stage 5 preparation at current pace.",
      acted: false,
    },
    {
      learner: stephen._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "contact_session",
      mins: 45,
      when: D(7, 10, 11, 0),
      note: "Long contact session focused on confidence. Kept sessions in anchor mode deliberately; agreed shorter, more frequent practice.",
      acted: true,
    },
    {
      learner: stephen._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "pathway_adjustment",
      mins: 10,
      when: D(7, 24, 9, 30),
      note: "Narrowed pathway to GP and payslip scenarios only until scores stabilise above 0.5.",
      acted: true,
    },
    {
      learner: stephen._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "contact_session",
      mins: 30,
      when: D(8, 12, 11, 0),
      note: "Contact session. Scores still uneven. Agreed to keep anchor mode and revisit in two weeks.",
      acted: true,
    },
    {
      learner: collins._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "async_review",
      mins: 15,
      when: D(7, 16, 17, 0),
      note: "Entry 1 progress steady. GP scenario repeated four times with slow improvement; suggested learning the vocabulary list before each session.",
      acted: false,
    },
    {
      learner: collins._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "contact_session",
      mins: 25,
      when: D(8, 4, 17, 30),
      note: "Phone contact. Motivation dipping; agreed a lighter schedule for two weeks and a follow up call.",
      acted: true,
    },
    {
      learner: emre._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "async_review",
      mins: 15,
      when: D(7, 21, 15, 0),
      note: "First week review after placement. Fast starter; payslip scenario scores already at 0.6.",
      acted: false,
    },
    {
      learner: emre._id,
      teacher: theo._id,
      org: seedOrg._id,
      type: "async_review",
      mins: 15,
      when: D(8, 11, 15, 0),
      note: "Improving steadily, 0.7 plus in the last week. On track for Entry 3 consideration by October.",
      acted: false,
    },
    // Priya — Hillview
    {
      learner: amina._id,
      teacher: priya._id,
      org: hillview._id,
      type: "contact_session",
      mins: 40,
      when: D(7, 9, 13, 0),
      note: "First contact session. Scores hovering below 0.5; agreed to focus on listening comprehension and slower scenarios.",
      acted: true,
    },
    {
      learner: amina._id,
      teacher: priya._id,
      org: hillview._id,
      type: "async_review",
      mins: 15,
      when: D(7, 30, 10, 30),
      note: "Reviewed July sessions. Still steady low; will pair GP scenario with vocabulary pre teaching.",
      acted: true,
    },
    {
      learner: amina._id,
      teacher: priya._id,
      org: hillview._id,
      type: "contact_session",
      mins: 35,
      when: D(8, 13, 13, 30),
      note: "Contact session on payslip vocabulary. Better engagement after the July safeguarding follow up; support worker confirmed attendance.",
      acted: true,
    },
    {
      learner: wei._id,
      teacher: priya._id,
      org: hillview._id,
      type: "async_review",
      mins: 15,
      when: D(7, 7, 9, 0),
      note: "Level 1 objectives all evidenced. Recommending Stage 5 review; scores consistently above 0.8.",
      acted: true,
    },
    {
      learner: wei._id,
      teacher: priya._id,
      org: hillview._id,
      type: "rarpa_signoff",
      mins: 20,
      when: D(7, 10, 9, 30),
      note: "Stage 5 sign off for Level 1 completion. Self assessment and AI summary consistent with my own review of the transcripts.",
      acted: true,
    },
    {
      learner: wei._id,
      teacher: priya._id,
      org: hillview._id,
      type: "async_review",
      mins: 15,
      when: D(8, 10, 9, 0),
      note: "First month at Level 2. Pay rise negotiation scenario handled impressively; keep immersion mode.",
      acted: false,
    },
  ];

  type Msg = {
    learner: Types.ObjectId;
    teacher: Types.ObjectId;
    org: Types.ObjectId;
    text: string;
    original?: string | null;
    lang: string;
    sent: Date;
    read: Date | null;
    trigger: string;
  };
  const messages: Msg[] = [
    {
      learner: lara._id,
      teacher: theo._id,
      org: seedOrg._id,
      lang: "en",
      sent: D(7, 22, 14, 40),
      read: D(7, 22, 18, 2),
      trigger: "manual",
      text: "Great session today, Lara. Try the housing scenario next — you are more than ready for it.",
    },
    {
      learner: stephen._id,
      teacher: theo._id,
      org: seedOrg._id,
      lang: "fr",
      sent: D(7, 10, 12, 0),
      read: D(7, 10, 19, 30),
      trigger: "manual",
      original:
        "Good effort this week, Stephen. Short sessions, often — that is the plan. I am here if you need me.",
      text: "Bon travail cette semaine, Stephen. Des sessions courtes, souvent, c'est le plan. Je suis la si tu as besoin de moi.",
    },
    {
      learner: stephen._id,
      teacher: theo._id,
      org: seedOrg._id,
      lang: "fr",
      sent: D(8, 12, 11, 40),
      read: null,
      trigger: "manual",
      original:
        "Well done for keeping going. Same plan for two more weeks, then we talk again.",
      text: "Bravo d'avoir continue. Meme plan pendant deux semaines encore, puis on se reparle.",
    },
    {
      learner: collins._id,
      teacher: theo._id,
      org: seedOrg._id,
      lang: "fr",
      sent: D(7, 16, 17, 20),
      read: D(7, 17, 8, 5),
      trigger: "manual",
      original:
        "Nice progress on the GP scenario. Learn the word list before your next session and it will feel easier.",
      text: "Beaux progres sur le scenario du medecin. Apprends la liste de mots avant ta prochaine session et ce sera plus facile.",
    },
    {
      learner: collins._id,
      teacher: theo._id,
      org: seedOrg._id,
      lang: "fr",
      sent: D(8, 13, 9, 0),
      read: null,
      trigger: "re_engagement_cron",
      original:
        "Just checking in — we have not seen you for a few days. Even ten minutes of practice keeps things moving.",
      text: "Je prends des nouvelles — on ne t'a pas vu depuis quelques jours. Meme dix minutes de pratique font la difference.",
    },
    {
      learner: emre._id,
      teacher: theo._id,
      org: seedOrg._id,
      lang: "tr",
      sent: D(7, 21, 15, 30),
      read: D(7, 21, 20, 15),
      trigger: "manual",
      original:
        "Welcome aboard, Emre. Strong first week — the payslip scenario suits you.",
      text: "Aramiza hos geldin Emre. Ilk haftan cok iyiydi — maas bordrosu senaryosu sana cok uygun.",
    },
    {
      learner: amina._id,
      teacher: priya._id,
      org: hillview._id,
      lang: "ar",
      sent: D(7, 9, 14, 0),
      read: D(7, 9, 21, 45),
      trigger: "manual",
      original:
        "Thank you for our session today, Amina. We will take it step by step together.",
      text: "شكرا لك على جلستنا اليوم يا أمينة. سنمضي خطوة بخطوة معا.",
    },
    {
      learner: amina._id,
      teacher: priya._id,
      org: hillview._id,
      lang: "ar",
      sent: D(8, 16, 10, 0),
      read: null,
      trigger: "manual",
      original:
        "Lovely progress this month. Keep practising the payslip words before Friday.",
      text: "تقدم جميل هذا الشهر. واصلي التدرب على كلمات قسيمة الراتب قبل يوم الجمعة.",
    },
    {
      learner: wei._id,
      teacher: priya._id,
      org: hillview._id,
      lang: "en",
      sent: D(7, 12, 10, 0),
      read: D(7, 12, 12, 30),
      trigger: "manual",
      text: "Congratulations on completing Level 1, Wei! Your Level 2 pathway starts with the negotiation scenario.",
    },
  ];

  const glhInc = new Map<string, number>();
  const lastReviewed = new Map<string, Date>();
  const bump = (id: Types.ObjectId, h: number, when: Date) => {
    const k = id.toString();
    glhInc.set(k, (glhInc.get(k) ?? 0) + h);
    const cur = lastReviewed.get(k);
    if (!cur || when > cur) lastReviewed.set(k, when);
  };

  for (const r of reviews) {
    await TeacherReview.create({
      learner_id: r.learner,
      teacher_id: r.teacher,
      org_id: r.org,
      review_type: r.type,
      duration_mins: r.mins,
      notes: r.note,
      ai_recommendation_acted_on: r.acted ?? false,
      created_at: r.when,
    } as never);
    bump(r.learner, glhFor(r.type, r.mins), r.when);
    auditRows.push({
      timestamp: r.when,
      actor_type: "teacher",
      actor_id: r.teacher,
      org_id: r.org,
      learner_id: r.learner,
      action: "teacher_review_logged",
      before_state: null,
      after_state: { review_type: r.type, duration_mins: r.mins },
      reason: `Teacher logged a ${r.type.replace(/_/g, " ")} review`,
      compliance_config_version: 1,
    });
  }
  for (const m of messages) {
    await TeacherMessage.create({
      teacher_id: m.teacher,
      learner_id: m.learner,
      org_id: m.org,
      message_text: m.text,
      original_text: m.original ?? null,
      language: m.lang,
      sent_at: m.sent,
      read_at: m.read,
      trigger: m.trigger,
    } as never);
    if (m.trigger === "manual") {
      // The live send endpoint also logs a 5 minute contact review.
      await TeacherReview.create({
        learner_id: m.learner,
        teacher_id: m.teacher,
        org_id: m.org,
        review_type: "contact_session",
        duration_mins: 5,
        notes: "Written message to learner (auto logged contact).",
        ai_recommendation_acted_on: false,
        created_at: m.sent,
      } as never);
      bump(m.learner, 5 / 60, m.sent);
    }
    auditRows.push({
      timestamp: m.sent,
      actor_type: "teacher",
      actor_id: m.teacher,
      org_id: m.org,
      learner_id: m.learner,
      action: "teacher_message_sent",
      before_state: null,
      after_state: { language: m.lang, trigger: m.trigger },
      reason:
        m.trigger === "re_engagement_cron"
          ? "Automatic re engagement message sent on the teacher's behalf"
          : "Teacher sent a message to the learner",
      compliance_config_version: 1,
    });
  }
  for (const [id, hours] of glhInc.entries()) {
    await User.updateOne(
      { _id: id },
      {
        $inc: { glh_teacher_contact: round2(hours) },
        $set: { teacher_last_reviewed_at: lastReviewed.get(id) },
      },
    );
  }

  /* ══ 10. STAGE 5 — completed review for Wei (l1 → l2, July) ══ */
  console.log("10) Completed Stage 5 for Wei…");
  await Stage5Review.create({
    learner_id: wei._id,
    org_id: hillview._id,
    level_completed: "l1",
    stage3_objectives: objWei,
    learner_self_assessment: {
      confidence_rating: "high",
      objective_ratings: Object.fromEntries(
        (objWei as Array<{ id: string }>).map((o) => [o.id, "confident"]),
      ),
      submitted_at: D(7, 9, 19, 30).toISOString(),
    },
    ai_tutor_summary: {
      summary:
        "Wei completed every Level 1 objective with consistent scores above 0.8. Conversation is fluent and accurate across work and everyday scenarios, with confident recovery when misunderstood.",
      key_achievements: [
        "Sustained scores above 0.8 across the final month of Level 1",
        "Handled the payslip scenario end to end without first language support",
        "Self corrected tense errors without prompting in later sessions",
      ],
      readiness_for_next_level: "high",
      generated_at: D(7, 9, 19, 40).toISOString(),
      model: "gemini-2.5-flash",
      input_tokens: 2210,
      output_tokens: 305,
    },
    teacher_id: priya._id,
    teacher_signed_off_at: D(7, 10, 9, 30),
    org_admin_confirmed_at: D(7, 12, 11, 0),
    org_admin_confirmed_by: hana._id,
    org_admin_advance_to_level: "l2",
    next_steps:
      "Progress to the Level 2 pathway with a workplace communication focus. Review again at the end of August.",
    createdAt: D(7, 8, 8, 0),
  } as never);
  auditRows.push({
    timestamp: D(7, 8, 8, 0),
    actor_type: "system",
    actor_id: null,
    org_id: hillview._id,
    learner_id: wei._id,
    action: "stage5_review_generated",
    before_state: null,
    after_state: { level_completed: "l1" },
    reason:
      "Stage 5 review opened automatically after Level 1 completion threshold met",
    compliance_config_version: 1,
  });
  auditRows.push({
    timestamp: D(7, 12, 11, 0),
    actor_type: "org_admin",
    actor_id: hana._id,
    org_id: hillview._id,
    learner_id: wei._id,
    action: "level_change_confirmed",
    before_state: { esolLevel: "l1" },
    after_state: { esolLevel: "l2" },
    reason:
      "Org admin confirmed Level 1 achievement and advanced learner to Level 2 (two person rule complete)",
    compliance_config_version: 1,
  });

  /* ══ 11. SAFEGUARDING — resolved July alert for Amina ══ */
  console.log("11) Resolved safeguarding alert (July)…");
  const sgSession = await AISession.create({
    learnerId: amina._id,
    orgId: hillview._id,
    teacherId: priya._id,
    sessionMode: "ANCHOR",
    esolLevel: "e2",
    topic: "Booking a GP appointment",
    scenario_id: "s1_gp_appointment",
    session_source: "ai_tutor",
    safeguardingFlagged: true,
    turns: [],
    completedAt: null,
    start_time: D(7, 18, 9, 35),
    createdAt: D(7, 18, 9, 35),
  } as never);
  await SafeguardingAlert.create({
    learnerId: amina._id,
    orgId: hillview._id,
    sessionId: sgSession._id,
    alertLevel: "medium",
    messageContentHash: sha("jul-demo-disclosure-amina"),
    triggerCategory: "mental_health_crisis",
    triggerSource: "keyword",
    status: "resolved",
    reviewedBy: amberAdmin._id,
    reviewedAt: D(7, 18, 10, 5),
    resolvedAt: D(7, 18, 16, 30),
    resolvedBy: amberAdmin._id,
    resolutionNotes:
      "Escalated to the Hillview safeguarding officer the same morning. Learner contacted by their support worker and ongoing support confirmed. Closed after written confirmation from the organisation.",
    notificationSentAt: D(7, 18, 9, 36),
    createdAt: D(7, 18, 9, 36),
  } as never);
  auditRows.push({
    timestamp: D(7, 18, 9, 36),
    actor_type: "system",
    actor_id: null,
    org_id: hillview._id,
    learner_id: amina._id,
    action: "safeguarding_alert_raised",
    before_state: null,
    after_state: { alertLevel: "medium", category: "mental_health_crisis" },
    reason: "Safeguarding keyword detected during AI session; DSL notified",
    compliance_config_version: 1,
  });
  // Audit row for Stephen's existing open alert (raised 19 Aug by prep fixture)
  auditRows.push({
    timestamp: D(8, 19, 9, 0),
    actor_type: "system",
    actor_id: null,
    org_id: seedOrg._id,
    learner_id: stephen._id,
    action: "safeguarding_alert_raised",
    before_state: null,
    after_state: { alertLevel: "high", category: "domestic_abuse" },
    reason: "Safeguarding keyword detected during AI session; DSL notified",
    compliance_config_version: 1,
  });

  /* ══ 12. INVOICES ══ */
  console.log("12) Invoices…");
  const inv = async (
    n: number,
    org: Types.ObjectId,
    m: number,
    learners: number,
    fee: number,
    status: string,
    issued: Date,
    paid: Date | null,
  ) => {
    const sub = learners * fee;
    const vat = round2(sub * 0.2);
    await OrgInvoice.create({
      orgId: org,
      invoiceNumber: `INV-2026-${String(n).padStart(4, "0")}`,
      periodStart: D(m, 1, 0, 0),
      periodEnd: new Date(Date.UTC(2026, m, 0, 23, 59, 59)),
      lineItems: [
        {
          description: `Monthly platform fee — ${learners} enrolled learners`,
          quantity: learners,
          unitPrice: fee,
          amount: sub,
          bookingIds: [],
        },
      ],
      subtotal: sub,
      vatAmount: vat,
      vatRate: 0.2,
      totalAmount: round2(sub + vat),
      currency: "GBP",
      status,
      issuedAt: issued,
      dueAt: addMins(issued, 60 * 24 * 30),
      paidAt: paid,
      notes: null,
      createdAt: issued,
    } as never);
  };
  await inv(1, burnex._id, 5, 2, 15, "overdue", D(6, 1, 9, 0), null);
  await inv(2, seedOrg._id, 6, 3, 12, "paid", D(7, 1, 9, 0), D(7, 9, 14, 20));
  await inv(3, hillview._id, 6, 3, 10, "paid", D(7, 1, 9, 5), D(7, 15, 10, 0));
  await inv(4, seedOrg._id, 7, 4, 12, "paid", D(8, 1, 9, 0), D(8, 11, 16, 40));
  await inv(5, hillview._id, 7, 3, 10, "issued", D(8, 1, 9, 5), null);

  /* ══ 13. ROI SUBMISSIONS (sales intelligence) ══ */
  console.log("13) ROI calculator submissions…");
  const Roi = mongoose.connection.collection("roicalculatorsubmissions");
  await Roi.insertMany([
    {
      waiting_list_size: 140,
      avg_asf_rate: 780,
      org_name: "Thamesview College",
      org_type: "college",
      current_throughput_per_year: 220,
      contact_email: "esol@thamesview.ac.uk",
      contact_name: "Marcus Bell",
      unclaimed_income_annual: 109200,
      payback_weeks: 5,
      ip_address_hash: sha("thamesview"),
      user_agent: "Mozilla/5.0",
      submitted_at: D(7, 6, 11, 24),
      contacted_at: D(7, 8, 10, 0),
      contacted_by: amberAdmin._id,
    },
    {
      waiting_list_size: 60,
      avg_asf_rate: 724,
      org_name: "Beacon Learning Trust",
      org_type: "charity",
      current_throughput_per_year: 85,
      contact_email: "programmes@beaconlearning.org.uk",
      contact_name: "Sofia Reyes",
      unclaimed_income_annual: 43440,
      payback_weeks: 8,
      ip_address_hash: sha("beacon"),
      user_agent: "Mozilla/5.0",
      submitted_at: D(7, 29, 15, 47),
      contacted_at: null,
      contacted_by: null,
    },
    {
      waiting_list_size: 210,
      avg_asf_rate: 810,
      org_name: "Northgate Council",
      org_type: "council",
      current_throughput_per_year: 310,
      contact_email: "adult.learning@northgate.gov.uk",
      contact_name: "Priti Anand",
      unclaimed_income_annual: 170100,
      payback_weeks: 4,
      ip_address_hash: sha("northgate"),
      user_agent: "Mozilla/5.0",
      submitted_at: D(8, 14, 9, 12),
      contacted_at: null,
      contacted_by: null,
    },
  ]);

  /* ══ 14. NOTIFICATIONS (the bell) ══ */
  console.log("14) Notifications…");
  await Notification.insertMany([
    {
      userId: orla._id,
      type: "stage5_review_initiated",
      title: "Stage 5 review pending",
      message:
        "Lara Learner has completed Entry 3 and her Stage 5 review is awaiting your confirmation.",
      data: {},
      read: false,
      createdAt: D(8, 18, 14, 5),
    },
    {
      userId: orla._id,
      type: "system",
      title: "Learner needs funding review",
      message:
        "Emre Kaya registered with a postcode outside the ASF dataset and needs a funding eligibility check.",
      data: {},
      read: true,
      createdAt: D(7, 14, 10, 6),
    },
    {
      userId: hana._id,
      type: "progression_ready",
      title: "Learner ready for level review",
      message:
        "Wei Chen meets all progression criteria for Level 1 completion.",
      data: {},
      read: true,
      createdAt: D(7, 8, 6, 5),
    },
    {
      userId: hana._id,
      type: "stage5_review_initiated",
      title: "Stage 5 review pending",
      message:
        "Wei Chen's Stage 5 review for Level 1 is awaiting confirmation.",
      data: {},
      read: true,
      createdAt: D(7, 9, 20, 0),
    },
    {
      userId: wei._id,
      type: "progression_confirmed",
      title: "Level 1 complete — congratulations!",
      message: "Your Stage 5 review is confirmed. Welcome to Level 2.",
      data: {},
      read: true,
      createdAt: D(7, 12, 11, 1),
    },
    {
      userId: theo._id,
      type: "system",
      title: "New learner assigned",
      message:
        "Emre Kaya (Entry 2, Turkish) has been auto assigned to you — best match on level and language.",
      data: {},
      read: true,
      createdAt: D(7, 14, 10, 6),
    },
    {
      userId: theo._id,
      type: "system",
      title: "Safeguarding alert in your cohort",
      message:
        "A safeguarding alert was raised for a learner in your cohort. The DSL has been notified.",
      data: {},
      read: false,
      createdAt: D(8, 19, 9, 1),
    },
    {
      userId: priya._id,
      type: "system",
      title: "New learner assigned",
      message:
        "Nadia Osman has been assigned to you and is awaiting her placement assessment.",
      data: {},
      read: false,
      createdAt: D(8, 18, 22, 45),
    },
  ] as never);

  /* ══ 15. REMAINING AUDIT ROWS (registration, placement, goals, nudges, priority, cohort) ══ */
  console.log("15) Audit rows…");
  auditRows.push(
    {
      timestamp: D(7, 14, 10, 5),
      actor_type: "learner",
      actor_id: emre._id,
      org_id: seedOrg._id,
      learner_id: emre._id,
      action: "learner_registered",
      before_state: null,
      after_state: { source: "referral_link", l1_language: "Turkish" },
      reason:
        "Learner completed registration through an organisation referral link",
      compliance_config_version: 1,
    },
    {
      timestamp: D(7, 14, 10, 48),
      actor_type: "system",
      actor_id: null,
      org_id: seedOrg._id,
      learner_id: emre._id,
      action: "placement_completed",
      before_state: null,
      after_state: { nqf_level: "e2", placement_confidence: 0.84 },
      reason: "Placement assessment scored by Gemini",
      compliance_config_version: 1,
    },
    {
      timestamp: D(7, 14, 10, 50),
      actor_type: "org_admin",
      actor_id: orla._id,
      org_id: seedOrg._id,
      learner_id: emre._id,
      action: "learner_teacher_assigned",
      before_state: null,
      after_state: { teacher: "Theo Teacher" },
      reason: "Auto-assigned (best match): Teaches Entry 2; Speaks Turkish",
      compliance_config_version: 1,
    },
    {
      timestamp: D(7, 14, 11, 30),
      actor_type: "system",
      actor_id: null,
      org_id: seedOrg._id,
      learner_id: emre._id,
      action: "rarpa_stage3_negotiated",
      before_state: null,
      after_state: { objective_count: 3 },
      reason:
        "Stage 3 objectives presented to the learner in their first language for negotiation and agreement (RARPA Stage 3 evidence)",
      compliance_config_version: 1,
    },
    {
      timestamp: D(7, 14, 11, 34),
      actor_type: "learner",
      actor_id: emre._id,
      org_id: seedOrg._id,
      learner_id: emre._id,
      action: "rarpa_stage3_negotiated",
      before_state: null,
      after_state: { agreed: true, source: "learner_confirmation" },
      reason:
        "Learner reviewed and agreed their Stage 3 objectives in their first language (RARPA Stage 3 negotiation)",
      compliance_config_version: 1,
    },
    {
      timestamp: D(7, 14, 10, 52),
      actor_type: "org_admin",
      actor_id: orla._id,
      org_id: seedOrg._id,
      learner_id: emre._id,
      action: "uln_recorded",
      before_state: null,
      after_state: { uln: "4152098637" },
      reason: "ULN recorded from provider records",
      compliance_config_version: 1,
    },
    {
      timestamp: D(8, 18, 22, 40),
      actor_type: "learner",
      actor_id: nadia._id,
      org_id: hillview._id,
      learner_id: nadia._id,
      action: "learner_registered",
      before_state: null,
      after_state: { source: "referral_link", l1_language: "Somali" },
      reason:
        "Learner completed registration through an organisation referral link",
      compliance_config_version: 1,
    },
    {
      timestamp: D(8, 18, 22, 45),
      actor_type: "org_admin",
      actor_id: hana._id,
      org_id: hillview._id,
      learner_id: nadia._id,
      action: "learner_teacher_assigned",
      before_state: null,
      after_state: { teacher: "Priya Sharma" },
      reason: "Auto-assigned (best match): Speaks Somali",
      compliance_config_version: 1,
    },
    {
      timestamp: D(8, 12, 10, 30),
      actor_type: "org_admin",
      actor_id: orla._id,
      org_id: seedOrg._id,
      learner_id: collins._id,
      action: "learner_nudge_sent",
      before_state: null,
      after_state: { email_sent: true },
      reason: "Org admin sent nudge email",
      compliance_config_version: 1,
    },
    {
      timestamp: D(7, 28, 11, 15),
      actor_type: "org_admin",
      actor_id: hana._id,
      org_id: hillview._id,
      learner_id: amina._id,
      action: "learner_nudge_sent",
      before_state: null,
      after_state: { email_sent: true },
      reason: "Org admin sent nudge email",
      compliance_config_version: 1,
    },
    {
      timestamp: D(8, 17, 6, 2),
      actor_type: "system",
      actor_id: null,
      org_id: seedOrg._id,
      learner_id: collins._id,
      action: "learner_priority_changed",
      before_state: { teacher_priority_level: "p4" },
      after_state: {
        teacher_priority_level: "p2",
        trigger_key: "inactive_7_13_days",
      },
      reason: "Daily priority sweep: learner inactive for a week",
      compliance_config_version: 1,
    },
    {
      timestamp: D(8, 19, 9, 2),
      actor_type: "system",
      actor_id: null,
      org_id: seedOrg._id,
      learner_id: stephen._id,
      action: "learner_priority_changed",
      before_state: { teacher_priority_level: "p2" },
      after_state: {
        teacher_priority_level: "p1",
        trigger_key: "safeguarding_alert_unresolved",
      },
      reason: "Open safeguarding alert takes priority over all other triggers",
      compliance_config_version: 1,
    },
    {
      timestamp: D(8, 15, 6, 1),
      actor_type: "system",
      actor_id: null,
      org_id: seedOrg._id,
      learner_id: collins._id,
      action: "cohort_status_changed",
      before_state: { cohort_status: "active" },
      after_state: { cohort_status: "inactive_mild" },
      reason: "No completed session for 5 days",
      compliance_config_version: 1,
    },
  );
  // Goals agreed rows for the learners whose objectives were written above.
  for (const [u, org, when] of [
    [stephen, seedOrg._id, D(6, 11, 10, 30)],
    [collins, seedOrg._id, D(6, 11, 12, 30)],
    [amina, hillview._id, D(6, 9, 12, 30)],
    [wei, hillview._id, D(7, 12, 9, 45)],
  ] as Array<[typeof stephen, Types.ObjectId, Date]>) {
    auditRows.push({
      timestamp: when,
      actor_type: "learner",
      actor_id: u._id,
      org_id: org,
      learner_id: u._id,
      action: "rarpa_stage3_negotiated",
      before_state: null,
      after_state: { agreed: true, source: "learner_confirmation" },
      reason:
        "Learner reviewed and agreed their Stage 3 objectives in their first language (RARPA Stage 3 negotiation)",
      compliance_config_version: 1,
    });
  }
  await AuditLog.insertMany(auditRows);
  console.log(`   ${auditRows.length} audit rows written`);

  /* ══ 16. FINAL USER ROLLUPS (what the daily crons would compute) ══ */
  console.log(
    "16) User rollups: last_session_at, cohort_status, priority, activity totals…",
  );
  const ACTIONS: Record<string, string> = {
    safeguarding_alert_unresolved:
      "Safeguarding alert raised. Review and resolve within 24 hours.",
    inactive_7_13_days:
      "Learner inactive for a week. Send an encouragement message.",
    inactive_5_6_days:
      "Learner inactive for several days. Light-touch nudge recommended.",
    low_average_score:
      "Sustained low average score. Review last 5 sessions for patterns.",
    healthy_maintenance: "Learner on track. No action required this week.",
  };
  const recalcAt = D(8, 20, 6, 0);
  const rollup = async (
    u: { _id: Types.ObjectId },
    key: string | null,
    cohort: string,
    level: string,
    trigger: string,
  ) => {
    const sessions = key ? sessionsByLearner[key] : [];
    const latest = sessions.length
      ? sessions.reduce((a, b) => (a.when > b.when ? a : b)).when
      : null;
    const completed = sessions.length;
    const hours = key
      ? round2(
          sessions.reduce(
            (a, s) => a + ((s.doc.duration_mins as number) ?? 0),
            0,
          ) / 60,
        )
      : 0;
    await User.updateOne(
      { _id: u._id },
      {
        $set: {
          last_session_at: latest,
          cohort_status: cohort,
          teacher_priority_level: level,
          teacher_priority_trigger_key: trigger,
          teacher_recommended_action: ACTIONS[trigger],
          teacher_priority_updated_at: recalcAt,
          totalLessonsTaken: completed,
          totalHoursLearned: hours,
          currentStreak: cohort === "active" ? Math.floor(between(2, 6)) : 0,
          longestStreak: Math.floor(between(4, 9)),
        },
      },
    );
  };
  // Lara's real last completed session is the 18 Aug prep fixture — keep that date.
  await rollup(lara, "lara", "active", "p4", "healthy_maintenance");
  await User.updateOne(
    { _id: lara._id },
    { $set: { last_session_at: D(8, 18, 12, 31) } },
  );
  await rollup(
    stephen,
    "stephen",
    "active",
    "p1",
    "safeguarding_alert_unresolved",
  );
  await rollup(
    collins,
    "collins",
    "inactive_moderate",
    "p2",
    "inactive_7_13_days",
  );
  await rollup(emre, "emre", "active", "p4", "healthy_maintenance");
  await rollup(amina, "amina", "inactive_mild", "p3", "inactive_5_6_days");
  await rollup(wei, "wei", "active", "p4", "healthy_maintenance");
  await User.updateOne(
    { _id: nadia._id },
    { $set: { cohort_status: "new", teacher_priority_level: "p4" } },
  );

  /* ══ summary ══ */
  const totals = {
    sessions: allSessionDocs.length,
    evidence: evidenceRows.length,
    audit: auditRows.length,
    reviews:
      reviews.length + messages.filter((m) => m.trigger === "manual").length,
    messages: messages.length,
  };
  console.log("\n✓ Seed complete:", JSON.stringify(totals));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
