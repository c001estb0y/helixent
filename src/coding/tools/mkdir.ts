import { mkdir } from "node:fs/promises";

import z from "zod";

import { defineTool } from "@/foundation";

import { errorToolResult, okToolResult } from "./tool-result";
import { resolveAbsolutePath } from "./tool-utils";

export const mkdirTool = defineTool({
  name: "mkdir",
  description: "Create a directory at an absolute path.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to create the directory. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute directory path to create."),
    recursive: z.boolean().describe("Whether to create parent directories recursively.").optional(),
  }),
  invoke: async ({ path, recursive }) => {
    const resolved = resolveAbsolutePath(path);
    if (!resolved.ok) {
      return errorToolResult(resolved.error, "INVALID_PATH", { path });
    }
    const dirPath = resolved.path;

    try {
      await mkdir(dirPath, { recursive: recursive ?? true });
      return okToolResult(`Created directory: ${dirPath}`, { path: dirPath, recursive: recursive ?? true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to create directory: ${dirPath}`, "MKDIR_FAILED", { path: dirPath, message });
    }
  },
});
