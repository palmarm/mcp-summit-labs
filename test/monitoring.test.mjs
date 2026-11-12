import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { diskUsage, memoryUsage, systemInfo } from "../dist/monitoring.js";
import { registerMonitoringTools } from "../dist/monitoring-tools.js";

// Exercise registration, MCP validation, and handlers without an extra client dependency.
async function client(t, readers) {
  const server = new McpServer({ name: "monitoring-test", version: "1.0.0" });
  registerMonitoringTools(server, readers);
  const [local, remote] = InMemoryTransport.createLinkedPair();
  t.after(() => server.close());
  await server.connect(remote);
  await local.start();
  let id = 0;
  async function request(method, params = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      local.onmessage = (message) => {
        if (message.id !== requestId) return;
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      };
      local.send({ jsonrpc: "2.0", id: requestId, method, params }).catch(reject);
    });
  }
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "monitoring-test-client", version: "1.0.0" },
  });
  await local.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return request;
}

function assertUsage(value) {
  for (const field of ["totalBytes", "usedBytes", "freeBytes", "availableBytes"]) {
    if (value[field] === undefined) continue;
    assert.ok(Number.isSafeInteger(value[field]) && value[field] >= 0, field);
    assert.ok(value[field] <= value.totalBytes, field);
  }
  assert.ok(Number.isFinite(value.utilizationPercent));
  assert.ok(value.utilizationPercent >= 0 && value.utilizationPercent <= 100);
  const expected = value.totalBytes === 0 ? 0 : value.usedBytes / value.totalBytes * 100;
  assert.ok(Math.abs(value.utilizationPercent - expected) < 1e-10);
}

test("monitoring tools advertise schemas and return real structured snapshots", { timeout: 10_000 }, async (t) => {
  const request = await client(t);
  const { tools } = await request("tools/list");
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["disk_usage", "memory_usage", "system_info"]);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.type, "object");
    const result = await request("tools/call", { name: tool.name, arguments: {} });
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.length > 0);
    const value = result.structuredContent;
    if (tool.name === "system_info") {
      for (const field of ["platform", "architecture", "kernelRelease", "hostname", "nodeVersion"]) {
        assert.equal(typeof value[field], "string");
      }
    } else {
      assertUsage(value);
      if (tool.name === "memory_usage") {
        assert.equal(value.usedBytes, value.totalBytes - value.freeBytes);
        assert.match(result.content[0].text, /reclaimable Linux caches/);
      } else {
        assert.equal(value.path, process.cwd());
        assert.ok(value.availableBytes <= value.totalBytes - value.usedBytes);
      }
    }
  }
});

test("memory calculation handles zero capacity and rejects invalid readings", () => {
  assert.deepEqual(memoryUsage({ totalmem: () => 1000, freemem: () => 400 }), {
    totalBytes: 1000, freeBytes: 400, usedBytes: 600, utilizationPercent: 60,
  });
  assertUsage(memoryUsage({ totalmem: () => 0, freemem: () => 0 }));
  for (const free of [-1, 1001, NaN, Infinity]) {
    assert.throws(() => memoryUsage({ totalmem: () => 1000, freemem: () => free }));
  }
});

test("disk accounting distinguishes reserved free blocks from used blocks", async () => {
  const stats = { bsize: 4n, blocks: 100n, bfree: 30n, bavail: 20n };
  const value = await diskUsage(async (path) => {
    assert.equal(path, process.cwd());
    return stats;
  });
  assert.deepEqual(value, {
    path: process.cwd(), totalBytes: 400, availableBytes: 80,
    usedBytes: 280, utilizationPercent: 70,
  });
  assertUsage(await diskUsage(async () => ({ ...stats, blocks: 0n, bfree: 0n, bavail: 0n })));
  const overQuota = await diskUsage(async () => ({ ...stats, bavail: -1n }));
  assert.equal(overQuota.availableBytes, 0);
  await assert.rejects(diskUsage(async () => ({ ...stats, bfree: 101n })));
  await assert.rejects(diskUsage(async () => ({ ...stats, blocks: BigInt(Number.MAX_SAFE_INTEGER) })));
});

test("monitoring failures return safe MCP errors without host details", { timeout: 10_000 }, async (t) => {
  const secret = "/private/credentials SECRET_TOKEN=example";
  const fail = () => { throw new Error(secret); };
  const request = await client(t, {
    systemInfo: fail, memoryUsage: fail, diskUsage: async () => fail(),
  });
  for (const [name, message] of [
    ["system_info", "Unable to read system information."],
    ["memory_usage", "Unable to read memory usage."],
    ["disk_usage", "Unable to read disk usage."],
  ]) {
    const result = await request("tools/call", { name, arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.deepEqual(result.content, [{ type: "text", text: message }]);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  await assert.rejects(diskUsage(async () => { throw new Error(secret); }));
});

test("monitoring tools reject client paths before reading the host", { timeout: 10_000 }, async (t) => {
  let reads = 0;
  const request = await client(t, {
    systemInfo: () => { reads++; return systemInfo(); },
    memoryUsage: () => { reads++; return memoryUsage(); },
    diskUsage: async () => { reads++; return diskUsage(); },
  });
  for (const name of ["system_info", "memory_usage", "disk_usage"]) {
    const result = await request("tools/call", { name, arguments: { path: "/arbitrary" } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /validation/i);
  }
  assert.equal(reads, 0);
});
