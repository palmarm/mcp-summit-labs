import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { registerMonitoringTools } from "../../dist/monitoring-tools.js";
import { monitoringReaders } from "./monitoring-readers.mjs";

const server = new McpServer({ name: "transport-equivalence-fixture", version: "1" });
registerMonitoringTools(server, monitoringReaders(process.argv[2]));
await server.connect(new StdioServerTransport());
