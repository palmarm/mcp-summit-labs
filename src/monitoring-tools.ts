import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { diskUsage, memoryUsage, systemInfo } from "./monitoring.js";

const bytes = z.number().int().nonnegative();
const utilizationPercent = z.number().min(0).max(100);
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

async function report<T extends Record<string, unknown>>(
  read: () => T | Promise<T>,
  summary: (value: T) => string,
  failureMessage: string,
): Promise<CallToolResult> {
  try {
    const value = await read();
    return {
      structuredContent: value,
      content: [{ type: "text", text: summary(value) }],
    };
  } catch {
    // OS errors can contain paths or other host details. Keep them off the wire.
    return { isError: true, content: [{ type: "text", text: failureMessage }] };
  }
}

export function registerMonitoringTools(
  server: McpServer,
  readers = { systemInfo, memoryUsage, diskUsage },
) {
  server.registerTool("system_info", {
    description: "Read the server's OS platform, architecture, kernel release, hostname, and Node.js version.",
    inputSchema: z.strictObject({}),
    outputSchema: z.object({
      platform: z.string(),
      architecture: z.string(),
      kernelRelease: z.string(),
      hostname: z.string(),
      nodeVersion: z.string(),
    }),
    annotations,
  }, async (): Promise<CallToolResult> => report(readers.systemInfo,
    (v) => `Host ${v.hostname}: ${v.platform} (${v.architecture}), kernel ${v.kernelRelease}, Node.js ${v.nodeVersion}.`,
    "Unable to read system information.",
  ));

  server.registerTool("memory_usage", {
    description: "Read system memory in bytes. Used = total - free; on Linux this includes reclaimable caches and is not application-only usage or MemAvailable.",
    inputSchema: z.strictObject({}),
    outputSchema: z.object({ totalBytes: bytes, freeBytes: bytes, usedBytes: bytes, utilizationPercent }),
    annotations,
  }, async (): Promise<CallToolResult> => report(readers.memoryUsage,
    (v) => `Memory: ${v.usedBytes} of ${v.totalBytes} bytes used (${v.utilizationPercent.toFixed(2)}%); ${v.freeBytes} bytes free. Total minus free includes reclaimable Linux caches.`,
    "Unable to read memory usage.",
  ));

  server.registerTool("disk_usage", {
    description: "Read filesystem usage at the server's fixed working directory. Used = total - all free blocks; available excludes blocks reserved from unprivileged users.",
    inputSchema: z.strictObject({}),
    outputSchema: z.object({ path: z.string(), totalBytes: bytes, availableBytes: bytes, usedBytes: bytes, utilizationPercent }),
    annotations,
  }, async (): Promise<CallToolResult> => report(readers.diskUsage,
    (v) => `Filesystem at ${v.path}: ${v.usedBytes} of ${v.totalBytes} bytes used (${v.utilizationPercent.toFixed(2)}%); ${v.availableBytes} bytes available to unprivileged users. Reserved free blocks are excluded from available bytes, not counted as used.`,
    "Unable to read disk usage.",
  ));
}
