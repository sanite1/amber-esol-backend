/**
 * Silk bug brief section 0 — diagnostic tracing.
 *
 * The trace helpers are fire and forget, so each test flushes the
 * pending create before reading the collection back.
 */
import { Types } from "mongoose";
import { DiagnosticTrace } from "../models/DiagnosticTrace";
import {
  traceEnabled,
  traceGeminiCall,
  traceWrite,
} from "../services/diagnosticTrace.service";

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("diagnostic tracing (section 0)", () => {
  afterEach(() => {
    delete process.env.AI_TRACE_ENABLED;
  });

  it("is on by default and can be switched off", () => {
    expect(traceEnabled()).toBe(true);
    process.env.AI_TRACE_ENABLED = "false";
    expect(traceEnabled()).toBe(false);
  });

  it("stores the full prompt, raw response, parsed fields and timing of a Gemini call", async () => {
    const sessionId = new Types.ObjectId();
    const learnerId = new Types.ObjectId();
    traceGeminiCall({
      source: "tutor_turn",
      sessionId,
      learnerId,
      orgId: null,
      modelName: "gemini-2.5-flash",
      temperature: 0.7,
      maxOutputTokens: 8192,
      systemPrompt: "SYSTEM PROMPT",
      history: [{ role: "user", content: "hi" }],
      userMessage: "I want to book an appointment",
      rawResponse: '{"reply":"Hello"}',
      parsed: { reply: "Hello", turn_score: 0.6 },
      finishReason: "STOP",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 1234,
    });
    await flush();
    const rows = await DiagnosticTrace.find({
      session_id: sessionId.toString(),
    }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "gemini_call",
      source: "tutor_turn",
      model_name: "gemini-2.5-flash",
      temperature: 0.7,
      system_prompt: "SYSTEM PROMPT",
      user_message: "I want to book an appointment",
      raw_response: '{"reply":"Hello"}',
      parsed: { reply: "Hello", turn_score: 0.6 },
      latency_ms: 1234,
      error: null,
    });
    expect(rows[0].learner_id?.toString()).toBe(learnerId.toString());
  });

  it("records the error on a failed call", async () => {
    const sessionId = "attempt-123";
    traceGeminiCall({
      source: "placement_scoring",
      sessionId,
      modelName: "gemini-2.5-flash",
      latencyMs: 30000,
      error: new Error("timed out"),
    });
    await flush();
    const row = await DiagnosticTrace.findOne({ session_id: sessionId }).lean();
    expect(row?.error).toBe("Error: timed out");
  });

  it("stores before and after for a traced write, as plain JSON", async () => {
    const sessionId = new Types.ObjectId();
    const docId = new Types.ObjectId();
    traceWrite({
      source: "ai_session.end",
      collection: "aisessions",
      docId,
      sessionId,
      before: { passed: null, final_score: null },
      after: { passed: false, final_score: 0.42 },
    });
    await flush();
    const row = await DiagnosticTrace.findOne({
      session_id: sessionId.toString(),
      kind: "data_write",
    }).lean();
    expect(row).toMatchObject({
      collection_name: "aisessions",
      doc_id: docId.toString(),
      before: { passed: null, final_score: null },
      after: { passed: false, final_score: 0.42 },
    });
  });

  it("writes nothing when switched off", async () => {
    process.env.AI_TRACE_ENABLED = "false";
    const sessionId = new Types.ObjectId();
    traceWrite({
      source: "vocab_ledger.upsert_word",
      collection: "vocab_ledger",
      sessionId,
      before: null,
      after: { word: "appointment" },
    });
    await flush();
    expect(
      await DiagnosticTrace.countDocuments({
        session_id: sessionId.toString(),
      }),
    ).toBe(0);
  });

  it("is append only", async () => {
    const row = await DiagnosticTrace.create({
      kind: "data_write",
      session_id: "x",
      source: "test",
      timestamp: new Date(),
    });
    await expect(
      DiagnosticTrace.updateOne({ _id: row._id }, { $set: { source: "y" } }),
    ).rejects.toThrow(/append only/);
    await expect(DiagnosticTrace.deleteOne({ _id: row._id })).rejects.toThrow(
      /append only/,
    );
  });
});
