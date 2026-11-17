import { evaluateReadiness, evaluateTool } from "./evaluator.js";
import {
  ALLOWED_TOOLS, ControllerError, failure,
  type Check, type Failure, type OperationsSession, type Report,
} from "./model.js";

// Cancellation races also bound implementations that do not honor AbortSignal.
async function cancellable<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new ControllerError("cancelled");
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new ControllerError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([action(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function runController(
  session: OperationsSession,
  options: { source?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Report> {
  const checks: Check[] = ALLOWED_TOOLS.map((tool) => ({ tool, state: "unknown" }));
  const failures: Failure[] = [];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
  try {
    await cancellable(signal, () => session.connect(signal)); // SDK initialization + initialized notification.
    const names = await cancellable(signal, () => session.discover(signal));
    const missing = ALLOWED_TOOLS.filter((name) => names.filter((candidate) => candidate === name).length !== 1);
    if (missing.length) {
      for (const name of missing) failures.push(failure("discovery", name));
    } else {
      // Discovery is a preflight gate: no tools run if the complete allowlist is unavailable.
      for (const [index, name] of ALLOWED_TOOLS.entries()) {
        try {
          const raw = await cancellable(signal, () => session.call(name, signal));
          checks[index] = evaluateTool(name, raw);
        } catch (error) {
          const kind = error instanceof ControllerError ? error.kind : "execution";
          failures.push(failure(kind, name));
          if (!["tool", "validation", "protocol"].includes(kind)) break;
        }
      }
    }
  } catch (error) {
    failures.push(failure(error instanceof ControllerError ? error.kind : "execution"));
  } finally {
    clearTimeout(timer);
    // Always close, including failed initialization, discovery, cancellation and tool errors.
    try { await session.close(); }
    catch { failures.push(failure("cleanup")); }
  }
  return evaluateReadiness(checks, failures, options.source ?? "local-stdio");
}
