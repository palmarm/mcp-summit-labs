import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client, ProtocolError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startLocalHttpServer } from "../dist/http-server.js";
import { HTTP_BODY_LIMIT, HTTP_PROTOCOL_VERSION, localHttpUrl } from "../dist/http-policy.js";
import { createHttpSession } from "../dist/controller/http.js";
import { runController } from "../dist/controller/runner.js";
import { ConfirmedStdioTransport, McpOperationsSession } from "../dist/controller/stdio.js";
import { evaluateTool } from "../dist/controller/evaluator.js";
import { monitoringReaders } from "./fixtures/monitoring-readers.mjs";

async function server(t, mode = "healthy", options = {}) {
  const result = await startLocalHttpServer({ port: 0, readers: monitoringReaders(mode), ...options });
  t.after(() => result.close());
  return result;
}
async function client(t, url, records = []) {
  const c = new Client({ name: "http-integration-test", version: "1" }, {
    supportedProtocolVersions: [HTTP_PROTOCOL_VERSION], versionNegotiation: { mode: { pin: HTTP_PROTOCOL_VERSION } },
  });
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: async (input, init) => {
    const response = await fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(3000) });
    records.push({ method: init.method, headers: new Headers(init.headers), body: JSON.parse(init.body),
      session: response.headers.get("mcp-session-id") });
    return response;
  } });
  t.after(() => c.close());
  await c.connect(transport, { timeout: 3000 });
  return c;
}
// Wire fixtures for negative specification tests; the SDK serves every request.
function message(method = "tools/list", params = {}, version = HTTP_PROTOCOL_VERSION) {
  return { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientInfo": { name: "wire-test", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } } };
}
function raw(url, { method = "POST", body = JSON.stringify(message()), headers = {}, localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, localAddress, headers: Array.isArray(headers) ? headers : {
      Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      "MCP-Protocol-Version": HTTP_PROTOCOL_VERSION, "Mcp-Method": "tools/list", ...headers,
    } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("Local test request timed out")));
    if (body) req.write(body);
    req.end();
  });
}

test("HTTP uses July 2026 discovery, mirrored metadata, stateless POSTs and exactly three read-only tools", { timeout: 15_000 }, async (t) => {
  const s = await server(t);
  assert.equal(s.host, "127.0.0.1");
  const records = [];
  const c = await client(t, s.url, records);
  assert.equal(c.getProtocolEra(), "modern");
  assert.equal(c.getNegotiatedProtocolVersion(), HTTP_PROTOCOL_VERSION);
  const listing = await c.listTools();
  assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), ["disk_usage", "memory_usage", "system_info"]);
  for (const tool of listing.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.type, "object");
    const result = await c.callTool({ name: tool.name, arguments: {} });
    assert.notEqual(evaluateTool(tool.name, result).state, "unknown");
  }
  assert.equal(records[0].body.method, "server/discover");
  for (const record of records) {
    assert.equal(record.method, "POST");
    assert.equal(record.session, null);
    assert.equal(record.headers.get("mcp-session-id"), null);
    assert.equal(record.headers.get("mcp-protocol-version"), HTTP_PROTOCOL_VERSION);
    assert.equal(record.headers.get("mcp-method"), record.body.method);
    assert.equal(record.body.params._meta["io.modelcontextprotocol/protocolVersion"], HTTP_PROTOCOL_VERSION);
    assert.notEqual(record.body.method, "initialize");
    if (record.body.method === "tools/call") assert.equal(record.headers.get("mcp-name"), record.body.params.name);
  }
  // No initialize, discover or previous request is required on an independent exchange.
  const independent = await raw(s.url);
  assert.equal(independent.status, 200);
  assert.equal(JSON.parse(independent.text).result.tools.length, 3);
  assert.equal(independent.headers["mcp-session-id"], undefined);
  const ignoredSession = await raw(s.url, { headers: { "Mcp-Session-Id": "PRIVATE_SESSION", "Last-Event-ID": "PRIVATE_EVENT" } });
  assert.equal(ignoredSession.status, 200);
  assert.equal(ignoredSession.headers["mcp-session-id"], undefined);
  assert.ok(!ignoredSession.text.includes("PRIVATE_SESSION"));
});

