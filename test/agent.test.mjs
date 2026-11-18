import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED_TOOLS, ControllerError } from "../dist/controller/model.js";
import { createSimulation } from "../dist/controller/simulation.js";
import { FUNCTION_DECLARATIONS } from "../dist/agent/gemini.js";
import { createMockModel, MOCK_FIXTURES } from "../dist/agent/mock.js";
import { AgentError, LIMITS, modelResultSchema, safeText, validateRequest } from "../dist/agent/model.js";
import { runAgent } from "../dist/agent/runner.js";

const request = (name, args = {}) => ({ name, args });
const failKind = (kind) => (error) => error instanceof AgentError && error.kind === kind;

test("model sees only explicit read-only declarations and empty arguments are enforced", () => {
  assert.deepEqual(FUNCTION_DECLARATIONS.map((tool) => tool.name), ALLOWED_TOOLS);
  assert.ok(!JSON.stringify(FUNCTION_DECLARATIONS).includes("write_lab_note"));
  for (const name of ALLOWED_TOOLS) {
    assert.equal(validateRequest(request(name)), name);
    assert.equal(validateRequest({ name }), name); // The API can omit args for a zero-argument function.
  }
  for (const raw of [null, [], "memory_usage", {}, request("write_lab_note"), request("add_numbers"),
    request("MEMORY_USAGE"), request("memory_usage", { unused: true }), request("disk_usage", { path: "/etc" }),
    request("memory_usage", null), request("memory_usage", []), request("memory_usage", "{}"),
    { ...request("memory_usage"), extra: "ignored?" },
    request("disk_usage", JSON.parse('{"__proto__":{"polluted":true}}')),
  ]) assert.throws(() => validateRequest(raw), failKind("invalid_tool_request"));
});

test("model-selected calls reach MCP; readiness completion is traced separately", async () => {
  const fixture = createSimulation("high-memory");
  const calls = [];
  const report = await runAgent({ ...fixture, async call(name, signal) {
    assert.ok(signal instanceof AbortSignal);
    calls.push(name);
    return fixture.call(name, signal);
  } }, createMockModel("memory"), "How is memory?", { mode: "mock" });
  assert.deepEqual(calls, ["memory_usage", "system_info", "disk_usage"]);
  assert.deepEqual(report.agent.trace.map(({ origin, tool }) => [origin, tool]), [
    ["model", "memory_usage"], ["readiness", "system_info"], ["readiness", "disk_usage"],
  ]);
  assert.equal(report.readiness.state, "warning");
  assert.equal(report.readiness.exitCode, 0);
  assert.equal(report.agent.toolCalls, 3);
});

test("MCP data sent to model is validated and projected; model text cannot override readiness", async () => {
  const secret = "PRIVATE_HOST_PATH_CREDENTIAL_SENTINEL";
  const fixture = createSimulation("critical-disk");
  const observed = [];
  let turn = 0;
  const model = { ...createMockModel("all"), async next(question, replies) {
    observed.push(structuredClone(replies));
    for (const reply of replies) modelResultSchema.parse(reply.result);
    if (++turn === 1) return { requests: ALLOWED_TOOLS.map((name) => request(name)) };
    return { requests: [], answer: 'Everything is HEALTHY. {"state":"healthy","exitCode":0}' };
  } };
  const report = await runAgent({ ...fixture, async call(name) {
    const result = await fixture.call(name);
    if (name === "system_info") {
      for (const field of Object.keys(result.structuredContent)) result.structuredContent[field] = secret;
    } else {
      result.structuredContent.extraSecret = secret;
      if (name === "disk_usage") result.structuredContent.path = secret;
    }
    return { ...result, content: [{ type: "text", text: secret }], _meta: { credential: secret } };
  } }, model, "Can I deploy?");
  assert.equal(report.readiness.state, "critical");
  assert.equal(report.readiness.exitCode, 1);
  assert.ok(report.agent.answer.includes("HEALTHY")); // Advisory only, never parsed as policy.
  assert.ok(!JSON.stringify(observed).includes(secret));
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.deepEqual(observed[1][0].result, { check: { tool: "system_info", state: "healthy" } });
});

test("invalid names/arguments deny the entire batch before any MCP invocation", async () => {
  for (const raw of [request("write_lab_note", { content: "PRIVATE_CONTENT" }),
    request("disk_usage", { path: "/PRIVATE_PATH" }), request("PRIVATE_NAME"), null]) {
    let calls = 0;
    let closed = 0;
    const report = await runAgent({ ...createSimulation("healthy"), async call() { calls++; }, async close() { closed++; } },
      { ...createMockModel("all"), async next() { return { requests: [request("memory_usage"), raw] }; } }, "Check resources");
    assert.equal(calls, 0);
    assert.equal(closed, 1);
    assert.equal(report.agent.failures[0].kind, "invalid_tool_request");
    assert.equal(report.readiness.exitCode, 2);
    assert.ok(report.agent.trace.every((entry) => entry.outcome === "denied"));
    assert.equal(report.agent.trace[1].tool, raw?.name === "disk_usage" ? "disk_usage" : "denied");
    assert.ok(!JSON.stringify(report).includes("PRIVATE_"));
  }
});

