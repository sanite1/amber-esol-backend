/**
 * Tutor eval harness — Silk brief section 3.
 *
 *   npm run eval:tutor                      # all cases, 2 runs each
 *   npm run eval:tutor -- --runs 3 --only e3-tr-back-pain
 *   TUTOR_TEMPERATURE=0.7 npm run eval:tutor  # compare a setting
 *
 * Runs every case in src/eval/tutorEvalCases.json through the SAME
 * prompt assembly and Gemini wrapper the live turn uses (no session,
 * no DB writes apart from the diagnostic trace, source "eval_tutor"),
 * applies the automatic checks, and writes a markdown report to
 * docs/eval/tutor-eval-<timestamp>.md with a column for the specialist.
 *
 * The automatic checks catch the mechanical failures. They do not
 * decide whether a recast is grammatical: cases marked
 * specialist_review must be marked by a DELTA qualified ESOL
 * specialist before a prompt change is treated as verified.
 *
 * Needs the Vertex credentials the server uses (.env).
 */
import * as dotenv from "dotenv";
dotenv.config();
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { initGeminiClient, MODEL_NAME } from "../lib/gemini";
import { generateTurn } from "../services/gemini.service";
import { assemblePrompt } from "../services/promptAssembly.service";
import type { LearnerProfileForPrompt } from "../services/promptAssembly.service";
import { decideMode } from "../services/modeController.service";
import { validateGeminiTurnOutput } from "../utils/geminiOutputValidator";
import {
  adaptScenario,
  loadScenarioById,
  tutorTemperature,
  tutorThinkingBudget,
  TURN_RESPONSE_SCHEMA,
} from "../services/aiSession.service";
import { proposeRecast, recastMode } from "../services/recast.service";
import { deterministicTurnScore } from "../services/turnScore.service";
import {
  checkStability,
  checkTurnOutput,
  englishShare,
  validateCases,
  type EvalFinding,
  type TutorEvalCase,
  type TurnOutputForEval,
} from "../eval/tutorEvalChecks";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const RUNS = Math.max(1, Number(flag("--runs") ?? 2));
const ONLY = flag("--only");
const CONCURRENCY = Math.max(1, Number(flag("--concurrency") ?? 3));
/** Pause between cases. The project's Vertex quota is low: a burst of a
 *  handful of calls returns 429, so the default paces the run. */