test("deterministic readiness, structured validation and exit codes are equivalent over stdio and HTTP", { timeout: 25_000 }, async (t) => {
  for (const [mode, state, code] of [["healthy", "healthy", 0], ["warning", "warning", 0],
    ["critical", "critical", 1], ["malformed", "unknown", 2], ["tool-error", "unknown", 2]]) {
    await t.test(mode, async (t) => {
      const s = await server(t, mode);
      const transport = new ConfirmedStdioTransport({ command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/monitoring-stdio.mjs", import.meta.url)), mode], stderr: "ignore" });
      const stdio = new McpOperationsSession(transport);
      t.after(() => stdio.close());
      const [local, http] = await Promise.all([runController(stdio), runController(createHttpSession(s.url))]);
      assert.equal(local.state, state, JSON.stringify(local));
      assert.equal(http.state, state, JSON.stringify(http));
      assert.equal(http.exitCode, code);
      assert.deepEqual(http, local); // Same report schema and policy, including safe errors.
      assert.ok(!JSON.stringify(http).includes("PRIVATE_"));
      // Closing a controller HTTP session does not stop the independently owned server.
      assert.equal((await raw(s.url)).status, 200);
    });
  }
});

test("HTTP rejects paths/extra arguments and never registers notes or other stdio tools", { timeout: 10_000 }, async (t) => {
  const s = await server(t);
  const c = await client(t, s.url);
  for (const name of ["system_info", "memory_usage", "disk_usage"]) {
    assert.equal((await c.callTool({ name, arguments: { path: "/PRIVATE_PATH" } })).isError, true);
  }
  for (const name of ["write_lab_note", "add_numbers", "server_health"]) {
    await assert.rejects(c.callTool({ name, arguments: {} }),
      (error) => error instanceof ProtocolError && error.code === -32602);
  }
  const guarded = createHttpSession(s.url);
  t.after(() => guarded.close());
  await assert.rejects(async () => guarded.call("write_lab_note", new AbortController().signal));
});

test("Origin and Host gates deny malformed, opaque, cross-port, nonlocal and proxy requests", { timeout: 10_000 }, async (t) => {
  const s = await server(t);
  const origin = new URL(s.url).origin;
  assert.equal((await raw(s.url, { headers: { Origin: origin } })).status, 200);
  for (const value of ["https://evil.invalid", "null", "", "not-an-origin", `${origin}/`,
    "http://127.0.0.1:1", `https://${new URL(s.url).host}`, "http://localhost:3100",
    `${origin} https://evil.invalid`, `${origin}, ${origin}`]) {
    const result = await raw(s.url, { headers: { Origin: value } });
    assert.equal(result.status, 403, value);
    assert.equal(result.text, "Origin denied.\n");
  }
  for (const host of ["evil.invalid", "localhost:3100", "127.0.0.1:1", "127.0.0.1.evil.invalid"]) {
    const result = await raw(s.url, { headers: { Host: host } });
    assert.equal(result.status, 403, host);
    assert.ok(!result.text.includes(host));
  }
  for (const name of ["Forwarded", "X-Forwarded-Host", "X-Forwarded-For", "X-Forwarded-Proto"]) {
    assert.equal((await raw(s.url, { headers: { [name]: "PRIVATE_PROXY" } })).status, 403);
  }
  assert.equal((await raw(s.url, { method: "GET", body: "", headers: { Origin: "null" } })).status, 403);
  const host = new URL(s.url).host;
  assert.equal((await raw(s.url, { headers: ["Host", host, "Host", host] })).status, 403);
  assert.equal((await raw(s.url, { headers: ["Host", host, "Origin", origin, "Origin", origin] })).status, 403);
  if (process.platform === "linux") assert.equal((await raw(s.url, { localAddress: "127.0.0.2" })).status, 403);
  const excessive = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`X-Test-${index}`, "1"]));
  excessive.Origin = "https://evil.invalid"; // Must not be silently truncated and treated as Origin-less.
  assert.equal((await raw(s.url, { headers: excessive })).status, 431);
  assert.equal((await raw(s.url, { headers: { "X-Large": "x".repeat(9000) } })).status, 400);
});

