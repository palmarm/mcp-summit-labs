import { z } from "zod";
import {
  ALLOWED_TOOLS, ControllerError, METRIC_DEFINITIONS, THRESHOLDS,
  type Check, type Failure, type Report, type State, type ToolName,
} from "./model.js";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const utilizationPercent = z.number().min(0).max(100);
const system = z.object({
  platform: z.string().min(1), architecture: z.string().min(1),
  kernelRelease: z.string().min(1), hostname: z.string().min(1), nodeVersion: z.string().min(1),
});
const memory = z.object({ totalBytes: bytes, usedBytes: bytes, freeBytes: bytes, utilizationPercent });
const disk = z.object({ path: z.string().min(1), totalBytes: bytes, usedBytes: bytes, availableBytes: bytes, utilizationPercent });
const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional() });

export function utilizationState(percent: number): State {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return "unknown";
  if (percent >= THRESHOLDS.criticalPercent) return "critical";
  return percent >= THRESHOLDS.warningPercent ? "warning" : "healthy";
}

export function evaluateTool(name: ToolName, raw: unknown): Check {
  const result = envelope.safeParse(raw);
  if (!result.success) throw new ControllerError("validation");
  // isError is authoritative; never parse an error's human-readable text as metrics.
  if (result.data.isError) throw new ControllerError("tool");
  const value: unknown = result.data.structuredContent;
  if (name === "system_info") {
    if (!system.safeParse(value).success) throw new ControllerError("validation");
    return { tool: name, state: "healthy" }; // Validate but omit all host identity strings.
  }
  const parsed = (name === "memory_usage" ? memory : disk).safeParse(value);
  if (!parsed.success) throw new ControllerError("validation");
  const data = parsed.data;
  const expected = data.totalBytes === 0 ? 0 : data.usedBytes / data.totalBytes * 100;
  if (data.usedBytes > data.totalBytes || Math.abs(expected - data.utilizationPercent) > 1e-7 ||
      ("freeBytes" in data && data.usedBytes !== data.totalBytes - data.freeBytes) ||
      ("availableBytes" in data && data.availableBytes > data.totalBytes - data.usedBytes)) {
    throw new ControllerError("validation");
  }
  // Explicit projection prevents paths, extra fields, or raw tool text entering reports.
  const metric = {
    totalBytes: data.totalBytes, usedBytes: data.usedBytes, utilizationPercent: data.utilizationPercent,
    ...("freeBytes" in data ? { freeBytes: data.freeBytes } : { availableBytes: data.availableBytes }),
  };
  return { tool: name, state: data.totalBytes === 0 ? "unknown" : utilizationState(data.utilizationPercent), metric };
}

// Shared deterministic authority for both CLI clients. Missing checks fail closed.
export function evaluateReadiness(checks: Check[], failures: Failure[], source: string): Report {
  const complete = ALLOWED_TOOLS.every((tool) => checks.filter((check) => check.tool === tool).length === 1);
  const states = checks.map((check) => check.state);
  const state = !complete || failures.length || states.includes("unknown") ? "unknown"
    : states.includes("critical") ? "critical" : states.includes("warning") ? "warning" : "healthy";
  return {
    version: 1, source, state,
    exitCode: state === "unknown" ? 2 : state === "critical" ? 1 : 0,
    thresholds: THRESHOLDS, metricDefinitions: METRIC_DEFINITIONS, checks, failures,
  };
}
