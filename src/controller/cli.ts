import { ControllerError } from "./model.js";
import { formatJson, formatTerminal } from "./reporting.js";
import { runController } from "./runner.js";
import { createLocalSession } from "./stdio.js";
import { createHttpSession } from "./http.js";
import { DEFAULT_HTTP_URL, localHttpUrl } from "../http-policy.js";
import { createSimulation, isSimulation, SIMULATIONS, type Simulation } from "./simulation.js";

const HELP = `DevOps Operations Controller (Lab 4A)
Usage: node dist/controller/cli.js [--json] [--simulate MODE] [--transport stdio|http] [--url URL]
Modes: ${SIMULATIONS.join(", ")}

Default: initialize the built local server via MCP stdio; discover tools; call
only system_info, memory_usage, disk_usage. Note writes remain disabled.
--transport http connects to an independently started local HTTP server (no child
process). --url requires HTTP; default ${DEFAULT_HTTP_URL}. Only literal IPv4
127.0.0.1 URLs with /mcp and an explicit port are allowed. No credentials, queries,
fragments, redirects, or DNS names. HTTP pins 2026-07-28 with no legacy fallback.
HTTP fetches have a 5s timeout. Closing the client leaves the HTTP server running.
Origin checks on the local server are not authentication. Simulations require stdio.
JSON report goes to stdout; readable summary goes to stderr. --json suppresses
the summary. No report files are written; redirect stdout to save the JSON.
Warning >=75%, critical >=90%, using validated unrounded utilizationPercent.
Memory = (total-free)/total, including Linux reclaimable caches.
Disk = (total-all free blocks)/total; reserved free blocks are not used.
availableBytes is reported separately and excludes reserved blocks.
Zero capacity or any failed/incomplete check or cleanup => unknown.
Exit: 0 healthy/warning, 1 critical, 2 unknown/execution failure.
15-second run deadline; SIGINT/SIGTERM cancel, close, and report unknown.
Simulations use deterministic fixtures without spawning a server or host load.
`;

async function main(): Promise<void> {
  let jsonOnly = false;
  let mode: Simulation | undefined;
  let invalid = false;
  let transport: "stdio" | "http" = "stdio";
  let transportSelected = false;
  let endpoint: string | undefined;
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(HELP); return; }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json" && !jsonOnly) jsonOnly = true;
    else if (arg === "--simulate" && mode === undefined) {
      const value = args[++index];
      if (value && isSimulation(value)) mode = value;
      else invalid = true;
    } else if (arg === "--transport" && !transportSelected) {
      transportSelected = true;
      const value = args[++index];
      if (value === "stdio" || value === "http") transport = value; else invalid = true;
    } else if (arg === "--url" && endpoint === undefined) {
      endpoint = args[++index];
      try { localHttpUrl(endpoint ?? ""); } catch { invalid = true; }
    } else invalid = true;
  }
  if ((endpoint && transport !== "http") || (mode && transport === "http")) invalid = true;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    // Bad arguments still get a safe machine-readable report and never spawn.
    const session = invalid ? {
      async connect() { throw new ControllerError("execution"); },
      async discover() { return []; },
      async call() { throw new ControllerError("execution"); },
      async close() {},
    } : mode ? createSimulation(mode) : transport === "http" ? createHttpSession(endpoint) : createLocalSession();
    const report = await runController(session, {
      source: invalid ? "invalid-arguments" : mode ? `simulation:${mode}` : transport === "http" ? "local-http" : "local-stdio",
      signal: abort.signal,
    });
    process.exitCode = report.exitCode;
    if (!jsonOnly) process.stderr.write(formatTerminal(report));
    process.stdout.write(formatJson(report));
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

// Never print raw exceptions, environment values, MCP text, or child stderr.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", () => { process.exitCode = 2; });
}
main().catch(() => {
  process.stderr.write("Controller execution failed.\n");
  process.exitCode = 2;
});
