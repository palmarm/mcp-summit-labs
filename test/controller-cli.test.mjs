import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function cli(t, args) {
  const child = spawn(process.execPath, ["dist/controller/cli.js", ...args], {
    cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LAB4A_PRIVATE_TOKEN: "PRIVATE_ENV_SENTINEL" },
  });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.ok(!stdout.includes("PRIVATE_ENV_SENTINEL"));
  assert.ok(!stderr.includes("PRIVATE_ENV_SENTINEL"));
  return { code, stdout, stderr };
}

test("CLI emits readable stderr plus parseable JSON stdout with exact exit codes", { timeout: 30_000 }, async (t) => {
  for (const [mode, state, code] of [
    ["healthy", "healthy", 0], ["high-memory", "warning", 0], ["critical-disk", "critical", 1],
    ["malformed-output", "unknown", 2], ["missing-tools", "unknown", 2],
    ["transport-failure", "unknown", 2], ["tool-error", "unknown", 2],
  ]) {
    const result = await cli(t, ["--simulate", mode]);
    assert.equal(result.code, code, mode);
    const report = JSON.parse(result.stdout);
    assert.equal(report.state, state);
    assert.equal(report.exitCode, code);
    assert.equal(report.source, `simulation:${mode}`);
    assert.match(result.stderr, new RegExp(`Deployment readiness: ${state.toUpperCase()}`));
  }
});

test("JSON-only mode, safe argument failures, and help document metrics without spawning", { timeout: 20_000 }, async (t) => {
  const result = await cli(t, ["--json", "--simulate", "healthy"]);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).state, "healthy");
  for (const args of [["--enable-note-writes"], ["PRIVATE_ARGUMENT_SENTINEL"], ["--simulate"], ["--simulate", "invalid"], ["--json", "--json"]]) {
    const invalid = await cli(t, args);
    assert.equal(invalid.code, 2);
    assert.equal(JSON.parse(invalid.stdout).source, "invalid-arguments");
    assert.ok(!invalid.stdout.includes("PRIVATE_ARGUMENT_SENTINEL"));
    assert.ok(!invalid.stderr.includes("PRIVATE_ARGUMENT_SENTINEL"));
  }
  const help = await cli(t, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /including Linux reclaimable caches/);
  assert.match(help.stdout, /reserved free blocks are not used/);
});

test("CLI default connects to the fixed local server and cleans up", { timeout: 20_000 }, async (t) => {
  const result = await cli(t, ["--json"]);
  const report = JSON.parse(result.stdout);
  assert.equal(report.source, "local-stdio");
  assert.equal(report.failures.length, 0, result.stdout);
  assert.notEqual(report.state, "unknown");
  assert.equal(result.code, report.exitCode);
  assert.equal(result.stderr, "");
});

test("SIGTERM to the CLI closes its child and emits unknown", {
  timeout: 20_000, skip: process.platform !== "linux" ? "Uses /proc to identify the owned child" : false,
}, async (t) => {
  const child = spawn(process.execPath, ["dist/controller/cli.js", "--json"], {
    cwd: new URL("../", import.meta.url), stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(async () => { child.kill("SIGKILL"); await closed; });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
  child.stderr.resume();
  let serverPid;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !serverPid) {
    const children = await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").catch(() => "");
    serverPid = Number(children.trim().split(/\s+/)[0]) || undefined;
    if (!serverPid) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(serverPid, "Observe server spawn after CLI installs signal handlers");
  child.kill("SIGTERM");
  const [code, signal] = await closed;
  assert.equal(signal, null);
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).state, "unknown");
  assert.throws(() => process.kill(serverPid, 0), { code: "ESRCH" });
});
