import { exists, mkdir } from "node:fs/promises";
import { parse } from "node:path";

import z from "zod";

import { defineTool } from "@/foundation";

import { errorToolResult, okToolResult } from "./tool-result";
import { resolveAbsolutePath } from "./tool-utils";

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Write to a file at an absolute path. Creates parent directories if they do not exist.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to write to the file. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute path to the file to write to."),
    content: z.string().describe("The content to write to the file."),
  }),
  invoke: async ({ path, content }) => {
    const resolved = resolveAbsolutePath(path);
    if (!resolved.ok) {
      return errorToolResult(resolved.error, "INVALID_PATH", { path });
    }
    const filePath = resolved.path;

    try {
      // Ensure parent directory exists
      const parentDir = parse(filePath).dir;
      if (!(await exists(parentDir))) {
        await mkdir(parentDir, { recursive: true });
      }

      const file = Bun.file(filePath);
      await file.write(content);
      return okToolResult(`Successfully wrote ${content.length} chars to ${filePath}`, {
        path: filePath,
        bytes: content.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to write file: ${filePath}`, "WRITE_FAILED", { path: filePath, message });
    }
  },
});
