import { ALLOWED_TOOLS, ControllerError, type OperationsSession, type ToolName } from "./model.js";

export const SIMULATIONS = Object.freeze([
  "healthy", "high-memory", "critical-disk", "malformed-output", "missing-tools", "transport-failure", "tool-error",
] as const);
export type Simulation = typeof SIMULATIONS[number];
export function isSimulation(value: string): value is Simulation {
  return SIMULATIONS.some((name) => name === value);
}

// Pure deterministic fixtures: no child process, OS reads, files, or hardware load.
export function createSimulation(mode: Simulation): OperationsSession {
  return {
    async connect() { if (mode === "transport-failure") throw new ControllerError("transport"); },
    async discover() { return mode === "missing-tools" ? ["system_info", "memory_usage"] : ALLOWED_TOOLS; },
    async call(name: ToolName) {
      if (mode === "tool-error" && name === "memory_usage") {
        return { isError: true, content: [{ type: "text", text: "Not included in reports" }] };
      }
      if (mode === "malformed-output" && name === "memory_usage") return { structuredContent: { totalBytes: "invalid" } };
      if (name === "system_info") return { structuredContent: {
        platform: "linux", architecture: "x64", kernelRelease: "fixture", hostname: "fixture", nodeVersion: "fixture",
      } };
      const usedBytes = name === "memory_usage" ? (mode === "high-memory" ? 800 : 500)
        : mode === "critical-disk" ? 950 : 500;
      return { structuredContent: {
        totalBytes: 1000, usedBytes, utilizationPercent: usedBytes / 10,
        ...(name === "memory_usage" ? { freeBytes: 1000 - usedBytes }
          : { path: "/fixture", availableBytes: 1000 - usedBytes - 10 }),
      } };
    },
    async close() {},
  };
}
