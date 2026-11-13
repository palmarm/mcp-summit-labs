import { type CallToolResult, type McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import { LabNotes, validNoteContent } from "./lab-notes.js";
import { NOTE_NAME } from "./note-storage.js";

const input = z.strictObject({
  content: z.string().min(1).max(8192).refine(validNoteContent, "Invalid plain-text note content"),
});

export function registerNoteTool(server: McpServer, notes: LabNotes) {
  // Public Standard Schema integration: the SDK validates before invoking the
  // handler. Preserve JSON schema conversion, audit rejections, and never give
  // raw Zod issues (which can contain caller-controlled keys) to the SDK logger.
  const auditedInput: StandardSchemaWithJSON<z.input<typeof input>, z.output<typeof input>> = {
    "~standard": {
      ...input["~standard"],
      async validate(value: unknown) {
        const parsed = input.safeParse(value);
        if (parsed.success) return { value: parsed.data };
        const denied = await notes.deny("invalid_input");
        const first = denied.content[0];
        return { issues: [{ message: first?.type === "text" ? first.text : "Invalid note input." }] };
      },
    },
  };
  server.registerTool("write_lab_note", {
    description: "Create a new private plain-text lab note. Requires server startup flag --enable-note-writes; accepts only content (1–8192 UTF-8 bytes). Filenames are server-generated.",
    inputSchema: auditedInput,
    outputSchema: z.strictObject({
      noteId: z.uuid(), filename: z.string().regex(NOTE_NAME),
      bytesWritten: z.number().int().min(1).max(8192),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ content }): Promise<CallToolResult> => notes.write(content));
}
