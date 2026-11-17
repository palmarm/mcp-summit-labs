import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ConfirmedStdioTransport, McpOperationsSession } from "../dist/controller/stdio.js";
import { createMockModel } from "../dist/agent/mock.js";
import { runAgent } from "../dist/agent/runner.js";

const root = new URL("../", import.meta.url);
async function cli(t, args, envOverrides = {}) {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.GEMINI_MODEL;
  const child = spawn(process.execPath, ["dist/agent/cli.js", ...args], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...env, ...envOverrides },
  });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const [code, signal] = await closed;
  assert.equal(signal, null);
  return { code, stdout, stderr };
}

test("offline CLI fixtures emit exact readiness codes and labelled model traces without credentials", { timeout: 30_000 }, async (t) => {
  for (const [simulation, state, code] of [["healthy", "healthy", 0], ["high-memory", "warning", 0],
    ["critical-disk", "critical", 1], ["malformed-output", "unknown", 2], ["transport-failure", "unknown", 2]]) {
    const result = await cli(t, ["--mock", "memory", "--simulate", simulation, "How is memory?"], {
      GEMINI_API_KEY: "PRIVATE_ENV_KEY", GEMINI_MODEL: "INVALID_MODEL_IGNORED_OFFLINE",
    });
    assert.equal(result.code, code, result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.model, "offline-mock");
    assert.equal(report.readiness.state, state);
    assert.equal(report.readiness.exitCode, code);
    assert.ok(!result.stdout.includes("PRIVATE_ENV_KEY"));
    assert.ok(!result.stderr.includes("PRIVATE_ENV_KEY"));
    assert.match(result.stderr, new RegExp(`Deployment readiness: ${state.toUpperCase()}`));
    if (simulation === "healthy") {
      assert.match(result.stderr, /model turn 1: memory_usage/);
      assert.match(result.stderr, /readiness completion: system_info/);
    }
  }
});

test("CLI denies writes/arguments, enforces loops, and reports API failures in offline fixtures", { timeout: 30_000 }, async (t) => {
  for (const [fixture, kind] of [["denied-write", "invalid_tool_request"], ["bad-args", "invalid_tool_request"],
    ["loop", "agent_limit"], ["quota", "model_quota"], ["unavailable", "model_unavailable"], ["api-failure", "model_api"]]) {
    const result = await cli(t, ["--json", "--mock", fixture, "--simulate", "healthy", "Check deployment"]);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).agent.failures[0].kind, kind);
  }
});

test("live mode requires environment key; invalid CLI arguments never echo credentials", { timeout: 30_000 }, async (t) => {
  for (const args of [["Check disk"], ["--check-model"], ["--api-key", "PRIVATE_ARGUMENT_KEY", "Check"],
    ["--simulate", "healthy", "Check"], ["--enable-note-writes", "Check"], ["--mock", "all"],
    ["--mock", "unknown", "Check"], ["--mock", "all", "--check-model"]]) {
    const result = await cli(t, args);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).error.kind, "configuration");
    assert.ok(!result.stdout.includes("PRIVATE_ARGUMENT_KEY"));
    assert.ok(!result.stderr.includes("PRIVATE_ARGUMENT_KEY"));
  }
  const help = await cli(t, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /gemini-3\.8-flash/);
  assert.match(help.stdout, /GEMINI_MODEL/);
  assert.match(help.stdout, /cannot verify quota/);
});

test("agent uses actual MCP stdio and reaps its child after success, denial, model failure and timeout", { timeout: 30_000 }, async (t) => {
  for (const fixture of ["disk", "denied-write", "api-failure", "stall"]) {
    await t.test(fixture, async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), "mcp-agent-"));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      let startedPid;
      class ObservedTransport extends ConfirmedStdioTransport {
        async start() { await super.start(); startedPid = this.pid; }
      }
      const transport = new ObservedTransport({ command: process.execPath,
        args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))], cwd, stderr: "ignore" });
      const session = new McpOperationsSession(transport);
      t.after(() => session.close());
      const model = fixture === "stall" ? { ...createMockModel("all"), async next() { return new Promise(() => {}); } }
        : createMockModel(fixture);
      const report = await runAgent(session, model, "How is disk?", { mode: "mock", requestMs: 100 });
      assert.ok(startedPid);
      assert.throws(() => process.kill(startedPid, 0), { code: "ESRCH" });
      assert.deepEqual(await readdir(cwd), []);
      if (fixture === "disk") {
        assert.notEqual(report.readiness.state, "unknown");
        assert.equal(report.agent.trace[0].tool, "disk_usage");
      } else {
        assert.equal(report.readiness.exitCode, 2);
        if (fixture === "stall") assert.equal(report.agent.failures[0].kind, "model_timeout");
      }
    });
  }
});

test("SIGTERM to agent CLI closes and reaps an active MCP child", {
  timeout: 20_000, skip: process.platform !== "linux" ? "Uses /proc and POSIX signals" : false,
}, async (t) => {
  const child = spawn(process.execPath, ["dist/agent/cli.js", "--json", "--mock", "all", "Check deployment"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let serverPid;
  t.after(async () => {
    child.kill("SIGKILL");
    if (serverPid) { try { process.kill(serverPid, "SIGKILL"); } catch {} }
    await closed;
  });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
  child.stderr.resume();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !serverPid) {
    const children = await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").catch(() => "");
    serverPid = Number(children.trim().split(/\s+/)[0]) || undefined;
    if (!serverPid) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(serverPid);
  // Stop the server to keep an MCP request active until CLI cancellation.
  process.kill(serverPid, "SIGSTOP");
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).readiness.state, "unknown");
  assert.throws(() => process.kill(serverPid, 0), { code: "ESRCH" });
});
