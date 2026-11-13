import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { checkPrivateFile, exclusiveFlags, NoteStorage } from "./note-storage.js";

export type AuditEvent = {
  operationId: string;
  event: "attempt" | "outcome";
  outcome?: "created" | "denied" | "failed" | "uncertain";
  reason?: string;
  noteId?: string;
};

export async function stderrDiagnostic(line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stderr.write(line, (error) => error ? reject(error) : resolve());
  });
}

export class NoteAudit {
  private file?: FileHandle;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  failed = false;

  constructor(private storage: NoteStorage, private diagnostic: typeof stderrDiagnostic) {}

  async initialize() {
    const path = join(this.storage.audit, `session-${randomUUID()}.jsonl`);
    this.file = await this.storage.io.open(path, exclusiveFlags(), 0o600);
    checkPrivateFile(await this.file.stat(), this.storage.uid);
  }

  async record(event: AuditEvent) {
    if (this.pending >= 64) {
      this.failed = true;
      throw new Error("audit_unavailable");
    }
    this.pending++;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), tool: "write_lab_note", ...event }) + "\n";
    const next = this.tail.then(async () => {
      if (this.failed) throw new Error("audit_unavailable");
      await this.storage.verify();
      if (!this.file) throw new Error("audit_unavailable");
      checkPrivateFile(await this.file.stat(), this.storage.uid);
      await this.file.writeFile(line, "utf8");
      await this.file.sync();
    });
    this.tail = next.catch(() => { this.failed = true; });
    try { await next; }
    catch {
      // A best-effort fixed diagnostic; never copy the exception or input.
      await this.diagnostic(JSON.stringify({ tool: "write_lab_note", outcome: "denied", reason: "audit_unavailable" }) + "\n").catch(() => {});
      throw new Error("audit_unavailable");
    }
    finally { this.pending--; }
  }

  async close() {
    await this.tail;
    await this.file?.close();
  }
}
