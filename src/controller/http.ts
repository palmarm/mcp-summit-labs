import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { DEFAULT_HTTP_URL, HTTP_PROTOCOL_VERSION, HTTP_REQUEST_MS, localHttpUrl } from "../http-policy.js";
import { ControllerError, type OperationsSession } from "./model.js";
import { McpOperationsSession } from "./stdio.js";

// Closing this transport aborts pending fetches; it never stops the independently
// owned HTTP server. Redirects and non-loopback destinations are always refused.
class LocalHttpTransport extends StreamableHTTPClientTransport {
  private readonly lifetime: AbortController;
  constructor(url: URL) {
    const lifetime = new AbortController();
    super(url, {
      requestInit: { redirect: "error", credentials: "omit" },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 100,
        maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      fetch: async (input, init) => {
        const target = new URL(input);
        if (target.href !== url.href) throw new ControllerError("transport");
        const signal = AbortSignal.any([
          lifetime.signal, AbortSignal.timeout(HTTP_REQUEST_MS), ...(init?.signal ? [init.signal] : []),
        ]);
        return fetch(target, { ...init, signal, redirect: "error", credentials: "omit" });
      },
    });
    this.lifetime = lifetime;
  }
  override async close(): Promise<void> { this.lifetime.abort(); await super.close(); }
}

export function createHttpSession(endpoint = DEFAULT_HTTP_URL): OperationsSession {
  let url: URL;
  try { url = localHttpUrl(endpoint); }
  catch { throw new ControllerError("execution"); }
  return new McpOperationsSession(new LocalHttpTransport(url), { protocolVersion: HTTP_PROTOCOL_VERSION });
}
