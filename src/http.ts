import { startLocalHttpServer } from "./http-server.js";
import { HTTP_PORT, HTTP_PROTOCOL_VERSION } from "./http-policy.js";

const HELP = `Local monitoring MCP HTTP server (Lab 4C)
Usage: node dist/http.js [--port PORT]
Default: http://127.0.0.1:${HTTP_PORT}/mcp (IPv4 loopback only; port 0 selects a free port).
Protocol: ${HTTP_PROTOCOL_VERSION}, stateless createMcpHandler via the official Node adapter.
Legacy HTTP requests are rejected; the existing stdio entry remains unchanged.
Only system_info, memory_usage and disk_usage are registered. Note writes are absent.
Requests without Origin are accepted. A present Origin must exactly match the listener
origin, including scheme and port; invalid/opaque origins receive 403. Host must match
the listener. No proxy headers or CORS configuration are accepted.
Origin checking is not authentication. Local processes can access this endpoint.
This unauthenticated loopback lab endpoint must not be exposed through tunnels,
reverse proxies, public interfaces or port forwarding.
Limits: 64 KiB request bodies, 8 KiB headers, 5s requests. GET/DELETE return 405.
SIGINT/SIGTERM close in-flight exchanges and the listener. No files are written.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(HELP); return; }
  let port = HTTP_PORT;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--port" || !/^(0|[1-9][0-9]{0,4})$/.test(args[1] ?? "")) {
      throw new Error("Invalid startup configuration.");
    }
    port = Number(args[1]);
  }
  const server = await startLocalHttpServer({ port });
  process.stdout.write(`Local MCP HTTP listening at ${server.url}; protocol ${HTTP_PROTOCOL_VERSION}; legacy HTTP rejected.\n`);
  const stop = () => { void server.close().catch(() => { process.exitCode = 2; }); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => {
  console.error("Local MCP HTTP server failed: check arguments and local port availability.");
  process.exitCode = 2;
});
