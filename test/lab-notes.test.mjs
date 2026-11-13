import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { LabNotes, noteWritesEnabled, validNoteContent } from "../dist/lab-notes.js";
import { registerNoteTool } from "../dist/note-tools.js";
import { NOTE_NAME, NOTE_QUOTA, storageIO } from "../dist/note-storage.js";

const linuxOnly = { skip: process.platform !== "linux" ? "Enabled note writes require Linux" : false, timeout: 20_000 };

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "mcp-notes-"));
  const diagnostics = [];
  const services = [];
  t.after(async () => {
    for (const notes of services) await notes.close().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  async function start(overrides = {}) {
    const notes = await LabNotes.create({ enabled: true, root, diagnostic: async (line) => { diagnostics.push(line); }, ...options, ...overrides });
    services.push(notes);
    return notes;
  }
  return { root, diagnostics, start, notesPath: join(root, "lab-data", "notes"), auditPath: join(root, "lab-data", "audit") };
}

async function auditEvents(f) {
  const sessions = await fs.readdir(f.auditPath);
  const lines = await Promise.all(sessions.map((name) => fs.readFile(join(f.auditPath, name), "utf8")));
  return lines.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function text(result) { return result.content[0].text; }

// Use public SDK transports and schemas; this is not a direct-handler mock.
async function mcp(t, notes) {
  const server = new McpServer({ name: "notes-test", version: "1" });
  registerNoteTool(server, notes);
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
  await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  await local.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return request;
}

test("startup switch is exact, explicit, and off by default", () => {
  assert.equal(noteWritesEnabled([]), false);
  assert.equal(noteWritesEnabled(["--enable-note-writes"]), true);
  for (const args of [["true"], ["--enable-note-writes=false"], ["--root=/tmp"], ["--enable-note-writes", "--enable-note-writes"]]) {
    assert.throws(() => noteWritesEnabled(args));
  }
});

test("default-off calls and validation denials are diagnosed without filesystem access", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  const forbiddenIO = Object.fromEntries(Object.keys(storageIO).map((key) => [key, () => { assert.fail(`Disabled filesystem call: ${key}`); }]));
  const notes = await f.start({ enabled: false, io: forbiddenIO, platform: "unsupported" });
  const request = await mcp(t, notes);
  const result = await request("tools/call", { name: "write_lab_note", arguments: { content: "PRIVATE CONTENT" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /disabled/);
  const invalid = await request("tools/call", { name: "write_lab_note", arguments: { content: "PRIVATE CONTENT", path: "../outside" } });
  assert.equal(invalid.isError, true);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.deepEqual(f.diagnostics.map((line) => JSON.parse(line).reason), ["writes_disabled", "invalid_input"]);
  assert.ok(!f.diagnostics.join("").includes("PRIVATE CONTENT"));
});

test("plain text requires valid Unicode and 1–8192 UTF-8 bytes", () => {
  for (const content of ["x", "a".repeat(8192), "é".repeat(4096), "😀".repeat(2048), "\tline\r\nnext", "\ufffd"]) {
    assert.equal(validNoteContent(content), true);
  }
  for (const content of ["", "a".repeat(8193), "é".repeat(4097), "😀".repeat(2048) + "x", "\0", "\x01", "\x0b", "\x1b", "\x7f", "\u0085", "\ud800", "\udc00", "\ud800x"]) {
    assert.equal(validNoteContent(content), false);
  }
});

test("enabled MCP success has private generated files, schemas, and secret-free attempt/outcome audits", linuxOnly, async (t) => {
  const f = await fixture(t);
  const notes = await f.start();
  const request = await mcp(t, notes);
  const { tools: [tool] } = await request("tools/list");
  assert.equal(tool.name, "write_lab_note");
  assert.deepEqual(tool.inputSchema.required, ["content"]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  assert.equal(tool.outputSchema.type, "object");
  const content = "PRIVATE_NOTE_SENTINEL\n$(touch outside) is text, not an instruction. 😀";
  const result = await request("tools/call", { name: "write_lab_note", arguments: { content } });
  assert.notEqual(result.isError, true);
  const value = result.structuredContent;
  assert.match(value.filename, NOTE_NAME);
  assert.equal(value.filename, `note-${value.noteId}.txt`);
  assert.equal(value.bytesWritten, Buffer.byteLength(content));
  assert.equal(await fs.readFile(join(f.notesPath, value.filename), "utf8"), content);
  for (const path of [join(f.root, "lab-data"), f.notesPath, f.auditPath]) {
    const s = await fs.lstat(path);
    assert.equal(s.mode & 0o7777, 0o700);
    assert.equal(s.uid, process.geteuid());
  }
  assert.equal((await fs.lstat(join(f.notesPath, value.filename))).mode & 0o7777, 0o600);
  for (const name of await fs.readdir(f.auditPath)) assert.equal((await fs.lstat(join(f.auditPath, name))).mode & 0o7777, 0o600);
  const events = await auditEvents(f);
  assert.deepEqual(events.map((e) => e.event), ["attempt", "outcome"]);
  assert.equal(events[1].outcome, "created");
  assert.equal(events[0].operationId, events[1].operationId);
  const serialized = JSON.stringify(events) + text(result) + f.diagnostics.join("");
  for (const secret of ["PRIVATE_NOTE_SENTINEL", "$(touch", f.root]) assert.ok(!serialized.includes(secret));
});

test("strict unknown fields, traversal-shaped input, byte limits, and controls are audited before the handler", linuxOnly, async (t) => {
  const f = await fixture(t);
  const request = await mcp(t, await f.start());
  const invalid = [
    { content: "secret", filename: "../../escape.txt" }, { content: "secret", path: "/etc/passwd" },
    { content: "secret", directory: "..\\outside" }, { content: "secret", overwrite: true },
    { content: "secret", "RAW_SECRET_KEY\n": true }, { content: 1 }, {},
    ...["", "é".repeat(4097), "\ud800", "\0", "\x1b"].map((content) => ({ content })),
  ];
  for (const arguments_ of invalid) {
    const result = await request("tools/call", { name: "write_lab_note", arguments: arguments_ });
    assert.equal(result.isError, true);
    assert.match(text(result), /Invalid note input/);
    assert.ok(!text(result).includes("RAW_SECRET_KEY"));
  }
  assert.deepEqual(await fs.readdir(f.notesPath), []);
  const events = await auditEvents(f);
  assert.equal(events.length, invalid.length);
  assert.ok(events.every((event) => event.outcome === "denied" && event.reason === "invalid_input"));
  assert.ok(!JSON.stringify(events).includes("secret"));
  for (const content of ["a", "é".repeat(4096), "😀".repeat(2048)]) {
    assert.notEqual((await request("tools/call", { name: "write_lab_note", arguments: { content } })).isError, true);
  }
});

test("existing destinations and concurrent collisions never overwrite", linuxOnly, async (t) => {
  const f = await fixture(t, { noteId: () => "00000000-0000-4000-8000-000000000001" });
  const notes = await f.start();
  const results = await Promise.all([notes.write("first"), notes.write("second")]);
  assert.equal(results.filter((r) => !r.isError).length, 1);
  assert.match(text(results[1]), /already exists/);
  assert.equal(await fs.readFile(join(f.notesPath, "note-00000000-0000-4000-8000-000000000001.txt"), "utf8"), "first");
});

test("private directory initialization rejects links, wrong types, modes, and owners", linuxOnly, async (t) => {
  for (const component of ["lab-data", "notes", "audit"]) {
    const f = await fixture(t);
    if (component !== "lab-data") await fs.mkdir(join(f.root, "lab-data"), { mode: 0o700 });
    const link = component === "lab-data" ? join(f.root, component) : join(f.root, "lab-data", component);
    await fs.symlink(f.root, link);
    await assert.rejects(f.start(), /note_initialization_failed/);
  }
  for (const mode of [0o755, 0o770]) {
    const f = await fixture(t);
    await fs.mkdir(join(f.root, "lab-data"), { mode });
    await fs.chmod(join(f.root, "lab-data"), mode);
    await assert.rejects(f.start(), /note_initialization_failed/);
  }
  const typed = await fixture(t);
  await fs.writeFile(join(typed.root, "lab-data"), "not a directory");
  await assert.rejects(typed.start(), /note_initialization_failed/);
  const owner = await fixture(t);
  await assert.rejects(owner.start({ uid: process.geteuid() + 1 }), /note_initialization_failed/);
  assert.deepEqual(await fs.readdir(owner.root), []);
});

test("symlink collisions at the actual open never follow or modify the target", linuxOnly, async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside.txt");
  await fs.writeFile(outside, "untouched");
  const io = { ...storageIO, async open(path, flags, mode) {
    if (NOTE_NAME.test(String(path).split("/").at(-1))) await fs.symlink(outside, path);
    return storageIO.open(path, flags, mode);
  } };
  const notes = await f.start({ io });
  assert.equal((await notes.write("new content")).isError, true);
  assert.equal(await fs.readFile(outside, "utf8"), "untouched");
  assert.ok((await fs.lstat(join(f.notesPath, (await fs.readdir(f.notesPath))[0]))).isSymbolicLink());
});

test("quota includes previous sessions and concurrent reservations; second processes are excluded", linuxOnly, async (t) => {
  const f = await fixture(t);
  const notes = await f.start();
  const file = await fs.open(join(f.notesPath, `note-${randomUUID()}.txt`), "wx", 0o600);
  await file.truncate(NOTE_QUOTA - 1); // Sparse fixture, not a fluctuating metric.
  await file.close();
  const results = await Promise.all([notes.write("x"), notes.write("y")]);
  assert.equal(results.filter((r) => !r.isError).length, 1);
  assert.ok(results.some((r) => /quota/.test(text(r))));
  await assert.rejects(f.start(), /note_initialization_failed/);
  await notes.close();
  const restarted = await f.start();
  assert.match(text(await restarted.write("z")), /quota/);
});

test("unsupported platforms/filesystems and unsafe existing note entries fail closed", linuxOnly, async (t) => {
  const platform = await fixture(t);
  await assert.rejects(platform.start({ platform: "darwin" }), /note_initialization_failed/);
  assert.deepEqual(await fs.readdir(platform.root), []);
  const network = await fixture(t);
  await assert.rejects(network.start({ io: { ...storageIO, async statfs() { return { type: 0x6969n }; } } }), /note_initialization_failed/);
  assert.deepEqual(await fs.readdir(network.root), []);
  for (const kind of ["directory", "symlink", "hardlink", "public-file"]) {
    const f = await fixture(t);
    const notes = await f.start();
    const path = join(f.notesPath, `note-${randomUUID()}.txt`);
    if (kind === "directory") await fs.mkdir(path);
    else if (kind === "symlink") await fs.symlink(f.root, path);
    else if (kind === "hardlink") {
      const target = join(f.root, "target");
      await fs.writeFile(target, "keep", { mode: 0o600 });
      await fs.link(target, path);
    } else {
      await fs.writeFile(path, "public");
      await fs.chmod(path, 0o644);
    }
    assert.match(text(await notes.write("denied")), /unsafe/);
  }
});

// Faults are injected at the filesystem boundary, not by altering OS permissions
// or dependency internals. Bind real handle methods to preserve private fields.
function proxyFile(file, overrides) {
  return new Proxy(file, { get(target, key) {
    if (key in overrides) return overrides[key];
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("note write failures safely remove only the new file and sanitize errors", linuxOnly, async (t) => {
  const f = await fixture(t);
  const io = { ...storageIO, async open(path, flags, mode) {
    const file = await storageIO.open(path, flags, mode);
    if (!String(path).endsWith(".txt")) return file;
    return proxyFile(file, { async writeFile() { await file.writeFile("partial"); throw new Error("SECRET /private/path"); } });
  } };
  const notes = await f.start({ io });
  const result = await notes.write("sensitive note");
  assert.equal(result.isError, true);
  assert.deepEqual(await fs.readdir(f.notesPath), []);
  assert.ok(!JSON.stringify(await auditEvents(f)).includes("SECRET"));
  assert.ok(!text(result).includes("/private"));
});

test("required audit failure before creation blocks all writes", linuxOnly, async (t) => {
  const f = await fixture(t);
  const io = { ...storageIO, async open(path, flags, mode) {
    const file = await storageIO.open(path, flags, mode);
    return String(path).endsWith(".jsonl") ? proxyFile(file, { async writeFile() { throw new Error("AUDIT SECRET"); } }) : file;
  } };
  const notes = await f.start({ io });
  assert.match(text(await notes.write("one")), /auditing/);
  assert.match(text(await notes.write("two")), /auditing/);
  assert.deepEqual(await fs.readdir(f.notesPath), []);
  assert.ok(!f.diagnostics.join("").includes("AUDIT SECRET"));
});

test("post-creation audit failure explicitly reports uncertainty and disables subsequent writes", linuxOnly, async (t) => {
  const f = await fixture(t);
  let records = 0;
  const io = { ...storageIO, async open(path, flags, mode) {
    const file = await storageIO.open(path, flags, mode);
    if (!String(path).endsWith(".jsonl")) return file;
    return proxyFile(file, { async writeFile(...args) {
      if (++records === 2) throw new Error("completion failed");
      return file.writeFile(...args);
    } });
  } };
  const notes = await f.start({ io });
  assert.match(text(await notes.write("created once")), /created but.*could not be confirmed/);
  assert.match(text(await notes.write("do not create")), /auditing/);
  const files = await fs.readdir(f.notesPath);
  assert.equal(files.length, 1);
  assert.equal(await fs.readFile(join(f.notesPath, files[0]), "utf8"), "created once");
  assert.equal((await auditEvents(f)).length, 1);
  assert.ok(f.diagnostics.some((line) => JSON.parse(line).outcome === "uncertain"));
});

test("write queue is bounded; overload is denied and audited", linuxOnly, async (t) => {
  const f = await fixture(t);
  const notes = await f.start();
  const results = await Promise.all(Array.from({ length: 20 }, () => notes.write("queued")));
  assert.equal(results.filter((result) => !result.isError).length, 16);
  assert.equal(results.filter((result) => /busy/.test(text(result))).length, 4);
  assert.equal((await auditEvents(f)).filter((event) => event.reason === "busy").length, 4);
});

test("cleanup failure is explicit and disables the service without deleting other files", linuxOnly, async (t) => {
  const f = await fixture(t);
  const io = { ...storageIO,
    async open(path, flags, mode) {
      const file = await storageIO.open(path, flags, mode);
      if (!String(path).endsWith(".txt")) return file;
      return proxyFile(file, { async writeFile() { await file.writeFile("partial"); throw new Error("write failed"); } });
    },
    async unlink(path) {
      if (String(path).endsWith(".txt")) throw new Error("cleanup failed");
      return storageIO.unlink(path);
    },
  };
  const notes = await f.start({ io });
  assert.match(text(await notes.write("original")), /partial note may remain/);
  assert.equal((await fs.readdir(f.notesPath)).length, 1);
  assert.match(text(await notes.write("another")), /No further writes/);
});

test("OS permission and audit-sync failures are handled without raw details", linuxOnly, async (t) => {
  const denied = await fixture(t);
  const deniedIO = { ...storageIO, async open(path, flags, mode) {
    if (String(path).endsWith(".txt")) throw Object.assign(new Error("private EACCES path"), { code: "EACCES" });
    return storageIO.open(path, flags, mode);
  } };
  const notes = await denied.start({ io: deniedIO });
  assert.match(text(await notes.write("denied")), /could not be created/);
  assert.deepEqual(await fs.readdir(denied.notesPath), []);
  assert.ok(!JSON.stringify(await auditEvents(denied)).includes("EACCES"));

  const sync = await fixture(t);
  const syncIO = { ...storageIO, async open(path, flags, mode) {
    const file = await storageIO.open(path, flags, mode);
    return String(path).endsWith(".jsonl") ? proxyFile(file, { async sync() { throw new Error("sync failed"); } }) : file;
  } };
  const service = await sync.start({ io: syncIO });
  assert.match(text(await service.write("must not create")), /auditing/);
  assert.deepEqual(await fs.readdir(sync.notesPath), []);
});

test("stale locks fail closed and shutdown is idempotent", linuxOnly, async (t) => {
  const f = await fixture(t);
  const notes = await f.start();
  await Promise.all([notes.close(), notes.close()]);
  await fs.writeFile(join(f.root, "lab-data", ".note-writer.lock"), "stale", { mode: 0o600 });
  await assert.rejects(f.start(), /note_initialization_failed/);
  assert.equal(await fs.readFile(join(f.root, "lab-data", ".note-writer.lock"), "utf8"), "stale");
});

test("post-start directory and audit permission changes stop note creation", linuxOnly, async (t) => {
  for (const target of ["notes", "audit-file"]) {
    const f = await fixture(t);
    const notes = await f.start();
    if (target === "notes") await fs.chmod(f.notesPath, 0o755);
    else await fs.chmod(join(f.auditPath, (await fs.readdir(f.auditPath))[0]), 0o644);
    const result = await notes.write("must not create");
    assert.equal(result.isError, true);
    assert.deepEqual(await fs.readdir(f.notesPath), []);
  }
});

test("an unavailable disabled-mode diagnostic sink still denies without creating storage", async (t) => {
  const f = await fixture(t);
  const notes = await f.start({ enabled: false, diagnostic: async () => { throw new Error("stderr unavailable"); } });
  assert.match(text(await notes.write("denied")), /auditing/);
  assert.deepEqual(await fs.readdir(f.root), []);
});
