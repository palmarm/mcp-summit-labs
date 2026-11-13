import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { registerMonitoringTools } from "./monitoring-tools.js";
import { LabNotes, noteWritesEnabled } from "./lab-notes.js";
import { registerNoteTool } from "./note-tools.js";

// 1. Create our MCP server.
const server = new McpServer({
  name: "first-mcp-server",
  version: "1.0.0",
});

// 2. Register our calculator tool.
server.registerTool(
  "add_numbers",
  {
    description: "Add two numbers together",
    inputSchema: {
      a: z.number(),
      b: z.number(),
    },
  },
  async ({ a, b }): Promise<CallToolResult> => {
    const result = a + b;

    return {
      content: [
        {
          type: "text",
          text: `The sum is ${result}`,
        },
      ],
    };
  },
);

// 3. Register our server health tool.
server.registerTool(
  "server_health",
  {
    description: "Return the MCP server status and uptime",
    inputSchema: {},
  },
  async (): Promise<CallToolResult> => {
    const uptimeSeconds = Math.floor(process.uptime());

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "healthy",
            uptimeSeconds,
          }),
        },
      ],
    };
  },
);

// 4. Register the read-only monitoring tools.
registerMonitoringTools(server);

// 5. Connect the server through stdio.
async function main() {
  const notes = await LabNotes.create({ enabled: noteWritesEnabled(process.argv.slice(2)) });
  registerNoteTool(server, notes);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  server.server.onclose = () => { void notes.close().catch(() => console.error("Note writer cleanup failed.")); };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void server.close().catch(() => { process.exitCode = 1; }); });
  }

  try { await server.connect(transport); }
  catch (error) { await notes.close().catch(() => {}); throw error; }

  console.error("MCP server connected through stdio");
}

main().catch(() => {
  console.error("Failed to start MCP server: check startup configuration and trusted note storage.");
  process.exitCode = 1;
});