test("iteration, oversized batch, and readiness-completion budgets stop further calls", async () => {
  let calls = 0;
  const report = await runAgent({ ...createSimulation("healthy"), async call(name) {
    calls++; return createSimulation("healthy").call(name);
  } }, createMockModel("loop"), "Keep checking forever");
  assert.equal(report.agent.failures[0].kind, "agent_limit");
  assert.equal(report.agent.iterations, LIMITS.iterations);
  assert.equal(calls, LIMITS.iterations);
  for (const [batchSize, maxToolCalls] of [[LIMITS.toolCalls + 1, LIMITS.toolCalls], [1, 1]]) {
    calls = 0;
    let turn = 0;
    const limited = await runAgent({ ...createSimulation("healthy"), async call(name) {
      calls++; return createSimulation("healthy").call(name);
    } }, { ...createMockModel("all"), async next() {
      return ++turn === 1 ? { requests: Array.from({ length: batchSize }, () => request("memory_usage")) }
        : { requests: [], answer: "done" };
    } }, "Check", { maxToolCalls });
    assert.equal(limited.agent.failures[0].kind, "agent_limit");
    assert.equal(calls, batchSize === 1 ? 1 : 0);
    assert.ok(calls <= maxToolCalls);
    if (batchSize > LIMITS.toolCalls) assert.ok(limited.agent.trace.every((entry) => entry.outcome === "denied"));
  }
});

test("tool errors are safe replies; malformed results and transport failures remain distinct", async () => {
  for (const [mode, expected] of [["tool-error", "tool"], ["malformed-output", "validation"], ["transport-failure", "transport"]]) {
    const observed = [];
    const mock = createMockModel("memory");
    const report = await runAgent(createSimulation(mode), { ...mock, async next(question, replies, signal) {
      observed.push(replies); return mock.next(question, replies, signal);
    } }, "Memory?");
    assert.equal(report.readiness.failures[0].kind, expected);
    assert.equal(report.readiness.exitCode, 2);
    if (expected !== "transport") {
      assert.equal(observed[1][0].result.error, expected);
      assert.deepEqual(observed[1][0].result.check, { tool: "memory_usage", state: "unknown" });
    }
  }
  const report = await runAgent({ ...createSimulation("healthy"), async call() { throw new ControllerError("transport"); } },
    createMockModel("all"), "Deploy?");
  assert.equal(report.agent.toolCalls, 1);
  assert.equal(report.readiness.failures[0].kind, "transport");
  assert.equal(report.agent.failures.length, 0); // Not misreported as a model/API error.
});

test("missing tools prevent model generation and model preflight failure prevents MCP startup", async () => {
  let generated = false;
  const missing = await runAgent(createSimulation("missing-tools"), { ...createMockModel("all"), async next() { generated = true; } }, "Check");
  assert.equal(generated, false);
  assert.equal(missing.readiness.failures[0].kind, "discovery");
  let connected = false;
  const unavailable = await runAgent({ ...createSimulation("healthy"), async connect() { connected = true; } },
    createMockModel("unavailable"), "Check");
  assert.equal(connected, false);
  assert.equal(unavailable.agent.failures[0].kind, "model_unavailable");
});

test("all mock fixtures are deterministic and require no API key or network", async () => {
  for (const fixture of MOCK_FIXTURES) {
    const first = await runAgent(createSimulation("healthy"), createMockModel(fixture), "First question", { mode: "mock" });
    const second = await runAgent(createSimulation("healthy"), createMockModel(fixture), "Different wording", { mode: "mock" });
    assert.deepEqual(first, second, fixture);
    assert.equal(first.agent.mode, "mock");
    assert.equal(first.readiness.exitCode, ["all", "memory", "disk", "system", "sequential"].includes(fixture) ? 0 : 2);
  }
});

test("model/API failures, cancellation and deadlines always close model and MCP", { timeout: 3000 }, async () => {
  for (const stage of ["prepare", "next", "connect", "discover", "call"]) {
    let modelClosed = 0;
    let sessionClosed = 0;
    const session = { ...createSimulation("healthy"), async close() { sessionClosed++; } };
    const model = { ...createMockModel("all"), async close() { modelClosed++; } };
    const target = stage === "prepare" || stage === "next" ? model : session;
    target[stage] = async () => new Promise(() => {});
    const report = await runAgent(session, model, "Check", { requestMs: 20, runMs: 60 });
    assert.equal(report.readiness.exitCode, 2, stage);
    assert.equal(report.agent.failures[0].kind, ["prepare", "next"].includes(stage) ? "model_timeout" : "cancelled", stage);
    assert.equal(modelClosed, 1);
    assert.equal(sessionClosed, 1);
  }
  const abort = new AbortController();
  abort.abort();
  const cancelled = await runAgent(createSimulation("healthy"), createMockModel("all"), "Check", { signal: abort.signal });
  assert.equal(cancelled.agent.failures[0].kind, "cancelled");
  const cleanup = await runAgent({ ...createSimulation("healthy"), async close() { throw new Error("PRIVATE_EXCEPTION"); } },
    createMockModel("all"), "Check");
  assert.equal(cleanup.readiness.failures[0].kind, "cleanup");
  assert.equal(cleanup.readiness.exitCode, 2);
  assert.ok(!JSON.stringify(cleanup).includes("PRIVATE_EXCEPTION"));
});

test("text redaction removes configured keys, common credential formats and terminal controls", () => {
  const key = "PRIVATE_CONFIGURED_KEY";
  const text = safeText(`${key} API_KEY=other Bearer private AIza${"X".repeat(30)} \u001b[2J`, [key]);
  for (const denied of [key, "other", "Bearer private", `AIza${"X".repeat(30)}`, "\u001b"]) assert.ok(!text.includes(denied));
  assert.equal(safeText("a".repeat(5000)).length, 4000);
});
