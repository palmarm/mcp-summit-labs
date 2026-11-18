import { memoryUsage, diskUsage } from "../../dist/monitoring.js";

// Shared deterministic OS-reader inputs for actual SDK stdio and HTTP servers.
export function monitoringReaders(mode = "healthy") {
  return {
    systemInfo: () => ({ platform: "linux", architecture: "x64", kernelRelease: "fixture",
      hostname: "PRIVATE_HOST_SENTINEL", nodeVersion: "fixture" }),
    memoryUsage: () => memoryUsage({ totalmem: () => 1000, freemem: () => mode === "warning" ? 200 : 500 }),
    diskUsage: async () => {
      if (mode === "tool-error") throw new Error("PRIVATE_ERROR_SENTINEL");
      const disk = await diskUsage(async () => ({ bsize: 10n, blocks: 100n,
        bfree: mode === "critical" ? 5n : 50n, bavail: mode === "critical" ? 4n : 40n }));
      return mode === "malformed" ? { ...disk, utilizationPercent: 10 } : disk;
    },
  };
}
