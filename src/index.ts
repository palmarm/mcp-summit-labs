import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

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

// 4. Connect the server through stdio.
async function main() {
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error("MCP server connected through stdio");
}

main().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exitCode = 1;
});
