import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ALLOWED_TOOLS } from "../dist/controller/model.js";
import { formatJson } from "../dist/controller/reporting.js";
import { runController } from "../dist/controller/runner.js";
import { ConfirmedStdioTransport, McpOperationsSession } from "../dist/controller/stdio.js";

class ObservedTransport extends ConfirmedStdioTransport {
  startedPid = null;
  async start() { await super.start(); this.startedPid = this.pid; }
}

function assertReaped(pid) {
  assert.ok(pid);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

async function fixture(t, mode, entry = new URL("./fixtures/controller-server.mjs", import.meta.url)) {
  const cwd = await mkdtemp(join(tmpdir(), "mcp-controller-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const transport = new ObservedTransport({
    command: process.execPath, args: [fileURLToPath(entry), ...(mode ? [mode] : [])],
    cwd, stderr: "ignore", maxBufferSize: 1024 * 1024,
  });
  const session = new McpOperationsSession(transport);
  t.after(() => session.close());
  return { transport, session, cwd };
}

test("real built server initializes, discovers and calls only allowed tools with note writes disabled", { timeout: 15_000 }, async (t) => {
  const { transport, session, cwd } = await fixture(t, undefined, new URL("../dist/index.js", import.meta.url));
  const report = await runController(session);
  assert.equal(report.failures.length, 0, formatJson(report));
  assert.notEqual(report.state, "unknown");
  assert.deepEqual(report.checks.map((check) => check.tool), ALLOWED_TOOLS);
  assert.deepEqual(await readdir(cwd), []); // No note storage, audits, lock, or report files.
  assertReaped(transport.startedPid);
  await Promise.all([session.close(), session.close()]); // Idempotent ownership.
});

test("stdio handshake ordering, discovery pagination, safe projection and runtime allowlist", { timeout: 15_000 }, async (t) => {
  const { session, transport } = await fixture(t, "paginated");
  assert.throws(() => session.call("write_lab_note", new AbortController().signal), /could not complete/);
  const report = await runController(session);
  assert.equal(report.state, "healthy", formatJson(report));
  assert.ok(!formatJson(report).includes("PRIVATE_"));
  assertReaped(transport.startedPid);
});

test("stdio classifies tool, protocol, validation, discovery and transport failures separately", { timeout: 30_000 }, async (t) => {
  for (const [mode, expected] of [
    ["tool-error", "tool"], ["protocol-error", "protocol"], ["schema-error", "protocol"],
    ["malformed-output", "validation"], ["missing-tools", "discovery"],
    ["transport-failure", "transport"], ["close-init", "transport"], ["bad-json", "transport"],
  ]) {
    await t.test(mode, async (t) => {
      const { session, transport } = await fixture(t, mode);
      const report = await runController(session);
      assert.equal(report.exitCode, 2);
      assert.equal(report.failures[0].kind, expected, formatJson(report));
      assert.ok(!formatJson(report).includes("PRIVATE_"));
      assertReaped(transport.startedPid);
      if (["tool", "protocol", "validation"].includes(expected)) {
        assert.equal(report.checks[2].state, "healthy");
      }
    });
  }
});

test("spawn failure is a transport error and still closes cleanly", { timeout: 10_000 }, async (t) => {
  const transport = new ConfirmedStdioTransport({ command: "/nonexistent/lab4a-executable", stderr: "ignore" });
  const session = new McpOperationsSession(transport);
  t.after(() => session.close());
  const report = await runController(session);
  assert.equal(report.failures[0].kind, "transport");
  assert.equal(report.failures.length, 1);
  assert.equal(transport.pid, null);
});

test("cancellation during initialization, discovery and tool calls reaps each server", { timeout: 20_000 }, async (t) => {
  for (const mode of ["stall-init", "stall-discovery", "stall-call"]) {
    await t.test(mode, async (t) => {
      const { session, transport } = await fixture(t, mode);
      const report = await runController(session, { timeoutMs: 1500 });
      assert.equal(report.failures[0].kind, "cancelled", formatJson(report));
      assertReaped(transport.startedPid);
    });
  }
});

test("cleanup escalates through SIGTERM to SIGKILL and awaits child reaping", {
  timeout: 12_000, skip: process.platform === "win32" ? "POSIX signal escalation" : false,
}, async (t) => {
  const { session, transport } = await fixture(t, "stubborn");
  const report = await runController(session);
  assert.equal(report.state, "healthy", formatJson(report));
  assertReaped(transport.startedPid);
});
