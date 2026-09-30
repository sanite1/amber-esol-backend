/**
 * Silk bug brief section 4 — opening a scenario resumes the learner's
 * in progress session instead of creating another one, and a refresh
 * rotates the refresh token so the sign in window slides.
 */
import { Types } from "mongoose";
import jwt from "jsonwebtoken";
import Organisation from "../models/Organisation";
import User from "../models/User";
import AISession from "../models/AISession";
import {
  startSessionService,
  RESUME_WINDOW_MS,
} from "../services/aiSession.service";
import { refreshService } from "../services/user.service";

const createOrg = () =>
  Organisation.create({
    name: "Resume Org",
    slug: `resume-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    contactEmail: "a@x.local",
    adminUserId: new Types.ObjectId(),
    billing_active: true,
    isActive: true,
  });

const createLearner = (orgId: unknown) =>
  User.create({
    firstname: "T",
    lastname: "L",
    email: `l-${Date.now()}-${Math.random().toString(16).slice(2)}@x.local`,
    password: "x",
    phoneNumber: "07000000000",
    role: "student",
    orgId,
    isActive: true,
    status: "active",
    verified: true,
    esolLevel: "e3",
    l1Language: "turkish",
  });

const turn = {
  turnIndex: 0,
  originalInput: "Hello",
  scrubbed: false,
  deepSeekResponse: "Merhaba! Hello.",
  claudeAssessment: "",
  safeguardingScore: 0,
  timestamp: new Date(),
};

const startInput = (learner: { _id: unknown }, org: { _id: unknown }) => ({
  scenarioId: "s1_gp_appointment",
  learnerId: String(learner._id),
  orgId: String(org._id),
});

describe("start session resumes an in progress session", () => {
  it("returns the live session with turns instead of creating a new one", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    const live = await AISession.create({
      learnerId: learner._id,
      orgId: org._id,
      sessionMode: "BRIDGE",
      esolLevel: "e3",
      turns: [turn],
      session_source: "ai_tutor",
      scenario_id: "s1_gp_appointment",
      completedAt: null,
    });
    const res = await startSessionService(startInput(learner, org));
    const data = res.data as {
      session_id: string;
      resumed: boolean;
      turn_count: number;
    };
    expect(data.resumed).toBe(true);
    expect(data.session_id).toBe(live._id.toString());
    expect(data.turn_count).toBe(1);
    expect(await AISession.countDocuments({ learnerId: learner._id })).toBe(1);
  });

  it("starts fresh when the only in progress session has no turns", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    await AISession.create({
      learnerId: learner._id,
      orgId: org._id,
      sessionMode: "BRIDGE",
      esolLevel: "e3",
      turns: [],
      session_source: "ai_tutor",
      scenario_id: "s1_gp_appointment",
      completedAt: null,
    });
    const res = await startSessionService(startInput(learner, org));
    expect((res.data as { resumed: boolean }).resumed).toBe(false);
  });

  it("starts fresh when the live session is older than the resume window", async () => {
    const org = await createOrg();
    const learner = await createLearner(org._id);
    const stale = await AISession.create({
      learnerId: learner._id,
      orgId: org._id,
      sessionMode: "BRIDGE",
      esolLevel: "e3",
      turns: [turn],
      session_source: "ai_tutor",
      scenario_id: "s1_gp_appointment",
      completedAt: null,
    });
    await AISession.collection.updateOne(
      { _id: stale._id },
      { $set: { updatedAt: new Date(Date.now() - RESUME_WINDOW_MS - 60_000) } },
    );
    const res = await startSessionService(startInput(learner, org));
    const data = res.data as { session_id: string; resumed: boolean };
    expect(data.resumed).toBe(false);
    expect(data.session_id).not.toBe(stale._id.toString());
  });
});

describe("refresh rotates the refresh token", () => {
  it("returns a new refresh token whose expiry is later than the old one", async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
    const org = await createOrg();
    const learner = await createLearner(org._id);
    const old = jwt.sign(
      { id: learner._id.toString() },
      process.env.JWT_SECRET,
      {
        expiresIn: "1d",
      },
    );
    const res = await refreshService({ token: old });
    const data = res.data as { accessToken: string; refreshToken: string };
    expect(typeof data.refreshToken).toBe("string");
    const oldExp = (jwt.decode(old) as { exp: number }).exp;
    const newExp = (jwt.decode(data.refreshToken) as { exp: number }).exp;
    expect(newExp).toBeGreaterThan(oldExp);
  });
});
