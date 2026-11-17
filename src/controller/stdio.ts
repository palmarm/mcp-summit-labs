import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  Client, ProtocolError, SdkError, SdkErrorCode, type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { ControllerError, isAllowedTool, type OperationsSession, type ToolName } from "./model.js";

// SDK close ends stdin, then escalates to SIGTERM and SIGKILL. In 2.4.0 it
// returns after the last kill without awaiting child close; confirm reaping too.
export class ConfirmedStdioTransport extends StdioClientTransport {
  private childClosed = false;
  private closePromise?: Promise<void>;

  override async start(): Promise<void> {
    const onclose = this.onclose;
    this.onclose = () => { this.childClosed = true; onclose?.(); };
    await super.start();
  }

  override close(): Promise<void> {
    this.closePromise ??= this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    const pid = this.pid;
    let failed = false;
    try { await super.close(); }
    catch { failed = true; }
    if (pid !== null && !this.childClosed) {
      // Also covers an SDK cleanup failure before it could send SIGKILL.
      try { process.kill(pid, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failed = true;
      }
      const deadline = Date.now() + 2_000;
      while (!this.childClosed && Date.now() < deadline) await delay(10);
      if (!this.childClosed) failed = true;
    }
    if (failed) throw new ControllerError("cleanup");
  }
}

// SDK operations are separate from policy/evaluation, so a later HTTP adapter or
// LLM planner can use the same allowlist and validated reporting boundary.
export class McpOperationsSession implements OperationsSession {
  private readonly client = new Client({ name: "lab4a-operations-controller", version: "1.0.0" }, {
    capabilities: {}, listMaxPages: 16,
  });
  private closing = false;
  private closePromise?: Promise<void>;
  private readonly disconnected: Promise<never>;

  constructor(private readonly transport: Transport) {
    let rejectDisconnected: (error: ControllerError) => void = () => {};
    this.disconnected = new Promise((_, reject) => { rejectDisconnected = reject; });
    void this.disconnected.catch(() => {});
    const disconnected = () => {
      if (!this.closing) rejectDisconnected(new ControllerError("transport"));
    };
    this.client.onerror = disconnected;
    this.client.onclose = disconnected;
  }

  private async request<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new ControllerError("cancelled");
    try { return await Promise.race([action(), this.disconnected]); }
    catch (error) {
      if (signal.aborted) throw new ControllerError("cancelled");
      if (error instanceof ControllerError) throw error;
      if (error instanceof ProtocolError) throw new ControllerError("protocol");
      if (error instanceof SdkError && error.code === SdkErrorCode.InvalidResult) throw new ControllerError("validation");
      if (error instanceof SdkError && error.code === SdkErrorCode.CapabilityNotSupported) throw new ControllerError("discovery");
      throw new ControllerError("transport");
    }
  }

  connect(signal: AbortSignal): Promise<void> {
    // Client.connect performs the MCP initialize/initialized handshake.
    return this.request(signal, () => this.client.connect(this.transport, { signal, timeout: 5_000 }));
  }

  async discover(signal: AbortSignal): Promise<readonly string[]> {
    // SDK 2.4 aggregates pagination with the configured page cap.
    const result = await this.request(signal, () => this.client.listTools({}, { signal, timeout: 5_000 }));
    return result.tools.map((tool) => tool.name);
  }

  call(name: ToolName, signal: AbortSignal): Promise<unknown> {
    // Runtime guard as well as the TypeScript restriction: a planner cannot bypass policy.
    if (!isAllowedTool(name)) throw new ControllerError("execution");
    return this.request(signal, () => this.client.callTool({ name, arguments: {} }, { signal, timeout: 5_000 }));
  }

  close(): Promise<void> {
    this.closing = true;
    this.closePromise ??= this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    try { await this.client.close(); }
    finally { await this.transport.close(); }
  }
}

export function createLocalSession(): OperationsSession {
  // Fixed executable, built entry point, cwd and empty server argument list.
  // No note-write flag, environment inheritance of NODE_OPTIONS, shell or user command.
  const transport = new ConfirmedStdioTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../index.js", import.meta.url))],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    stderr: "ignore",
    maxBufferSize: 1024 * 1024,
  });
  return new McpOperationsSession(transport);
}
