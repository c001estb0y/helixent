import { rename } from "node:fs/promises";

import z from "zod";

import { defineTool } from "@/foundation";

import { errorToolResult, okToolResult } from "./tool-result";
import { resolveAbsolutePath } from "./tool-utils";

export const movePathTool = defineTool({
  name: "move_path",
  description: "Move or rename a file or directory between absolute paths.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to move the path. Always place `description` as the first parameter."),
    from: z.string().describe("The absolute source path."),
    to: z.string().describe("The absolute target path."),
  }),
  invoke: async ({ from, to }) => {
    const source = resolveAbsolutePath(from);
    if (!source.ok) {
      return errorToolResult(source.error, "INVALID_SOURCE_PATH", { from, to });
    }

    const target = resolveAbsolutePath(to);
    if (!target.ok) {
      return errorToolResult(target.error, "INVALID_TARGET_PATH", { from, to });
    }

    const fromPath = source.path;
    const toPath = target.path;

    try {
      await rename(fromPath, toPath);
      return okToolResult(`Moved path from ${fromPath} to ${toPath}`, { from: fromPath, to: toPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to move path from ${fromPath} to ${toPath}`, "MOVE_FAILED", {
        from: fromPath,
        to: toPath,
        message,
      });
    }
  },
});