const DELAY_MS = Math.max(0, Number(flag("--delay") ?? 6000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const casesPath = join(__dirname, "..", "eval", "tutorEvalCases.json");
const cases = JSON.parse(readFileSync(casesPath, "utf8")) as TutorEvalCase[];
const caseErrors = validateCases(cases);
if (caseErrors.length) {
  console.error("case file invalid:\n" + caseErrors.join("\n"));
  process.exit(1);
}

interface RunResult {
  out: TurnOutputForEval & { raw: unknown };
  latencyMs: number;
  recast: unknown;
  deterministicScore: number;
  error?: string;
}

const runCase = async (c: TutorEvalCase): Promise<RunResult> => {
  const mode = decideMode({
    level: c.level,
    message: c.learnerInput,
    recentScores: [],
    recentModes: [],
  });
  const learner: LearnerProfileForPrompt = {
    esolLevel: c.level,
    l1Language: c.l1Language,
    vocabularyToReinforce: [],
    recentSessionSummaries: [],
    skillWeaknessFlags: [],
    currentMode: mode.mode.toUpperCase() as "BRIDGE" | "ANCHOR" | "IMMERSION",
    modeDirective: mode.modeDirective,
    l1RatioGuidance: mode.l1RatioGuidance,
    beat: c.history.length ? "roleplay" : "prepare",
    microStageNumber: 1,
    voiceInputAvailable: false,
    inputMode: "text",
  };
  const scenarioFile = loadScenarioById(c.scenarioId);
  const scenario = scenarioFile ? adaptScenario(scenarioFile, "en") : undefined;
  const assembled = assemblePrompt(learner, scenario);
  const started = Date.now();
  try {
    const [result, recast] = await Promise.all([
      generateTurn({
        systemPrompt: assembled.systemPrompt,
        conversationHistory: c.history,
        userMessage: c.learnerInput,
        temperature: tutorTemperature(),
        thinkingBudget: tutorThinkingBudget(),
        responseSchema: TURN_RESPONSE_SCHEMA as unknown as Record<
          string,
          unknown
        >,
        tracking: { sessionId: `eval:${c.id}`, orgId: null, learnerId: null },
        traceSource: "eval_tutor",
        validate: validateGeminiTurnOutput,
      }),
      recastMode() === "separate"
        ? proposeRecast({
            learnerSentence: c.learnerInput,
            level: c.level,
            tracking: {
              sessionId: `eval:${c.id}`,
              orgId: null,
              learnerId: null,
            },
          })
        : Promise.resolve(null),
    ]);
    const parsed = result.parsed as TurnOutputForEval;
    return {
      out: { ...parsed, raw: result.parsed },
      latencyMs: Date.now() - started,
      recast,
      deterministicScore: deterministicTurnScore({
        learnerMessage: c.learnerInput,
        level: c.level,
        recastApplied: parsed.recastApplied,
        distress: mode.distress,
      }).score,
    };
  } catch (err) {
    return {
      out: { reply: "", mode: "bridge", turn_score: 0, raw: null },
      latencyMs: Date.now() - started,
      recast: null,
      deterministicScore: 0,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
};

const pool = async <T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) => {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
};

const main = async () => {
  initGeminiClient();
  const selected = ONLY ? cases.filter((c) => c.id === ONLY) : cases;
  if (!selected.length) {
    console.error(`no case matches --only ${ONLY}`);
    process.exit(1);
  }
  console.log(
    `tutor eval: ${selected.length} cases x ${RUNS} runs, model ${MODEL_NAME}, temperature ${tutorTemperature()}, recast ${recastMode()}`,
  );

  const jobs = selected.flatMap((c) => Array.from({ length: RUNS }, () => c));
  const results = await pool(jobs, CONCURRENCY, async (c) => {
    let r = await runCase(c);
    if (r.error && /429|Too Many Requests|Resource exhausted/.test(r.error)) {
      // Quota, not a model failure: wait and try the case once more.
      await sleep(30_000);
      r = await runCase(c);
    }
    process.stdout.write(r.error ? "x" : ".");
    if (DELAY_MS) await sleep(DELAY_MS);
    return { c, r };
  });
  console.log("");

  const byCase = new Map<string, RunResult[]>();
  for (const { c, r } of results) {
    byCase.set(c.id, [...(byCase.get(c.id) ?? []), r]);
  }

  const lines: string[] = [];
  const stamp = new Date().toISOString();
  lines.push(`# Tutor eval — ${stamp}`);
  lines.push("");
  lines.push(
    `Model ${MODEL_NAME} · temperature ${tutorTemperature()} · recast mode ${recastMode()} · ${selected.length} cases × ${RUNS} runs`,
  );
  lines.push("");
  lines.push(
    "Automatic checks catch mechanical failures. Rows marked **specialist** need a DELTA qualified ESOL specialist to mark the recast column by hand; do not treat this report as a pass until that column is filled.",
  );
  lines.push("");

  let autoPass = 0;
  let autoFail = 0;
  let specialistRows = 0;
  let totalLatency = 0;
  let latencyCount = 0;
  const summaryRows: string[] = [];
  const detailBlocks: string[] = [];

  for (const c of selected) {
    const runs = byCase.get(c.id) ?? [];
    const findings: EvalFinding[] = [];
    runs.forEach((r) => {
      if (r.error) {
        findings.push({ check: "call", passed: false, detail: r.error });
        return;
      }
      findings.push(...checkTurnOutput(c, r.out));
      totalLatency += r.latencyMs;
      latencyCount += 1;
    });
    findings.push(
      ...checkStability(
        c,
        runs.filter((r) => !r.error).map((r) => r.out),
      ),
    );
    const failed = findings.filter((f) => !f.passed);
    if (failed.length) autoFail += 1;
    else autoPass += 1;
    if (c.specialist_review) specialistRows += 1;

    summaryRows.push(
      `| ${c.id} | ${c.level} | ${failed.length ? "FAIL" : "pass"} | ${failed.map((f) => f.check).join(", ") || "—"} | ${c.specialist_review ? "**specialist**" : ""} |`,
    );

    const block: string[] = [];
    block.push(`### ${c.id} (${c.level}, ${c.l1Language}) — ${c.purpose}`);
    block.push("");
    block.push(`Learner: \`${c.learnerInput}\``);
    block.push("");
    runs.forEach((r, i) => {
      if (r.error) {
        block.push(`- run ${i + 1}: ERROR ${r.error}`);
        return;
      }
      const share = Math.round(englishShare(r.out.reply) * 100);
      block.push(
        `- run ${i + 1} (${r.latencyMs} ms): mode ${r.out.mode}, model score ${r.out.turn_score}, deterministic ${r.deterministicScore}, recast ${String(r.out.recastApplied)}, ${share}% English`,
      );
      block.push(`  > ${r.out.reply.replace(/\n/g, " ")}`);
      if (r.recast)
        block.push(`  separate recast: \`${JSON.stringify(r.recast)}\``);
    });
    block.push("");
    block.push("Checks:");
    findings.forEach((f) =>
      block.push(`- ${f.passed ? "ok" : "FAIL"} ${f.check}: ${f.detail}`),
    );
    if (c.specialist_review) {
      block.push("");
      block.push(
        "Specialist marking (fill in): recast correct? [ ] yes [ ] no — notes: ",
      );
    }
    block.push("");
    detailBlocks.push(block.join("\n"));
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Automatic: ${autoPass} pass, ${autoFail} fail · specialist rows: ${specialistRows} · mean latency ${latencyCount ? Math.round(totalLatency / latencyCount) : 0} ms`,
  );
  lines.push("");
  lines.push("| case | level | auto | failed checks | review |");
  lines.push("|---|---|---|---|---|");
  lines.push(...summaryRows);
  lines.push("");
  lines.push("## Detail");
  lines.push("");
  lines.push(...detailBlocks);

  const outDir = join(__dirname, "..", "..", "docs", "eval");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `tutor-eval-${stamp.replace(/[:.]/g, "-")}.md`);
  writeFileSync(outPath, lines.join("\n"));
  console.log(
    `automatic: ${autoPass} pass, ${autoFail} fail; specialist rows ${specialistRows}; report ${outPath}`,
  );
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
