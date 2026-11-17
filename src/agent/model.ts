import { z } from "zod";
import { ALLOWED_TOOLS, isAllowedTool, type Check, type Report, type ToolName } from "../controller/model.js";

export const LIMITS = Object.freeze({ iterations: 4, toolCalls: 6, requestMs: 15_000, runMs: 60_000 });
const MESSAGES = {
  configuration: "Live use requires GEMINI_API_KEY and a valid GEMINI_MODEL identifier; no credentials or model arguments are accepted on the command line.",
  model_unavailable: "The selected model is unavailable or does not support generateContent. Check project access and GEMINI_MODEL; no fallback was attempted.",
  model_quota: "Gemini quota or rate limit exhausted. Check the project's Free tier limits or retry later; no retry or model fallback was attempted.",
  model_auth: "Gemini authentication or project access was denied. Check GEMINI_API_KEY and project access.",
  model_api: "The Gemini request failed. No retry or model fallback was attempted.",
  model_response: "Gemini returned an empty, blocked, incomplete, or unsupported response.",
  model_timeout: "The model request exceeded its time limit.",
  invalid_tool_request: "The model requested a denied tool or invalid arguments; no calls in that batch were executed.",
  agent_limit: "The agent iteration or total tool-call limit was reached.",
  cancelled: "The agent was interrupted or exceeded its run time limit.",
  execution: "The agent could not complete execution.",
} as const;
export type AgentErrorKind = keyof typeof MESSAGES;
export class AgentError extends Error {
  constructor(readonly kind: AgentErrorKind) { super(MESSAGES[kind]); }
}
export type AgentFailure = { kind: AgentErrorKind; message: string };
export function agentFailure(kind: AgentErrorKind): AgentFailure { return { kind, message: MESSAGES[kind] }; }

const requestSchema = z.strictObject({ name: z.string(), args: z.strictObject({}).optional() });
export function validateRequest(raw: unknown): ToolName {
  const result = requestSchema.safeParse(raw);
  if (!result.success || !isAllowedTool(result.data.name)) throw new AgentError("invalid_tool_request");
  return result.data.name;
}

// Only this explicit schema may cross the MCP-to-model boundary.
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const checkSchema = z.strictObject({
  tool: z.enum(ALLOWED_TOOLS), state: z.enum(["healthy", "warning", "critical", "unknown"]),
  metric: z.strictObject({
    totalBytes: bytes, usedBytes: bytes, utilizationPercent: z.number().min(0).max(100),
    freeBytes: bytes.optional(), availableBytes: bytes.optional(),
  }).optional(),
});
export const modelResultSchema = z.strictObject({
  check: checkSchema,
  error: z.enum(["tool", "validation", "protocol"]).optional(),
});
export type ModelResult = z.infer<typeof modelResultSchema>;
export type ToolReply = { name: ToolName; result: ModelResult };
export function modelResult(check: Check, error?: ModelResult["error"]): ModelResult {
  return modelResultSchema.parse({ check, ...(error ? { error } : {}) });
}
export type ModelTurn = { requests: unknown[]; answer?: string };
export interface AgentModel {
  prepare(signal: AbortSignal): Promise<void>;
  next(question: string, replies: readonly ToolReply[], signal: AbortSignal): Promise<ModelTurn>;
  close(): Promise<void>;
}
export type TraceEntry = {
  origin: "model" | "readiness"; iteration: number;
  tool: ToolName | "denied";
  outcome: "ok" | "tool" | "validation" | "protocol" | "transport" | "cancelled" | "execution" | "denied";
};
export type AgentReport = {
  readiness: Report;
  agent: { mode: "mock" | "live"; status: "complete" | "failed"; answer?: string;
    iterations: number; toolCalls: number; trace: TraceEntry[]; failures: AgentFailure[] };
};

// Scrub known credentials and terminal controls. Prompts and opaque model history
// are never included in reports. No environment dump or provider exception is logged.
export function safeText(value: string, secrets: readonly string[] = []): string {
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[REDACTED]");
  return safe.replace(/AIza[\w-]{20,}/g, "[REDACTED]")
    .replace(/\b(?:GEMINI_API_KEY|API_KEY|TOKEN|PASSWORD|SECRET)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .slice(0, 4000);
}

export async function bounded<T>(
  signal: AbortSignal, milliseconds: number, timeout: AgentErrorKind,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const combined = AbortSignal.any([signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), milliseconds);
  let rejectAbort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new AgentError(signal.aborted ? "cancelled" : timeout));
    combined.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    if (combined.aborted) throw new AgentError("cancelled");
    return await Promise.race([action(combined), cancelled]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", rejectAbort);
  }
}
