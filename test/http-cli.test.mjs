import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import test from "node:test";
import { startLocalHttpServer } from "../dist/http-server.js";
import { monitoringReaders } from "./fixtures/monitoring-readers.mjs";

async function cli(t, entry, args) {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  const child = spawn(process.execPath, [fileURLToPath(new URL(`../dist/${entry}`, import.meta.url)), ...args], {
    stdio: ["ignore", "pipe", "pipe"], env,
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

test("controller and offline agent connect over HTTP with unchanged reports and authoritative exit codes", { timeout: 30_000 }, async (t) => {
  const server = await startLocalHttpServer({ port: 0, readers: monitoringReaders("critical") });
  t.after(() => server.close());
  const controller = await cli(t, "controller/cli.js", ["--json", "--transport", "http", "--url", server.url]);
  assert.equal(controller.code, 1, controller.stdout);
  assert.equal(controller.stderr, "");
  const report = JSON.parse(controller.stdout);
  assert.equal(report.state, "critical");
  assert.equal(report.source, "local-http");
  assert.ok(!controller.stdout.includes("PRIVATE_"));
  const agent = await cli(t, "agent/cli.js", ["--json", "--mock", "all", "--transport", "http", "--url", server.url, "Can we deploy?"]);
  assert.equal(agent.code, 1, agent.stdout);
  const agentReport = JSON.parse(agent.stdout);
  assert.equal(agentReport.readiness.state, "critical");
  assert.equal(agentReport.readiness.source, "agent-http");
  assert.deepEqual(agentReport.agent.trace.map((entry) => entry.tool), ["system_info", "memory_usage", "disk_usage"]);
  assert.ok(agentReport.agent.trace.every((entry) => entry.origin === "model"));
  assert.ok(!agent.stdout.includes("PRIVATE_"));
});

test("transport options reject remote URLs, contradictory modes and invalid arguments safely", { timeout: 30_000 }, async (t) => {
  for (const args of [["--transport", "sse"], ["--transport"], ["--transport", "http", "--transport", "stdio"],
    ["--url", "http://127.0.0.1:3100/mcp"], ["--transport", "http", "--url", "http://PRIVATE_HOST:3100/mcp"],
    ["--transport", "http", "--simulate", "healthy"], ["--transport", "http", "--url"]]) {
    const result = await cli(t, "controller/cli.js", args);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).source, "invalid-arguments");
    assert.ok(!result.stdout.includes("PRIVATE_HOST"));
    assert.ok(!result.stderr.includes("PRIVATE_HOST"));
  }
  const agent = await cli(t, "agent/cli.js", ["--mock", "all", "--transport", "http", "--url", "http://PRIVATE_HOST:3100/mcp", "Check"]);
  assert.equal(agent.code, 2);
  assert.equal(JSON.parse(agent.stdout).error.kind, "configuration");
  assert.ok(!agent.stdout.includes("PRIVATE_HOST"));
  const unchanged = await cli(t, "controller/cli.js", ["--json", "--transport", "stdio", "--simulate", "healthy"]);
  assert.equal(unchanged.code, 0);
  assert.equal(JSON.parse(unchanged.stdout).source, "simulation:healthy");
});

test("HTTP server entry binds loopback, writes no files, handles SIGTERM and rejects write-enable startup flags", { timeout: 15_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-http-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/http.js", import.meta.url)), "--port", "0"], {
    cwd, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(async () => { child.kill("SIGKILL"); await closed; });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const [line] = await once(lines, "line");
  const endpoint = /http:\/\/127\.0\.0\.1:[0-9]+\/mcp/.exec(line)?.[0];
  assert.ok(endpoint, line);
  assert.match(line, /2026-07-28/);
  assert.equal((await fetch(endpoint, { signal: AbortSignal.timeout(2000) })).status, 405);
  assert.deepEqual(await readdir(cwd), []);
  // A port collision gets a fixed safe failure and does not affect the first listener.
  const collision = await cli(t, "http.js", ["--port", new URL(endpoint).port]);
  assert.equal(collision.code, 2);
  assert.match(collision.stderr, /Local MCP HTTP server failed/);
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(stderr, "");
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(1000) }));
  for (const args of [["--enable-note-writes"], ["--host", "0.0.0.0"], ["--port", "65536"], ["--port", "-1"]]) {
    const result = await cli(t, "http.js", args);
    assert.equal(result.code, 2);
    assert.ok(!result.stderr.includes("Error:"));
  }
});
