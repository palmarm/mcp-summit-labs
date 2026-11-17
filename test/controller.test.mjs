import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTool, utilizationState } from "../dist/controller/evaluator.js";
import { ALLOWED_TOOLS, ControllerError } from "../dist/controller/model.js";
import { formatJson, formatTerminal } from "../dist/controller/reporting.js";
import { runController } from "../dist/controller/runner.js";
import { createSimulation, SIMULATIONS } from "../dist/controller/simulation.js";

const memory = (usedBytes = 750, extra = {}) => ({ structuredContent: {
  totalBytes: 1000, usedBytes, freeBytes: 1000 - usedBytes, utilizationPercent: usedBytes / 10, ...extra,
} });
const kind = (expected) => (error) => error instanceof ControllerError && error.kind === expected;

test("utilization thresholds are inclusive and evaluated before rounding", () => {
  for (const [percent, state] of [
    [0, "healthy"], [74.9999, "healthy"], [75, "warning"], [89.9999, "warning"],
    [90, "critical"], [100, "critical"], [-1, "unknown"], [101, "unknown"], [NaN, "unknown"], [Infinity, "unknown"],
  ]) assert.equal(utilizationState(percent), state, String(percent));
  assert.equal(evaluateTool("memory_usage", memory()).state, "warning");
  assert.equal(evaluateTool("memory_usage", memory(900)).state, "critical");
});

test("validates actual server byte accounting, reserved blocks, and zero capacity", () => {
  const disk = { path: "/private", totalBytes: 1000, usedBytes: 700, availableBytes: 200, utilizationPercent: 70 };
  const check = evaluateTool("disk_usage", { structuredContent: disk });
  assert.equal(check.state, "healthy");
  assert.equal(check.metric.utilizationPercent, 70); // Not 80% (1-available/total) or df's 700/900.
  assert.equal(check.metric.path, undefined);
  assert.equal(evaluateTool("memory_usage", memory(0, { totalBytes: 0, freeBytes: 0 })).state, "unknown");
  for (const extra of [
    { freeBytes: 251 }, { utilizationPercent: 74 }, { usedBytes: 1001 },
    { totalBytes: -1 }, { totalBytes: Number.MAX_SAFE_INTEGER + 1 },
    { freeBytes: Infinity }, { usedBytes: 1.5 }, { utilizationPercent: NaN }, { totalBytes: "1000" },
  ]) assert.throws(() => evaluateTool("memory_usage", memory(750, extra)), kind("validation"));
  assert.throws(() => evaluateTool("disk_usage", { structuredContent: { ...disk, availableBytes: 301 } }), kind("validation"));
});

test("structured output is mandatory; tool errors are distinct from malformed output", () => {
  for (const raw of [undefined, null, "text", {}, { content: [{ type: "text", text: JSON.stringify(memory().structuredContent) }] },
    { structuredContent: [] }, { structuredContent: null }, { isError: "false", ...memory() }]) {
    assert.throws(() => evaluateTool("memory_usage", raw), kind("validation"));
  }
  assert.throws(() => evaluateTool("memory_usage", { isError: true, ...memory() }), kind("tool"));
  assert.throws(() => evaluateTool("system_info", { structuredContent: { platform: "linux" } }), kind("validation"));
});

test("all deterministic scenarios have the expected state, code and error category", async () => {
  const expected = {
    healthy: ["healthy", 0], "high-memory": ["warning", 0], "critical-disk": ["critical", 1],
    "malformed-output": ["unknown", 2, "validation"], "missing-tools": ["unknown", 2, "discovery"],
    "transport-failure": ["unknown", 2, "transport"], "tool-error": ["unknown", 2, "tool"],
  };
  for (const mode of SIMULATIONS) {
    const report = await runController(createSimulation(mode), { source: `simulation:${mode}` });
    assert.deepEqual([report.state, report.exitCode, report.failures[0]?.kind], [...expected[mode].slice(0, 2), expected[mode][2]], mode);
    assert.deepEqual(JSON.parse(formatJson(report)), report);
    assert.match(formatTerminal(report), new RegExp(report.state.toUpperCase()));
  }
});

