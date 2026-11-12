import * as os from "node:os";
import type { BigIntStatsFs } from "node:fs";
import { statfs } from "node:fs/promises";

export function systemInfo() {
  return {
    platform: os.platform(),
    architecture: os.arch(),
    kernelRelease: os.release(),
    hostname: os.hostname(),
    nodeVersion: process.version,
  };
}

function percentage(used: number, total: number): number {
  return total === 0 ? 0 : (used / total) * 100;
}

function checkBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid or unsupported byte count");
  }
  return value;
}

// Injectable readers allow deterministic tests without changing the host.
export function memoryUsage(read: Pick<typeof os, "totalmem" | "freemem"> = os) {
  const totalBytes = checkBytes(read.totalmem());
  const freeBytes = checkBytes(read.freemem());
  const usedBytes = checkBytes(totalBytes - freeBytes);
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    utilizationPercent: percentage(usedBytes, totalBytes),
  };
}

type DiskStats = Pick<BigIntStatsFs, "bsize" | "blocks" | "bfree" | "bavail">;
type ReadDiskStats = (path: string) => Promise<DiskStats>;

export async function diskUsage(
  read: ReadDiskStats = (path) => statfs(path, { bigint: true }),
) {
  const path = process.cwd();
  const stats = await read(path);
  if (stats.bsize <= 0n || stats.blocks < 0n || stats.bfree < 0n ||
      stats.bfree > stats.blocks || stats.bavail > stats.bfree) {
    throw new Error("Invalid filesystem statistics");
  }
  // Multiply as bigint first, then reject counts that cannot be exact JSON numbers.
  const totalBytes = checkBytes(Number(stats.blocks * stats.bsize));
  const freeBytes = checkBytes(Number(stats.bfree * stats.bsize));
  // Some filesystems report negative availability when over capacity/quota.
  const availableBlocks = stats.bavail < 0n ? 0n : stats.bavail;
  const availableBytes = checkBytes(Number(availableBlocks * stats.bsize));
  const usedBytes = totalBytes - freeBytes;
  return {
    path,
    totalBytes,
    availableBytes,
    usedBytes,
    utilizationPercent: percentage(usedBytes, totalBytes),
  };
}
