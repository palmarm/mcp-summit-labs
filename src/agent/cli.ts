import { formatTerminal } from "../controller/reporting.js";
import { createSimulation, isSimulation, SIMULATIONS, type Simulation } from "../controller/simulation.js";
import { createLocalSession } from "../controller/stdio.js";
import { createHttpSession } from "../controller/http.js";
import { DEFAULT_HTTP_URL, localHttpUrl } from "../http-policy.js";
import { createGeminiModel, DEFAULT_MODEL, FREE_TIER_REFERENCE } from "./gemini.js";
import { createMockModel, isMockFixture, MOCK_FIXTURES, type MockFixture } from "./mock.js";
import { AgentError, agentFailure, bounded, LIMITS, safeText, type AgentModel } from "./model.js";
import { runAgent } from "./runner.js";

const HELP = `Gemini MCP DevOps Agent (Lab 4B; Node.js >=22)
Usage: node dist/agent/cli.js [--json] [--mock FIXTURE] [--simulate MODE] [--transport stdio|http] [--url URL] "question"
       node dist/agent/cli.js --check-model
Mock fixtures: ${MOCK_FIXTURES.join(", ")}
Monitoring simulations (require --mock): ${SIMULATIONS.join(", ")}

Live use requires GEMINI_API_KEY from the environment only. GEMINI_MODEL overrides
the default ${DEFAULT_MODEL}. There are no retries, model fallback, or billing changes.
The default model has Free tier standard input/output pricing (checked 2026-11-17):
${FREE_TIER_REFERENCE}
Public pricing does not confirm project access, quota or billing tier. --check-model
checks model metadata/access without generation or MCP; it cannot verify quota.
Use a Free tier project key for Free tier operation. An explicitly selected override
uses that model's terms. A paid-tier project can incur charges for the same model.

--mock uses deterministic model choices with the real built local MCP server,
requires no key/network, and never enables note writes. Add --simulate for fully
deterministic metrics without a child process or OS reads. Mock questions do not
change the fixture's tool choices. Only three read-only monitoring tools are exposed.
Transport defaults to stdio. --transport http uses the independently started local
server; --url defaults to ${DEFAULT_HTTP_URL} and requires HTTP. Only literal IPv4
127.0.0.1, an explicit port and /mcp are accepted. No redirects or remote access.
HTTP pins 2026-07-28 with no legacy fallback; closing the client leaves the server
running. Origin checks are not authentication. Simulations and --check-model do
not accept HTTP transport options. Mock HTTP use requires no Gemini API key.
Model-requested calls and deterministic completion checks are labelled in the trace.
All tool names/arguments are checked before MCP invocation. No raw MCP text, host
identity, paths, prompts, credentials, or opaque model history enter the trace.
JSON report: stdout; readable summary/trace: stderr. --json suppresses the summary.
No files are written; redirect stdout to save a report. Model explanation is advisory.
The shared Lab 4A evaluator alone sets readiness and exit codes (0 healthy/warning,
1 critical, 2 unknown/execution failure). Memory includes caches; disk excludes
reserved free blocks from used bytes. Warning >=75%, critical >=90%.
Bounds: 4 model turns, 6 total MCP calls (including readiness completion), 15s per
model request, 60s per run. SIGINT/SIGTERM cancel and clean up the local server.
`;

async function main(): Promise<void> {
  let jsonOnly = false;
  let fixture: MockFixture | undefined;
  let simulation: Simulation | undefined;
  let checkModel = false;
  let invalid = false;
  let transport: "stdio" | "http" = "stdio";
  let transportSelected = false;
  let endpoint: string | undefined;
  const questionParts: string[] = [];
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(HELP); return; }
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (positional) questionParts.push(arg);
    else if (arg === "--") positional = true;
    else if (arg === "--json" && !jsonOnly) jsonOnly = true;
    else if (arg === "--check-model" && !checkModel) checkModel = true;
    else if (arg === "--mock" && fixture === undefined) {
      const value = args[++index];
      if (value && isMockFixture(value)) fixture = value; else invalid = true;
    } else if (arg === "--simulate" && simulation === undefined) {
      const value = args[++index];
      if (value && isSimulation(value)) simulation = value; else invalid = true;
    } else if (arg === "--transport" && !transportSelected) {
      transportSelected = true;
      const value = args[++index];
      if (value === "stdio" || value === "http") transport = value; else invalid = true;
    } else if (arg === "--url" && endpoint === undefined) {
      endpoint = args[++index];
      try { localHttpUrl(endpoint ?? ""); } catch { invalid = true; }
    } else if (arg.startsWith("--")) invalid = true;
    else questionParts.push(arg);
  }
  const question = questionParts.join(" ");
  if ((simulation && !fixture) || (checkModel && (fixture || simulation || question)) ||
      (!checkModel && (!question.trim() || question.length > 4000))) invalid = true;
  if ((endpoint && transport !== "http") || (simulation && transport === "http") ||
      (checkModel && (transportSelected || endpoint))) invalid = true;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let model: AgentModel | undefined;
  try {
    if (invalid) throw new AgentError("configuration");
    const configured = fixture ? { model: createMockModel(fixture), modelId: "offline-mock" } : createGeminiModel();
    model = configured.model;
    if (checkModel) {
      await bounded(abort.signal, LIMITS.requestMs, "model_timeout", (signal) => configured.model.prepare(signal));
      process.stdout.write(JSON.stringify({ model: configured.modelId, available: true,
        projectQuotaVerified: false, projectBillingTierVerified: false, fallback: false,
        freeTierPricingReference: configured.modelId === DEFAULT_MODEL ? FREE_TIER_REFERENCE : null }, null, 2) + "\n");
      return;
    }
    const report = await runAgent(simulation ? createSimulation(simulation) :
      transport === "http" ? createHttpSession(endpoint) : createLocalSession(), model,
      safeText(question, [process.env.GEMINI_API_KEY ?? ""]), {
        mode: fixture ? "mock" : "live", signal: abort.signal,
        source: simulation ? `agent-simulation:${simulation}` : transport === "http" ? "agent-http" : "agent-stdio",
      });
    process.exitCode = report.readiness.exitCode;
    if (!jsonOnly) {
      process.stderr.write(`Model: ${configured.modelId}${fixture ? ` (fixture: ${fixture})` : ""}\n`);
      for (const entry of report.agent.trace) process.stderr.write(
        `  ${entry.origin}${entry.origin === "model" ? ` turn ${entry.iteration}` : " completion"}: ${entry.tool} — ${entry.outcome}\n`);
      for (const error of report.agent.failures) process.stderr.write(`${error.kind}: ${error.message}\n`);
      if (report.agent.answer) process.stderr.write(`Model explanation (advisory): ${report.agent.answer}\n`);
      process.stderr.write(formatTerminal(report.readiness));
    }
    process.stdout.write(JSON.stringify({ model: configured.modelId, ...report }, null, 2) + "\n");
  } catch (error) {
    const failed = agentFailure(error instanceof AgentError ? error.kind : "execution");
    if (!jsonOnly) process.stderr.write(`${failed.kind}: ${failed.message}\n`);
    process.stdout.write(JSON.stringify({ state: "unknown", exitCode: 2, error: failed }, null, 2) + "\n");
    process.exitCode = 2;
  } finally {
    if (model) await model.close(); // Also clears opaque history after metadata-only checks.
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

for (const stream of [process.stdout, process.stderr]) stream.on("error", () => { process.exitCode = 2; });
main().catch(() => { process.stderr.write("Agent execution failed.\n"); process.exitCode = 2; });