test("discovery gates all calls, rejects duplicate required names and ignores unrelated tools", async () => {
  for (const names of [[], ["system_info", "memory_usage"], [...ALLOWED_TOOLS, "memory_usage"]]) {
    let calls = 0;
    let closes = 0;
    const session = { ...createSimulation("healthy"), async discover() { return names; },
      async call() { calls++; }, async close() { closes++; } };
    const report = await runController(session);
    assert.equal(report.failures[0].kind, "discovery");
    assert.equal(calls, 0);
    assert.equal(closes, 1);
  }
  const fixture = createSimulation("healthy");
  const calls = [];
  const report = await runController({ ...fixture,
    async discover() { return ["write_lab_note", ...ALLOWED_TOOLS, "untrusted-name"]; },
    async call(name) { calls.push(name); return fixture.call(name); },
  });
  assert.equal(report.state, "healthy");
  assert.deepEqual(calls, ALLOWED_TOOLS);
});

test("tool and protocol errors allow remaining read-only checks; transport failure stops calls", async () => {
  for (const errorKind of ["tool", "protocol", "transport"]) {
    const fixture = createSimulation("healthy");
    const calls = [];
    const report = await runController({ ...fixture,
      async call(name) {
        calls.push(name);
        if (name === "memory_usage") throw new ControllerError(errorKind);
        return fixture.call(name);
      },
    });
    assert.equal(report.state, "unknown");
    assert.equal(report.failures[0].kind, errorKind);
    assert.deepEqual(calls, errorKind === "transport" ? ALLOWED_TOOLS.slice(0, 2) : ALLOWED_TOOLS);
  }
});

test("cleanup runs after failures at every stage and cleanup failure overrides a critical result", async () => {
  for (const stage of ["connect", "discover", "call", "close"]) {
    let closes = 0;
    const fixture = createSimulation("critical-disk");
    const session = { ...fixture, async close() { closes++; } };
    session[stage] = async () => {
      if (stage === "close") closes++;
      throw new Error("SECRET=never-report-this");
    };
    const report = await runController(session);
    assert.equal(closes, 1, stage);
    assert.equal(report.state, "unknown", stage);
    assert.equal(report.exitCode, 2);
    assert.equal(report.failures[0].kind, stage === "close" ? "cleanup" : "execution");
    assert.ok(!formatJson(report).includes("SECRET"));
  }
});

test("deadline and cancellation close stalled sessions, including a pre-aborted run", { timeout: 3000 }, async () => {
  for (const stage of ["connect", "discover", "call"]) {
    let closes = 0;
    const fixture = createSimulation("healthy");
    const session = { ...fixture, [stage]: async () => new Promise(() => {}), async close() { closes++; } };
    const report = await runController(session, { timeoutMs: 20 });
    assert.equal(report.failures[0].kind, "cancelled", stage);
    assert.equal(closes, 1);
  }
  const abort = new AbortController();
  abort.abort();
  let connected = false;
  let closed = false;
  const report = await runController({ ...createSimulation("healthy"),
    async connect() { connected = true; }, async close() { closed = true; },
  }, { signal: abort.signal });
  assert.equal(report.state, "unknown");
  assert.equal(connected, false);
  assert.equal(closed, true);
});

test("reporting projects numeric metrics and never includes tool strings or errors", async () => {
  const secret = "SECRET_TOKEN=private\u001b[2J";
  const fixture = createSimulation("healthy");
  const report = await runController({ ...fixture, async call(name) {
    const raw = await fixture.call(name);
    if (name === "system_info") {
      for (const field of Object.keys(raw.structuredContent)) raw.structuredContent[field] = secret;
    } else {
      raw.structuredContent.extraSecret = secret;
      if (name === "disk_usage") raw.structuredContent.path = secret;
    }
    return { ...raw, content: [{ type: "text", text: secret }], _meta: { secret } };
  } });
  assert.equal(report.state, "healthy");
  for (const output of [formatTerminal(report), formatJson(report)]) {
    assert.ok(!output.includes(secret));
    assert.ok(!output.includes("extraSecret"));
    assert.ok(!output.includes("\u001b"));
    assert.match(output, /reclaimable Linux caches/);
    assert.match(output, /Reserved free blocks|reserved free blocks/);
  }
});
