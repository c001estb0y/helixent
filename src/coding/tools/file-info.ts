import { stat } from "node:fs/promises";

import z from "zod";

import { defineTool } from "@/foundation";

import { errorToolResult, okToolResult } from "./tool-result";
import { resolveAbsolutePath } from "./tool-utils";

export const fileInfoTool = defineTool({
  name: "file_info",
  description: "Return metadata about a file or directory at an absolute path.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to inspect the path. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute path to inspect."),
  }),
  invoke: async ({ path }) => {
    const resolved = resolveAbsolutePath(path);
    if (!resolved.ok) {
      return errorToolResult(resolved.error, "INVALID_PATH", { path });
    }
    const filePath = resolved.path;

    try {
      const info = await stat(filePath);
      const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
      return okToolResult(`Inspected ${kind}: ${filePath}`, {
        path: filePath,
        kind,
        size: info.size,
        modifiedTime: info.mtime.toISOString(),
        createdTime: info.birthtime.toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to inspect path: ${filePath}`, "STAT_FAILED", { path: filePath, message });
    }
  },
});
