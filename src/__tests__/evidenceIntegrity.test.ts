/**
 * Silk bug brief section 1 — evidence and records integrity.
 *
 * Every displayed number must come from one source of truth and the
 * session summary must be fed the real outcome. Pure helpers plus
 * in-memory Mongo; no Gemini call.
 */
import { Types } from "mongoose";
import AISession from "../models/AISession";
import VocabLedger from "../models/VocabLedger";
import {
  buildSessionSummaryMessage,
  generateSessionSummary,
  shortSessionSummary,
  MIN_TURNS_FOR_MODEL_SUMMARY,
} from "../services/geminiAI.service";
import {
  getLearnerProgressService,
  MIN_TURNS_TO_PASS,
} from "../services/aiSession.service";
import { listAISessionsService } from "../services/esolAISession.service";
import {
  countLearnedWords,
  getLearnerVocabSummary,
} from "../services/vocabLedger.service";

const learnerId = new Types.ObjectId();
const orgId = new Types.ObjectId();
const teacherId = new Types.ObjectId();

const turn = (i: number) => ({
  turnIndex: i,
  originalInput: `learner line ${i}`,
  scrubbed: false,
  deepSeekResponse: `tutor line ${i}`,
  claudeAssessment: "",
  safeguardingScore: 0,
  timestamp: new Date(),
});

const makeSession = (over: Record<string, unknown>) =>
  AISession.create({
    learnerId,
    teacherId,
    orgId,
    sessionMode: "BRIDGE",
    esolLevel: "e3",
    topic: "Booking a GP appointment",
    turns: [],
    ...over,
  });

describe("session summary is fed the real outcome", () => {
  it("puts pass/fail, score, turn count and duration ahead of the transcript", () => {
    const msg = buildSessionSummaryMessage(
      "Turn 1\nLearner: hi\nTutor: hello",
      {
        passed: false,
        final_score: 0.42,
        turn_count: 5,
        duration_mins: 9,
        pass_threshold: 0.7,
      },
    );
    expect(msg.indexOf("passed: false (pass mark 0.7)")).toBeGreaterThan(-1);
    expect(msg.indexOf("score: 0.42")).toBeGreaterThan(-1);
    expect(msg.indexOf("learner turns: 5")).toBeGreaterThan(-1);
    expect(msg.indexOf("SESSION OUTCOME")).toBeLessThan(
      msg.indexOf("TRANSCRIPT"),
    );
  });

  it("returns a fixed honest summary for a very short session without calling Gemini", async () => {
    const outcome = {
      passed: false,
      final_score: 0.9,
      turn_count: MIN_TURNS_FOR_MODEL_SUMMARY - 1,
      duration_mins: 1,
    };
    const text = await generateSessionSummary("Turn 1 ...", undefined, outcome);
    expect(text).toBe(shortSessionSummary(outcome));
    expect(text).toMatch(/Too short to assess/);
    expect(text).not.toMatch(/excellent|great/i);
  });
});

describe("one source of truth for learner numbers", () => {
  beforeEach(async () => {
    await AISession.deleteMany({ learnerId });
    await VocabLedger.deleteMany({ learnerId });
  });

  it("words learned counts retained words plus legacy mastery, from the ledger", async () => {
    await VocabLedger.create([
      { learnerId, orgId, word: "appointment", retained: true },
      { learnerId, orgId, word: "prescription", masteryScore: 0.8 },
      { learnerId, orgId, word: "receptionist", times_encountered: 2 },
    ]);
    expect(await countLearnedWords(learnerId)).toBe(2);
    const summary = await getLearnerVocabSummary(learnerId);
    expect(summary.words_seen).toBe(3);
    expect(summary.words_learned).toBe(2);
    expect(summary.recent_words).toHaveLength(3);
  });

  it("progress is computed over ALL sessions, not the last five", async () => {
    for (let i = 0; i < 7; i++) {
      await makeSession({
        turns: [turn(0), turn(1)],
        completedAt: i < 5 ? new Date() : null,
        passed: i < 2,
      });
    }
    await VocabLedger.create({
      learnerId,
      orgId,
      word: "form",
      retained: true,
    });
    const p = await getLearnerProgressService(learnerId.toString());
    expect(p).toMatchObject({
      sessions_total: 7,
      sessions_completed: 5,
      sessions_passed: 2,
      turns_total: 14,
      words_seen: 1,
      words_learned: 1,
    });
  });

  it("the sessions list carries a server side turn_count", async () => {
    await makeSession({ turns: [turn(0), turn(1), turn(2)] });
    await makeSession({ turns: [] });
    const res = await listAISessionsService({
      callerId: learnerId.toString(),
      callerRole: "student",
      callerOrgId: orgId.toString(),
    });
    const sessions = (res.data as { sessions: Array<Record<string, unknown>> })
      .sessions;
    const counts = sessions.map((s) => s.turn_count).sort();
    expect(counts).toEqual([0, 3]);
    expect(sessions.every((s) => !("turns" in s))).toBe(true);
  });

  it("MIN_TURNS_TO_PASS is at least four", () => {
    expect(MIN_TURNS_TO_PASS).toBeGreaterThanOrEqual(4);
  });
});
