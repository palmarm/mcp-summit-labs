// A deterministic protocol peer for client integration tests. Never reads host metrics or writes files.
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "healthy";
const allowed = ["system_info", "memory_usage", "disk_usage"];
let initialized = false;
let discovered = false;
let calls = 0;
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const reject = (id) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "PRIVATE_ERROR_SENTINEL" } }) + "\n");

if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000); // Force the SDK's SIGKILL escalation after stdin EOF.
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === "initialize") {
    if (mode === "stall-init") return;
    if (mode === "close-init") { process.exit(0); }
    send(id, { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  } else if (method === "notifications/initialized") initialized = true;
  else if (method === "tools/list") {
    if (!initialized) return reject(id);
    if (mode === "stall-discovery") return;
    discovered = true;
    let names = mode === "missing-tools" ? allowed.slice(0, 2) : allowed;
    if (mode === "paginated") names = params?.cursor ? allowed.slice(1) : allowed.slice(0, 1);
    send(id, {
      tools: [...names, "write_lab_note"].map((name) => ({
        name, inputSchema: { type: "object", additionalProperties: false },
        ...(mode === "schema-error" && name === "memory_usage" ? {
          outputSchema: { type: "object", required: ["totalBytes"], properties: { totalBytes: { type: "number" } } },
        } : {}),
      })),
      ...(mode === "paginated" && !params?.cursor ? { nextCursor: "page2" } : {}),
    });
  } else if (method === "tools/call") {
    if (!discovered || params.name !== allowed[calls++] || Object.keys(params.arguments).length) return reject(id);
    if (params.name === "memory_usage") {
      if (mode === "transport-failure") { process.exit(0); }
      if (mode === "stall-call") return;
      if (mode === "protocol-error") return reject(id);
      if (mode === "bad-json") { process.stdout.write("not json\n"); return; }
      if (mode === "tool-error") return send(id, { isError: true, content: [{ type: "text", text: "PRIVATE_ERROR_SENTINEL" }] });
      if (mode === "schema-error" || mode === "malformed-output") return send(id, {
        content: [], structuredContent: { totalBytes: "PRIVATE_ERROR_SENTINEL" },
      });
    }
    const structuredContent = params.name === "system_info" ? {
      platform: "linux", architecture: "x64", kernelRelease: "fixture", hostname: "PRIVATE_HOST_SENTINEL", nodeVersion: "fixture",
    } : { totalBytes: 1000, usedBytes: 500, utilizationPercent: 50,
      ...(params.name === "memory_usage" ? { freeBytes: 500 } : { path: "/PRIVATE_PATH_SENTINEL", availableBytes: 400 }),
    };
    send(id, { content: [{ type: "text", text: "PRIVATE_TEXT_SENTINEL" }], structuredContent });
  }
});
