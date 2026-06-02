import z from "zod";

import { defineTool } from "@/foundation";

import { errorToolResult, okToolResult } from "./tool-result";
import { resolveAbsolutePath } from "./tool-utils";

export const strReplaceTool = defineTool({
  name: "str_replace",
  description: "Replace occurrences of a substring in a file. Make sure the `old` is unique in the file.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to perform this replacement. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute path to the file to operate on."),
    old: z.string().describe("The substring to replace."),
    new: z.string().describe("The substring to be replaced with."),
    count: z
      .number()
      .int()
      .nonnegative()
      .describe("Maximum number of replacements. Omit to replace all occurrences.")
      .optional(),
  }),
  invoke: async ({ path, old, new: replacement, count }) => {
    const resolved = resolveAbsolutePath(path);
    if (!resolved.ok) {
      return errorToolResult(resolved.error, "INVALID_PATH", { path });
    }
    const filePath = resolved.path;

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return errorToolResult(`File ${filePath} does not exist.`, "FILE_NOT_FOUND", { path: filePath });
    }

    if (old.length === 0) {
      return errorToolResult("`old` must be a non-empty string.", "INVALID_ARGUMENT", { path: filePath });
    }

    const text = await file.text();

    const maxReplacements = count ?? Number.POSITIVE_INFINITY;
    if (maxReplacements === 0) {
      return okToolResult(`No replacements requested (count=0) in ${filePath}`, {
        path: filePath,
        replacements: 0,
        changed: false,
      });
    }

    // Count actual occurrences up to the limit
    let replacements = 0;
    let idx = 0;
    while (replacements < maxReplacements) {
      const next = text.indexOf(old, idx);
      if (next === -1) break;
      replacements++;
      idx = next + old.length;
    }

    if (replacements === 0) {
      return errorToolResult(`No occurrences of 'old' found in ${filePath}.`, "NOT_FOUND", { path: filePath });
    }

    let updated: string;
    if (count === undefined) {
      updated = text.split(old).join(replacement);
    } else {
      let remaining = count;
      updated = text.replaceAll(old, (match) => {
        if (remaining <= 0) return match;
        remaining--;
        return replacement;
      });
    }

    if (updated === text) {
      return okToolResult(`No effective changes in ${filePath}`, {
        path: filePath,
        replacements: 0,
        changed: false,
      });
    }

    try {
      await file.write(updated);
      return okToolResult(`Replaced ${replacements} occurrence(s) in ${filePath}`, {
        path: filePath,
        replacements,
        changed: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to write replacement to ${filePath}`, "WRITE_FAILED", { path: filePath, message });
    }
  },
});
