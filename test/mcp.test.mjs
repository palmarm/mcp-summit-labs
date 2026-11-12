import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

test("MCP stdio discovery, tool calls, and input validation", { timeout: 30_000 }, async (t) => {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("../", import.meta.url),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const closed = once(child, "close");
  // Register cleanup before any assertion so a failure cannot leave the server running.
  t.after(async () => {
    child.kill();
    await closed;
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const messages = lines[Symbol.asyncIterator]();
  await once(child, "spawn");

  let nextId = 0;
  // MCP stdio uses one JSON-RPC message per line. Requests here are sequential.
  async function request(method, params = {}) {
    const id = ++nextId;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    while (true) {
      const { value: line, done } = await messages.next();
      if (done) {
        const [code, signal] = await closed;
        assert.fail(`Server closed before answering ${method} (code=${code}, signal=${signal}): ${stderr}`);
      }
      const response = JSON.parse(line);
      assert.equal(response.jsonrpc, "2.0");
      if (response.id === undefined) continue; // Server notification.
      assert.equal(response.id, id);
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    }
  }

  const initialized = await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "lab-integration-test", version: "1.0.0" },
  });
  assert.equal(initialized.serverInfo.name, "first-mcp-server");
  assert.ok(initialized.capabilities.tools);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const { tools } = await request("tools/list");
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "add_numbers", "disk_usage", "memory_usage", "server_health", "system_info",
  ]);

  const sum = await request("tools/call", {
    name: "add_numbers", arguments: { a: 2, b: 3 },
  });
  assert.notEqual(sum.isError, true);
  assert.deepEqual(sum.content, [{ type: "text", text: "The sum is 5" }]);

  const health = await request("tools/call", { name: "server_health", arguments: {} });
  assert.notEqual(health.isError, true);
  assert.equal(health.content[0].type, "text");
  const status = JSON.parse(health.content[0].text);
  assert.equal(status.status, "healthy");
  assert.ok(Number.isInteger(status.uptimeSeconds) && status.uptimeSeconds >= 0);

  const invalid = await request("tools/call", {
    name: "add_numbers", arguments: { a: "2", b: 3 },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.content[0].type, "text");
  assert.match(invalid.content[0].text, /validation/i);
});
