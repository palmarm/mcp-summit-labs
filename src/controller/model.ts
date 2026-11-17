// This is a policy boundary, independent of transport and any future LLM planner.
export const ALLOWED_TOOLS = Object.freeze(["system_info", "memory_usage", "disk_usage"] as const);
export type ToolName = typeof ALLOWED_TOOLS[number];
export function isAllowedTool(name: string): name is ToolName {
  return ALLOWED_TOOLS.some((allowed) => allowed === name);
}

export type State = "healthy" | "warning" | "critical" | "unknown";
export const THRESHOLDS = Object.freeze({ warningPercent: 75, criticalPercent: 90 });
// Match src/monitoring.ts, rather than substituting MemAvailable or df's Use%.
export const METRIC_DEFINITIONS = Object.freeze({
  memory: "100 * (totalBytes - freeBytes) / totalBytes. Includes reclaimable Linux caches; not application-only usage or MemAvailable.",
  disk: "100 * usedBytes / totalBytes at the server working directory. Used is total minus all free blocks. Reserved free blocks are not used; availableBytes excludes reservations for unprivileged users.",
  policy: "Warning >=75%; critical >=90%, using validated unrounded utilizationPercent. Zero capacity is unknown. Any incomplete/failed check or cleanup makes the overall state unknown, even with a known critical resource.",
});

const MESSAGES = {
  tool: "The tool reported an execution error.",
  transport: "The server transport failed or disconnected.",
  protocol: "The MCP request or response was rejected.",
  validation: "The structured tool response is missing, malformed, or inconsistent.",
  discovery: "Required tool discovery failed.",
  execution: "The controller could not complete execution.",
  cleanup: "Server shutdown could not be confirmed.",
  cancelled: "The run was interrupted or exceeded its time limit.",
} as const;
export type FailureKind = keyof typeof MESSAGES;
export class ControllerError extends Error {
  constructor(readonly kind: FailureKind) { super(MESSAGES[kind]); }
}
export type Failure = { kind: FailureKind; message: string; tool?: ToolName };
export function failure(kind: FailureKind, tool?: ToolName): Failure {
  return { kind, message: MESSAGES[kind], ...(tool ? { tool } : {}) };
}
export type UsageMetric = {
  totalBytes: number; usedBytes: number; utilizationPercent: number;
  freeBytes?: number; availableBytes?: number;
};
export type Check = { tool: ToolName; state: State; metric?: UsageMetric };
export type Report = {
  version: 1;
  source: string;
  state: State;
  exitCode: 0 | 1 | 2;
  thresholds: typeof THRESHOLDS;
  metricDefinitions: typeof METRIC_DEFINITIONS;
  checks: Check[];
  failures: Failure[];
};

// Implementations own their lifecycle. No arbitrary tool names or arguments are exposed.
export interface OperationsSession {
  connect(signal: AbortSignal): Promise<void>;
  discover(signal: AbortSignal): Promise<readonly string[]>;
  call(name: ToolName, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