test("SDK rejects malformed requests, header mismatch, unsupported versions and legacy HTTP without downgrade", { timeout: 10_000 }, async (t) => {
  const s = await server(t);
  for (const body of ["{", "null", "[]", "{}", JSON.stringify({ jsonrpc: "1.0", method: "tools/list", id: 1 })]) {
    assert.equal((await raw(s.url, { body })).status, 400, body);
  }
  const mismatch = await raw(s.url, { headers: { "Mcp-Method": "ping" } });
  assert.equal(mismatch.status, 400);
  assert.equal(JSON.parse(mismatch.text).error.code, -32020);
  const badVersion = "2099-01-01";
  const unsupported = await raw(s.url, { body: JSON.stringify(message("tools/list", {}, badVersion)),
    headers: { "MCP-Protocol-Version": badVersion } });
  assert.equal(unsupported.status, 400);
  assert.deepEqual(JSON.parse(unsupported.text).error.data.supported, [HTTP_PROTOCOL_VERSION]);
  const legacy = await raw(s.url, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy-test", version: "1" },
  } }), headers: { "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "initialize" } });
  assert.equal(legacy.status, 400);
  assert.deepEqual(JSON.parse(legacy.text).error.data.supported, [HTTP_PROTOCOL_VERSION]);
  const media = await raw(s.url, { headers: { "Content-Type": "text/plain" } });
  assert.equal(media.status, 415);
  for (const method of ["GET", "DELETE", "OPTIONS"]) {
    const result = await raw(s.url, { method, body: "" });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, "POST");
  }
  assert.equal((await raw(s.url.replace("/mcp", "/other"))).status, 404);
  assert.equal((await raw(`${s.url}?x=1`)).status, 404);
});

test("request-size limits cover declared and chunked bodies before tool execution", { timeout: 10_000 }, async (t) => {
  const s = await server(t);
  assert.equal((await raw(s.url, { body: "{", headers: { "Content-Length": String(HTTP_BODY_LIMIT + 1) } })).status, 413);
  const chunked = await raw(s.url, { body: "x".repeat(HTTP_BODY_LIMIT + 1),
    headers: { "Transfer-Encoding": "chunked" } });
  assert.equal(chunked.status, 413);
  assert.ok(!chunked.text.includes("xxxxxxxx"));
});

test("client refuses nonlocal URLs and redirects, reports unavailable server, and shutdown releases ports", { timeout: 15_000 }, async (t) => {
  for (const endpoint of ["https://127.0.0.1:3100/mcp", "http://localhost:3100/mcp", "http://evil.invalid:3100/mcp",
    "http://2130706433:3100/mcp", "http://127.1:3100/mcp", "http://127.0.0.1:0/mcp", "http://127.0.0.1:65536/mcp",
    "http://user:password@127.0.0.1:3100/mcp", "http://127.0.0.1:3100/other", "http://127.0.0.1:3100/mcp?token=PRIVATE",
    "http://127.0.0.1:3100/mcp#fragment"]) {
    assert.throws(() => localHttpUrl(endpoint));
    assert.throws(() => createHttpSession(endpoint));
  }
  const s = await server(t);
  await Promise.all([s.close(), s.close()]);
  const unavailable = await runController(createHttpSession(s.url));
  assert.equal(unavailable.exitCode, 2);
  assert.equal(unavailable.failures[0].kind, "transport");
  let requests = 0;
  const redirect = createServer((_req, res) => { requests++; res.writeHead(302, { Location: "http://remote.invalid/mcp" }); res.end(); });
  redirect.listen(0, "127.0.0.1");
  await once(redirect, "listening");
  t.after(() => new Promise((resolve) => redirect.close(resolve)));
  const report = await runController(createHttpSession(`http://127.0.0.1:${redirect.address().port}/mcp`));
  assert.equal(report.exitCode, 2);
  assert.equal(requests, 1);
  const stalled = createServer(() => {});
  stalled.listen(0, "127.0.0.1");
  await once(stalled, "listening");
  t.after(() => new Promise((resolve) => { stalled.closeAllConnections(); stalled.close(resolve); }));
  const cancelled = await runController(createHttpSession(`http://127.0.0.1:${stalled.address().port}/mcp`), { timeoutMs: 100 });
  assert.equal(cancelled.exitCode, 2);
  assert.equal(cancelled.failures[0].kind, "cancelled");
});

test("HTTP shutdown cancels in-flight exchanges and slow request bodies are bounded", { timeout: 10_000 }, async (t) => {
  const readers = monitoringReaders();
  let entered;
  const active = new Promise((resolve) => { entered = resolve; });
  const s = await server(t, "healthy", { readers: { ...readers, async diskUsage() { entered(); return new Promise(() => {}); } } });
  const c = await client(t, s.url);
  const pending = c.callTool({ name: "disk_usage", arguments: {} }, { timeout: 2000 });
  const rejected = assert.rejects(pending);
  await active;
  await s.close();
  await rejected;
  const slow = await server(t, "healthy", { requestMs: 100 });
  const response = await new Promise((resolve, reject) => {
    const req = request(slow.url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "100" } }, (res) => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.write("{");
  });
  assert.equal(response, 408);
});
