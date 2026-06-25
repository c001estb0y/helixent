import type { StructuredToolResult } from "@/foundation";

import type { McpCallToolResult } from "./types";

/**
 * Normalizes an MCP tool result into a Helixent structured tool result.
 * Text content becomes the model-visible summary; non-text content is retained
 * in structured data with a textual placeholder.
 *
 * @param serverName - The originating MCP server name (for error context).
 * @param toolName - The original MCP tool name (for error context).
 * @param result - The raw MCP tool result.
 * @returns A structured tool result.
 */
export function normalizeMcpToolResult(
  serverName: string,
  toolName: string,
  result: McpCallToolResult,
): StructuredToolResult {
  const textParts: string[] = [];
  const nonTextBlocks: unknown[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else {
      nonTextBlocks.push(block);
      textParts.push(`[${block.type} content omitted]`);
    }
  }
  const summary = textParts.join("\n").trim() || `${toolName} returned no textual content`;

  if (result.isError) {
    return {
      ok: false,
      summary,
      error: summary,
      code: "MCP_TOOL_ERROR",
      details: { server: serverName, tool: toolName },
    };
  }

  return {
    ok: true,
    summary,
    ...(nonTextBlocks.length > 0 ? { data: { content: nonTextBlocks } } : {}),
  };
}
