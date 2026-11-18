import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler, McpServer, validateHostHeader, validateOriginHeader } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { registerMonitoringTools } from "./monitoring-tools.js";
import { HTTP_BODY_LIMIT, HTTP_HOST, HTTP_PATH, HTTP_PORT, HTTP_PROTOCOL_VERSION, HTTP_REQUEST_MS } from "./http-policy.js";

type MonitoringReaders = Parameters<typeof registerMonitoringTools>[1];

function deny(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close",
    "Cache-Control": "no-store", ...(status === 405 ? { Allow: "POST" } : {}) });
  res.end(message + "\n");
}

export async function startLocalHttpServer(options: {
  port?: number; readers?: MonitoringReaders; requestMs?: number;
} = {}) {
  const port = options.port ?? HTTP_PORT;
  const requestMs = options.requestMs ?? HTTP_REQUEST_MS;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(requestMs) || requestMs <= 0) {
    throw new Error("Invalid local HTTP server configuration.");
  }
  // Fresh instance per exchange; never import the stdio entry or register notes.
  // The SDK owns JSON-RPC, server/discover, metadata/header validation, response
  // shaping, cancellation and teardown. Legacy HTTP traffic is explicitly rejected.
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "local-monitoring-http", version: "1.0.0" }, {
      supportedProtocolVersions: [HTTP_PROTOCOL_VERSION], capabilities: { tools: {} },
    });
    registerMonitoringTools(server, options.readers);
    return server;
  }, { legacy: "reject", maxRequestBodySize: HTTP_BODY_LIMIT, responseMode: "auto", onerror: () => {} });
  const serve = toNodeHandler(handler, { maxRequestBodySize: HTTP_BODY_LIMIT, onerror: () => {} });
  let origin = "";
  let closing = false;
  const http = createServer({ maxHeaderSize: 8192, requestTimeout: requestMs,
    headersTimeout: Math.min(requestMs, 5000), keepAliveTimeout: 1000 }, (req: IncomingMessage, res) => {
    const timeout = setTimeout(() => {
      deny(res, 408, "Request timed out.");
      if (res.headersSent && !res.writableEnded) res.destroy();
      req.destroy();
    }, requestMs);
    res.once("close", () => clearTimeout(timeout));
    res.once("finish", () => clearTimeout(timeout));
    res.setHeader("Cache-Control", "no-store");
    if (req.rawHeaders.length > 128) { deny(res, 431, "Too many headers."); return; }
    // No proxy trust, hostname aliases, or public bind option. Origin checking
    // prevents browser-origin attacks; it is NOT authentication. Other local
    // processes can access this lab endpoint without an Origin header.
    const host = req.headers.host;
    const suppliedOrigin = req.headers.origin;
    if (closing) { deny(res, 503, "Server is shutting down."); return; }
    if (req.socket.remoteAddress !== HTTP_HOST || req.socket.localAddress !== HTTP_HOST ||
        req.headersDistinct.host?.length !== 1 || !validateHostHeader(host, [HTTP_HOST]).ok ||
        host !== new URL(origin).host ||
        ["forwarded", "x-forwarded-host", "x-forwarded-for", "x-forwarded-proto"].some((name) => name in req.headers)) {
      deny(res, 403, "Local endpoint access denied."); return;
    }
    if (suppliedOrigin !== undefined && (req.headersDistinct.origin?.length !== 1 ||
        !validateOriginHeader(suppliedOrigin, [HTTP_HOST]).ok || suppliedOrigin !== origin)) {
      deny(res, 403, "Origin denied."); return;
    }
    if (req.url !== HTTP_PATH) { deny(res, 404, "Endpoint not found."); return; }
    if (req.method !== "POST") { deny(res, 405, "Method not allowed."); return; }
    const length = req.headers["content-length"];
    if (length !== undefined && Number(length) > HTTP_BODY_LIMIT) { deny(res, 413, "Request too large."); return; }
    void serve(req, res).catch(() => { deny(res, 500, "MCP request failed."); });
  });
  // Node silently truncates headers at maxHeadersCount. Retain all headers under
  // the byte cap, then reject excess counts so a late Origin cannot be hidden.
  http.maxHeadersCount = 0;
  http.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, HTTP_HOST, () => { http.off("error", reject); resolve(); });
    });
  } catch {
    await handler.close();
    throw new Error("Local HTTP server could not start.");
  }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Local HTTP listener unavailable.");
  origin = new URL(`http://${HTTP_HOST}:${address.port}`).origin;
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    closePromise ??= (async () => {
      closing = true;
      const stopped = new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
      try { await handler.close(); }
      finally { http.closeAllConnections(); await stopped; }
    })();
    return closePromise;
  }
  return { url: `http://${HTTP_HOST}:${address.port}${HTTP_PATH}`, port: address.port, host: HTTP_HOST, close };
}
