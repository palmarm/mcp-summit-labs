import { evaluateReadiness, evaluateTool } from "../controller/evaluator.js";
import { ALLOWED_TOOLS, ControllerError, failure, isAllowedTool, type Check, type Failure, type OperationsSession, type ToolName } from "../controller/model.js";
import {
  AgentError, agentFailure, bounded, LIMITS, modelResult, safeText, validateRequest,
  type AgentFailure, type AgentModel, type AgentReport, type ModelResult, type ToolReply, type TraceEntry,
} from "./model.js";

export async function runAgent(
  session: OperationsSession, model: AgentModel, question: string,
  options: { mode?: "mock" | "live"; source?: string; signal?: AbortSignal;
    maxIterations?: number; maxToolCalls?: number; requestMs?: number; runMs?: number } = {},
): Promise<AgentReport> {
  const checks = new Map<ToolName, Check>(ALLOWED_TOOLS.map((tool) => [tool, { tool, state: "unknown" }]));
  const attempted = new Set<ToolName>();
  const failures: Failure[] = [];
  const agentFailures: AgentFailure[] = [];
  const trace: TraceEntry[] = [];
  let answer: string | undefined;
  let iterations = 0;
  let toolCalls = 0;
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(), options.runMs ?? LIMITS.runMs);
  const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
  const maxIterations = Math.min(options.maxIterations ?? LIMITS.iterations, LIMITS.iterations);
  const maxCalls = Math.min(options.maxToolCalls ?? LIMITS.toolCalls, LIMITS.toolCalls);
  const modelRequest = <T>(action: (signal: AbortSignal) => Promise<T>) =>
    bounded(signal, options.requestMs ?? LIMITS.requestMs, "model_timeout", action);

  function recordDenied(requests: unknown[]): void {
    // Bound traces for oversized batches too. Only recognized names may be echoed;
    // rejected arguments and arbitrary names can contain credentials or host paths.
    for (const raw of requests.slice(0, LIMITS.toolCalls + 1)) {
      const tool = raw && typeof raw === "object" && "name" in raw &&
        typeof raw.name === "string" && isAllowedTool(raw.name) ? raw.name : "denied";
      trace.push({ origin: "model", iteration: iterations, tool, outcome: "denied" });
    }
  }

  async function read(name: ToolName, origin: TraceEntry["origin"]): Promise<ModelResult> {
    if (toolCalls >= maxCalls) throw new AgentError("agent_limit");
    toolCalls++;
    attempted.add(name);
    const entry: TraceEntry = { origin, iteration: origin === "model" ? iterations : 0, tool: name, outcome: "ok" };
    trace.push(entry);
    try {
      const raw = await bounded(signal, 5_500, "cancelled", (signal) => session.call(name, signal));
      const check = evaluateTool(name, raw);
      checks.set(name, check);
      return modelResult(check);
    } catch (error) {
      const kind = error instanceof ControllerError ? error.kind : error instanceof AgentError ? "cancelled" : "execution";
      entry.outcome = ["tool", "validation", "protocol", "transport", "cancelled"].includes(kind)
        ? kind as TraceEntry["outcome"] : "execution";
      failures.push(failure(kind, name));
      const check: Check = { tool: name, state: "unknown" };
      checks.set(name, check);
      if (kind === "tool" || kind === "validation" || kind === "protocol") return modelResult(check, kind);
      throw error instanceof ControllerError || error instanceof AgentError ? error : new AgentError("execution");
    }
  }

  try {
    if (!question.trim() || question.length > 4000) throw new AgentError("configuration");
    await modelRequest((signal) => model.prepare(signal)); // Metadata access check before server spawn.
    await bounded(signal, 5_500, "cancelled", (signal) => session.connect(signal));
    const names = await bounded(signal, 5_500, "cancelled", (signal) => session.discover(signal));
    const missing = ALLOWED_TOOLS.filter((name) => names.filter((candidate) => candidate === name).length !== 1);
    if (missing.length) {
      for (const name of missing) failures.push(failure("discovery", name));
      throw new ControllerError("discovery");
    }
    let replies: ToolReply[] = [];
    let finished = false;
    while (iterations < maxIterations) {
      iterations++;
      const turn = await modelRequest((signal) => model.next(safeText(question), replies, signal));
      if (!turn || !Array.isArray(turn.requests)) throw new AgentError("model_response");
      if (!turn.requests.length) {
        if (typeof turn.answer !== "string" || !turn.answer.trim()) throw new AgentError("model_response");
        answer = safeText(turn.answer);
        finished = true;
        break;
      }
      if (turn.requests.length + toolCalls > maxCalls) {
        recordDenied(turn.requests);
        throw new AgentError("agent_limit");
      }
      // Validate the entire batch before executing any MCP call. Do not log raw names/arguments.
      let requested: ToolName[];
      try { requested = turn.requests.map(validateRequest); }
      catch {
        recordDenied(turn.requests);
        throw new AgentError("invalid_tool_request");
      }
      replies = [];
      for (const name of requested) replies.push({ name, result: await read(name, "model") });
    }
    if (!finished) throw new AgentError("agent_limit");
    // A question may need one tool, but deployment readiness always needs all three.
    // These additional reads are explicitly labelled, never attributed to the model.
    const remaining = ALLOWED_TOOLS.filter((name) => !attempted.has(name));
    if (remaining.length + toolCalls > maxCalls) throw new AgentError("agent_limit");
    for (const name of remaining) await read(name, "readiness");
  } catch (error) {
    if (error instanceof ControllerError) {
      if (!failures.some((item) => item.kind === error.kind)) failures.push(failure(error.kind));
    } else {
      const kind = error instanceof AgentError ? error.kind : "execution";
      agentFailures.push(agentFailure(kind));
      // Lab 4A's incomplete/execution-failure policy remains authoritative.
      failures.push(failure(kind === "cancelled" ? "cancelled" : "execution"));
    }
  } finally {
    clearTimeout(timer);
    lifetime.abort();
    try { await session.close(); } catch { failures.push(failure("cleanup")); }
    try { await model.close(); } catch { agentFailures.push(agentFailure("execution")); failures.push(failure("execution")); }
  }
  const readiness = evaluateReadiness([...checks.values()], failures, options.source ?? "agent-stdio");
  return { readiness, agent: {
    mode: options.mode ?? "live", status: failures.length || agentFailures.length ? "failed" : "complete",
    ...(answer ? { answer } : {}), iterations, toolCalls, trace, failures: agentFailures,
  } };
}
