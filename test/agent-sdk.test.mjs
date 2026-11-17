import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, GoogleGenAI } from "@google/genai";
import { createSimulation } from "../dist/controller/simulation.js";
import { classifyModelError, DEFAULT_MODEL, GeminiModel, liveConfiguration } from "../dist/agent/gemini.js";
import { safeText } from "../dist/agent/model.js";
import { runAgent } from "../dist/agent/runner.js";

const key = "PRIVATE_OFFLINE_SDK_KEY";
const metadata = { name: `models/${DEFAULT_MODEL}`, supportedGenerationMethods: ["generateContent"] };
const reply = (parts, finishReason = "STOP") => ({ candidates: [{ content: { role: "model", parts }, finishReason }] });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function harness(handler, modelId = DEFAULT_MODEL) {
  const calls = [];
  const sdk = new GoogleGenAI({ apiKey: key, vertexai: false, apiVersion: "v1beta", httpOptions: {
    baseUrl: "https://generativelanguage.googleapis.com", timeout: 1000, retryOptions: { attempts: 1 },
    async fetch(url, init) {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, "generativelanguage.googleapis.com");
      assert.ok(!parsed.search.includes(key));
      const call = { path: parsed.pathname, method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call); // Deliberately do not record authentication headers.
      return handler(call, calls.length);
    },
  } });
  return { model: new GeminiModel(sdk.models, modelId, (text) => safeText(text, [key])), calls };
}

test("official SDK performs genuine function calls, replays signatures/IDs, and sends sanitized function responses", async () => {
  let generated = 0;
  const signature = "OPAQUE_SIGNATURE_NOT_FOR_REPORTS";
  const { model, calls } = harness((call) => {
    if (call.method === "GET") return json(metadata);
    assert.deepEqual(call.body.tools[0].functionDeclarations.map((tool) => tool.name), ["system_info", "memory_usage", "disk_usage"]);
    assert.ok(!JSON.stringify(call.body.tools).includes("write_lab_note"));
    assert.equal(call.body.toolConfig.functionCallingConfig.mode, "AUTO");
    if (++generated === 1) return json(reply([
      { functionCall: { name: "disk_usage", args: {}, id: "disk-call" }, thoughtSignature: signature },
      { functionCall: { name: "system_info", args: {}, id: "system-call" } },
    ]));
    const contents = call.body.contents;
    assert.equal(contents[1].parts[0].thoughtSignature, signature);
    assert.equal(contents[2].parts[0].functionResponse.id, "disk-call");
    assert.equal(contents[2].parts[1].functionResponse.id, "system-call");
    assert.deepEqual(contents[2].parts[1].functionResponse.response, { check: { tool: "system_info", state: "healthy" } });
    assert.ok(!JSON.stringify(contents[2]).includes("path"));
    assert.ok(!JSON.stringify(contents[2]).includes("hostname"));
    assert.ok(!JSON.stringify(contents).includes(key));
    return json(reply([{ text: `The observed disk usage is low. ${key}` }]));
  });
  const report = await runAgent(createSimulation("healthy"), model, `Check disk and system. ${key}`);
  assert.equal(report.readiness.state, "healthy");
  assert.equal(report.agent.iterations, 2);
  assert.deepEqual(report.agent.trace.map(({ origin, tool }) => [origin, tool]), [
    ["model", "disk_usage"], ["model", "system_info"], ["readiness", "memory_usage"],
  ]);
  assert.equal(calls.length, 3); // One metadata GET and exactly two generation requests.
  assert.ok(calls.every((call) => call.path.includes(DEFAULT_MODEL)));
  assert.ok(!JSON.stringify(report).includes(signature));
  assert.ok(!JSON.stringify(report).includes(key));
});

test("SDK errors map to safe distinct categories without retries or fallback", async () => {
  for (const [status, expected] of [[429, "model_quota"], [404, "model_unavailable"],
    [401, "model_auth"], [403, "model_auth"], [500, "model_api"], [504, "model_timeout"]]) {
    for (const stage of ["metadata", "generation"]) {
      const { model, calls } = harness((call) => {
        if (stage === "generation" && call.method === "GET") return json(metadata);
        return json({ error: { code: status, message: `PRIVATE_ERROR ${key}`, status: "TEST_FAILURE" } }, status);
      });
      const report = await runAgent(createSimulation("healthy"), model, "Check disk");
      assert.equal(report.agent.failures[0].kind, expected, `${stage} ${status}`);
      assert.equal(report.readiness.exitCode, 2);
      assert.equal(calls.length, stage === "metadata" ? 1 : 2);
      assert.ok(calls.every((call) => call.path.includes(DEFAULT_MODEL)));
      assert.ok(!JSON.stringify(report).includes("PRIVATE_ERROR"));
      assert.ok(!JSON.stringify(report).includes(key));
    }
  }
  assert.equal(classifyModelError(new Error(`PRIVATE_NETWORK ${key}`)).kind, "model_api");
  assert.equal(classifyModelError(new ApiError({ status: 400, message: "PRIVATE" })).kind, "model_api");
});

test("metadata preflight refuses missing capabilities or a different model", async () => {
  for (const data of [{ ...metadata, supportedGenerationMethods: [] }, { ...metadata, name: "models/gemini-other" }, {}]) {
    const { model, calls } = harness(() => json(data));
    const report = await runAgent(createSimulation("healthy"), model, "Check");
    assert.equal(report.agent.failures[0].kind, "model_unavailable");
    assert.equal(calls.length, 1);
  }
});

test("blocked, truncated, empty and automatic-continuation responses stop without hidden requests", async () => {
  for (const data of [{}, { promptFeedback: { blockReason: "SAFETY" } }, reply([]),
    reply([{ text: "truncated" }], "MAX_TOKENS"), reply([{ text: "partial" }], "CONTINUATION")]) {
    const { model, calls } = harness((call) => json(call.method === "GET" ? metadata : data));
    const report = await runAgent(createSimulation("healthy"), model, "Check");
    assert.equal(report.agent.failures[0].kind, "model_response");
    assert.equal(calls.length, 2);
  }
});

test("GEMINI_MODEL is configurable, key is environment-only, and no implicit model is substituted", async () => {
  const config = liveConfiguration({ GEMINI_API_KEY: key, GOOGLE_API_KEY: "ignored" });
  assert.equal(config.model, DEFAULT_MODEL);
  const override = "gemini-user-selected-test";
  assert.equal(liveConfiguration({ GEMINI_API_KEY: key, GEMINI_MODEL: override }).model, override);
  for (const env of [{}, { GOOGLE_API_KEY: key }, { GEMINI_API_KEY: " " },
    { GEMINI_API_KEY: key, GEMINI_MODEL: "" }, { GEMINI_API_KEY: key, GEMINI_MODEL: "https://private.invalid" }]) {
    assert.throws(() => liveConfiguration(env));
  }
  const { model, calls } = harness((call) => json(call.method === "GET"
    ? { ...metadata, name: `models/${override}` } : reply([{ text: "done" }])), override);
  const report = await runAgent(createSimulation("healthy"), model, "Check");
  assert.equal(report.readiness.state, "healthy");
  assert.ok(calls.every((call) => call.path.includes(override)));
});
