import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { NoteAudit, stderrDiagnostic } from "./note-audit.js";
import {
  checkPrivateFile, errorCode, exclusiveFlags, NOTE_NAME, NOTE_QUOTA,
  NoteFailure, NoteStorage, storageIO, type StorageIO,
} from "./note-storage.js";

const MAX_PENDING = 16;
const MESSAGES: Record<string, string> = {
  writes_disabled: "Note writes are disabled. Restart with --enable-note-writes to enable them.",
  invalid_input: "Invalid note input. Supply only valid plain-text content of 1–8192 UTF-8 bytes.",
  quota_exceeded: "The note-content quota has been reached.",
  busy: "The note writer is busy. Try again later.",
  closing: "The note writer is closing.",
  unsafe_storage: "The note storage is unavailable or unsafe.",
  audit_unavailable: "Required note auditing is unavailable. No further writes are allowed.",
  already_exists: "The generated note destination already exists. Nothing was overwritten.",
  write_failed: "The note could not be created.",
};

export function noteWritesEnabled(args: readonly string[]): boolean {
  if (args.some((arg) => arg !== "--enable-note-writes") || args.length > 1) {
    throw new NoteFailure("invalid_startup_configuration");
  }
  return args.length === 1;
}

export function validNoteContent(content: string): boolean {
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes >= 1 && bytes <= 8192 && Buffer.from(content, "utf8").toString("utf8") === content &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(content);
}

export type NoteOptions = {
  enabled: boolean;
  root?: string;
  // Internal test seams; none are exposed as MCP arguments or startup flags.
  io?: StorageIO;
  diagnostic?: typeof stderrDiagnostic;
  platform?: string;
  uid?: number;
  noteId?: () => string;
};

export class LabNotes {
  private readonly enabled: boolean;
  private readonly storage: NoteStorage;
  private readonly audit: NoteAudit;
  private readonly diagnostic: typeof stderrDiagnostic;
  private readonly id: () => string;
  private lock?: FileHandle;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing = false;
  private closingPromise?: Promise<void>;
  private failed = false;

  private constructor(options: NoteOptions) {
    this.enabled = options.enabled;
    this.storage = new NoteStorage(options.root ?? process.cwd(), options.uid ?? process.geteuid?.() ?? -1, options.io ?? storageIO);
    this.diagnostic = options.diagnostic ?? stderrDiagnostic;
    this.audit = new NoteAudit(this.storage, this.diagnostic);
    this.id = options.noteId ?? randomUUID;
  }

  static async create(options: NoteOptions): Promise<LabNotes> {
    const notes = new LabNotes(options);
    if (!options.enabled) return notes; // No filesystem calls in disabled mode.
    try {
      await notes.storage.initialize(options.platform ?? process.platform);
      // One writer across processes keeps cumulative quota checks authoritative.
      notes.lock = await notes.storage.io.open(join(notes.storage.data, ".note-writer.lock"), exclusiveFlags(), 0o600);
      checkPrivateFile(await notes.lock.stat(), notes.storage.uid);
      await notes.audit.initialize();
      await notes.storage.usedBytes();
      return notes;
    } catch {
      await notes.close().catch(() => {});
      throw new NoteFailure("note_initialization_failed");
    }
  }

  private result(code: string): CallToolResult {
    return { isError: true, content: [{ type: "text", text: MESSAGES[code] ?? MESSAGES.write_failed! }] };
  }

  async deny(reason: "invalid_input" | "writes_disabled" | "busy" | "closing"): Promise<CallToolResult> {
    try {
      const event = { operationId: randomUUID(), event: "outcome" as const, outcome: "denied" as const, reason };
      if (this.enabled) await this.audit.record(event);
      else await this.diagnostic(JSON.stringify({ timestamp: new Date().toISOString(), tool: "write_lab_note", ...event }) + "\n");
      return this.result(reason);
    } catch { return this.result("audit_unavailable"); }
  }

  async write(content: string): Promise<CallToolResult> {
    // Validate again at the service boundary, independently of the MCP adapter.
    if (!validNoteContent(content)) return this.deny("invalid_input");
    if (!this.enabled) return this.deny("writes_disabled");
    if (this.closing) return this.deny("closing");
    if (this.failed || this.audit.failed) return this.result("audit_unavailable");
    if (this.pending >= MAX_PENDING) return this.deny("busy");
    this.pending++;
    const run = this.tail.then(() => this.createNote(content));
    this.tail = run.then(() => {}, () => {});
    try { return await run; }
    finally { this.pending--; }
  }

  private async createNote(content: string): Promise<CallToolResult> {
    if (this.failed || this.audit.failed) return this.result("audit_unavailable");
    const operationId = randomUUID();
    let file: FileHandle | undefined;
    let path: string | undefined;
    let complete = false;
    let created: Stats | undefined;
    try {
      await this.audit.record({ operationId, event: "attempt" });
      await this.storage.verify();
      const bytesWritten = Buffer.byteLength(content, "utf8");
      if (await this.storage.usedBytes() + bytesWritten > NOTE_QUOTA) throw new NoteFailure("quota_exceeded");
      const noteId = this.id();
      const filename = `note-${noteId}.txt`;
      if (!NOTE_NAME.test(filename)) throw new NoteFailure("write_failed");
      path = join(this.storage.notes, filename);
      file = await this.storage.io.open(path, exclusiveFlags(), 0o600);
      created = await file.stat();
      checkPrivateFile(created, this.storage.uid);
      await file.writeFile(content, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      complete = true;
      await this.audit.record({ operationId, event: "outcome", outcome: "created", noteId });
      return {
        structuredContent: { noteId, filename, bytesWritten },
        content: [{ type: "text", text: `Created ${filename} (${bytesWritten} UTF-8 bytes).` }],
      };
    } catch (error) {
      if (complete) {
        this.failed = true;
        await this.diagnostic(JSON.stringify({ tool: "write_lab_note", operationId, outcome: "uncertain", reason: "completion_audit_failed" }) + "\n").catch(() => {});
        return { isError: true, content: [{ type: "text", text: `The note was created but its completion audit could not be confirmed. Further writes are disabled. Do not retry automatically. Operation: ${operationId}` }] };
      }
      let cleanupFailed = file !== undefined && created === undefined;
      await file?.close().catch(() => { cleanupFailed = true; });
      if (path && created) {
        await this.storage.removeOwned(path, created).catch(() => { cleanupFailed = true; });
      }
      if (cleanupFailed) this.failed = true;
      const code = error instanceof NoteFailure ? error.code : errorCode(error) === "EEXIST" ? "already_exists" : "write_failed";
      try {
        const outcome = ["quota_exceeded", "already_exists", "unsafe_storage"].includes(code) ? "denied" : "failed";
        await this.audit.record({ operationId, event: "outcome", outcome, reason: code });
      } catch { return this.result("audit_unavailable"); }
      if (cleanupFailed) return { isError: true, content: [{ type: "text", text: `The write failed and cleanup could not be confirmed. A partial note may remain; further writes are disabled. Operation: ${operationId}` }] };
      return this.result(code);
    }
  }

  close(): Promise<void> {
    this.closing = true;
    this.closingPromise ??= this.finishClose();
    return this.closingPromise;
  }

  private async finishClose() {
    await this.tail;
    try { await this.audit.close(); }
    finally {
      if (this.lock) {
        const stat = await this.lock.stat();
        await this.lock.close();
        this.lock = undefined;
        await this.storage.removeOwned(join(this.storage.data, ".note-writer.lock"), stat);
      }
    }
  }
}
