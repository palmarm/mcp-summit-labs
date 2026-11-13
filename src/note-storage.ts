import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Deliberately exclude network/FUSE/overlay filesystems; there is no unsafe fallback.
const LOCAL_FILESYSTEMS = new Set([0xef53n, 0x58465342n, 0x9123683en, 0x01021994n]);
export const NOTE_QUOTA = 10 * 1024 * 1024;
export const NOTE_NAME = /^note-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/;
export const storageIO = {
  open: fs.open, lstat: fs.lstat, realpath: fs.realpath, mkdir: fs.mkdir,
  statfs: fs.statfs, readdir: fs.readdir, unlink: fs.unlink,
};
export type StorageIO = typeof storageIO;

export class NoteFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

export function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

export function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export function checkPrivateFile(s: Stats, uid: number) {
  if (!s.isFile() || s.uid !== uid || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1) {
    throw new NoteFailure("unsafe_storage");
  }
}

export function exclusiveFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
}

export class NoteStorage {
  readonly root: string;
  readonly data: string;
  readonly notes: string;
  readonly audit: string;
  private directories = new Map<string, Stats>();

  constructor(root: string, readonly uid: number, readonly io: StorageIO) {
    this.root = resolve(root);
    this.data = join(this.root, "lab-data");
    this.notes = join(this.data, "notes");
    this.audit = join(this.data, "audit");
  }

  async initialize(platform: string) {
    if (platform !== "linux" || !Number.isInteger(this.uid) ||
        !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
      throw new NoteFailure("unsupported_environment");
    }
    if (await this.io.realpath(this.root) !== this.root) throw new NoteFailure("unsafe_storage");
    // Trust root-owned ancestors or ancestors owned by this account. Sticky temp
    // directories are allowed: other users cannot rename our owned child there.
    for (let path = this.root; ; path = dirname(path)) {
      const s = await this.io.lstat(path);
      const stickyParent = path !== this.root && (s.mode & 0o1000) !== 0;
      if (!s.isDirectory() || (s.uid !== 0 && s.uid !== this.uid) ||
          ((s.mode & 0o022) !== 0 && !stickyParent)) throw new NoteFailure("unsafe_storage");
      if (path === dirname(path)) break;
    }
    const root = await this.io.lstat(this.root);
    if (root.uid !== this.uid) throw new NoteFailure("unsafe_storage");
    const filesystem = await this.io.statfs(this.root, { bigint: true });
    if (!LOCAL_FILESYSTEMS.has(filesystem.type)) throw new NoteFailure("unsupported_environment");
    this.directories.set(this.root, root);
    for (const path of [this.data, this.notes, this.audit]) {
      try { await this.io.mkdir(path, { mode: 0o700 }); }
      catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
      const s = await this.io.lstat(path);
      if (!s.isDirectory() || s.uid !== this.uid || s.dev !== root.dev ||
          (s.mode & 0o7777) !== 0o700) throw new NoteFailure("unsafe_storage");
      this.directories.set(path, s);
    }
    await this.verify();
  }

  async verify() {
    for (const [path, expected] of this.directories) {
      const actual = await this.io.lstat(path);
      if (!actual.isDirectory() || !sameFile(actual, expected) || actual.uid !== this.uid ||
          actual.mode !== expected.mode) throw new NoteFailure("unsafe_storage");
    }
  }

  async usedBytes(): Promise<number> {
    let total = 0;
    // Count all ordinary files, including an interrupted operation's partial note.
    for (const name of await this.io.readdir(this.notes)) {
      if (!NOTE_NAME.test(name)) throw new NoteFailure("unsafe_storage");
      const s = await this.io.lstat(join(this.notes, name));
      checkPrivateFile(s, this.uid);
      if (!Number.isSafeInteger(s.size)) throw new NoteFailure("unsafe_storage");
      total += s.size;
      if (total > NOTE_QUOTA) throw new NoteFailure("quota_exceeded");
    }
    return total;
  }

  async removeOwned(path: string, expected: Stats) {
    await this.verify();
    const actual = await this.io.lstat(path);
    if (!sameFile(actual, expected)) throw new NoteFailure("unsafe_storage");
    await this.io.unlink(path);
  }
}
