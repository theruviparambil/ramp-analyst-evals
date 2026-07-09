/**
 * `npm run ask -- "your question"` — run the analyst agent once against the
 * fixture (or RAMP_MODE=live) and print the trajectory + answer. Handy for
 * poking at the agent outside the eval. Needs one API key.
 */
import { runAgent } from "./agent/agent.js";
import { createProviderClient, resolveAgentModel } from "./agent/provider.js";
import { selectBackend } from "./ramp/backend.js";
import { loadDotenv } from "./eval/env.js";

async function main(): Promise<void> {
  loadDotenv();
  const question = process.argv.slice(2).filter((a) => !a.startsWith("--")).join(" ").trim()
    || "Give me a Q2 spend summary: total, top vendor, and anything unusual.";

  if (!resolveAgentModel()) {
    console.error("No LLM key set — see .env.example. (The test suite runs without a key: `npm test`.)");
    process.exit(2);
  }

  const client = createProviderClient();
  const surface = selectBackend();
  console.log(`Q: ${question}\nmodel: ${client.label}  RAMP_MODE=${process.env.RAMP_MODE ?? "fixture"}\n`);

  const { trajectory, finalAnswer } = await runAgent(question, { client, surface });
  for (const s of trajectory.steps) {
    const flag = s.isError ? "✗" : "✓";
    console.log(`  ${flag} [${s.index}] ${s.name} — ${s.rationale}`);
    if (s.name === "execute_analyst_query" && typeof s.args?.sql === "string") {
      console.log(`      SQL: ${s.args.sql.replace(/\s+/g, " ").trim().slice(0, 160)}`);
    }
  }
  console.log(`\nAnswer:\n${finalAnswer}\n`);
}

main().catch((err) => {
  console.error(`ask: ${(err as Error).message}`);
  process.exit(1);
});
