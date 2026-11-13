import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

const executable = fileURLToPath(new URL("../dist/index.js", import.meta.url));

async function session(t, root, args) {
  const child = spawn(process.execPath, [executable, ...args], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostics = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostics += chunk; });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  const lines = createInterface({ input: child.stdout });
  const messages = lines[Symbol.asyncIterator]();
  await once(child, "spawn");
  let id = 0;
  async function request(method, params = {}) {
    const requestId = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
    while (true) {
      const next = await messages.next();
      assert.equal(next.done, false, `Server closed: ${diagnostics}`);
      const message = JSON.parse(next.value); // Any stdout diagnostic fails here.
      if (message.id === undefined) continue;
      assert.equal(message.jsonrpc, "2.0");
      assert.equal(message.id, requestId);
      assert.equal(message.error, undefined);
      return message.result;
    }
  }
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lab3-stdio", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { child, closed, request, diagnostics: () => diagnostics };
}

test("enabled startup flag works through stdio and preserves all five existing tools", {
  skip: process.platform !== "linux" ? "Enabled note writes require Linux" : false,
  timeout: 30_000,
}, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "mcp-note-stdio-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const s = await session(t, root, ["--enable-note-writes"]);
  const { tools } = await s.request("tools/list");
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["add_numbers", "disk_usage", "memory_usage", "server_health", "system_info", "write_lab_note"]);
  const call = (name, arguments_ = {}) => s.request("tools/call", { name, arguments: arguments_ });
  const sum = await call("add_numbers", { a: 2, b: 3 });
  assert.deepEqual(sum.content, [{ type: "text", text: "The sum is 5" }]);
  assert.equal(JSON.parse((await call("server_health")).content[0].text).status, "healthy");
  assert.equal((await call("system_info")).structuredContent.nodeVersion, process.version);
  const memory = (await call("memory_usage")).structuredContent;
  assert.equal(memory.usedBytes, memory.totalBytes - memory.freeBytes);
  const disk = (await call("disk_usage")).structuredContent;
  assert.equal(disk.path, root);
  assert.ok(disk.utilizationPercent >= 0 && disk.utilizationPercent <= 100);

  const invalid = await call("write_lab_note", { content: "DO_NOT_LOG_THIS", path: "../../escape" });
  assert.equal(invalid.isError, true);
  const created = await call("write_lab_note", { content: "STDIO_PRIVATE_NOTE\nsecond line" });
  assert.notEqual(created.isError, true);
  assert.equal(await fs.readFile(join(root, "lab-data", "notes", created.structuredContent.filename), "utf8"), "STDIO_PRIVATE_NOTE\nsecond line");

  // A second real server process must not bypass the cumulative quota lock.
  const other = spawn(process.execPath, [executable, "--enable-note-writes"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  other.stdout.resume();
  other.stderr.resume();
  assert.equal((await once(other, "close"))[0], 1);

  s.child.stdin.end();
  assert.equal((await s.closed)[0], 0);
  await assert.rejects(fs.lstat(join(root, "lab-data", ".note-writer.lock")), { code: "ENOENT" });
  const files = await fs.readdir(join(root, "lab-data", "audit"));
  const audit = (await Promise.all(files.map((name) => fs.readFile(join(root, "lab-data", "audit", name), "utf8")))).join("");
  assert.ok(audit.includes("invalid_input"));
  for (const secret of ["DO_NOT_LOG_THIS", "STDIO_PRIVATE_NOTE", root]) {
    assert.ok(!audit.includes(secret));
    assert.ok(!s.diagnostics().includes(secret));
  }
});
