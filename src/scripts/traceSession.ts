/**
 * Replay a session from its diagnostic traces (Silk bug brief section 0).
 *
 *   MONGODB_URI=... npm run trace:session -- <sessionId> [--full]
 *
 * Prints, in time order, every Gemini call (model, temperature,
 * latency, the user message, the parsed fields) and every traced
 * write (before → after) recorded against that session id. `--full`
 * also prints the complete system prompt and raw response of each
 * call. Read only.
 */
import * as dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import { DiagnosticTrace } from "../models/DiagnosticTrace";

const [sessionId, ...flags] = process.argv.slice(2);
const full = flags.includes("--full");

if (!sessionId) {
  console.error("usage: npm run trace:session -- <sessionId> [--full]");
  process.exit(1);
}
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI missing from environment");
  process.exit(1);
}

const line = (s: string) => console.log(s);
const clip = (s: unknown, n = 400): string => {
  const text = typeof s === "string" ? s : JSON.stringify(s);
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

const main = async () => {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const rows = await DiagnosticTrace.find({ session_id: sessionId })
    .sort({ timestamp: 1 })
    .lean();
  line(`session ${sessionId}: ${rows.length} trace rows`);
  for (const r of rows) {
    const at = new Date(r.timestamp).toISOString();
    if (r.kind === "gemini_call") {
      line(
        `\n[${at}] GEMINI ${r.source}  model=${r.model_name} temp=${r.temperature} latency=${r.latency_ms}ms tokens=${r.input_tokens ?? "?"}/${r.output_tokens ?? "?"} finish=${r.finish_reason ?? "-"}${r.error ? `  ERROR: ${r.error}` : ""}`,
      );
      if (r.history?.length) line(`  history: ${r.history.length} turns`);
      line(`  user: ${clip(r.user_message)}`);
      if (full) {
        line(`  --- system prompt (${r.system_prompt?.length ?? 0} chars) ---`);
        line(r.system_prompt ?? "");
        line(`  --- raw response ---`);
        line(r.raw_response ?? "");
      } else if (r.parsed) {
        line(`  parsed: ${clip(r.parsed, 600)}`);
      } else if (r.raw_response) {
        line(`  raw: ${clip(r.raw_response)}`);
      }
    } else {
      line(`\n[${at}] WRITE ${r.source}  ${r.collection_name}/${r.doc_id}`);
      line(`  before: ${clip(r.before, full ? 5000 : 400)}`);
      line(`  after:  ${clip(r.after, full ? 5000 : 400)}`);
    }
  }
  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
