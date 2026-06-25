/**
 * Builds the Helixent-visible name for an MCP-discovered tool.
 *
 * The visible name is only for model/UI display; routing must use the stored
 * {@link McpToolBinding} and never parse this name back into server/tool parts.
 *
 * @param serverName - The configured MCP server name.
 * @param toolName - The original MCP tool name.
 * @returns A provider-safe tool name of the form `mcp_<server>_<tool>`.
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeNamePart(serverName)}_${sanitizeNamePart(toolName)}`;
}

function sanitizeNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}
