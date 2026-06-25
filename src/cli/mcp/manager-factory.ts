import { createMcpConnection, McpManager, type McpConnector, type McpServersConfig } from "@/community/mcp";

import type { McpServersEntry } from "../config/schema";

export interface CreateMcpManagerOptions {
  connector?: McpConnector;
}

/**
 * Builds an {@link McpManager} from CLI `mcpServers` configuration.
 *
 * @param mcpServers - The configured MCP servers, if any.
 * @param options - Optional connector override (defaults to the SDK-backed connector).
 * @returns A manager, or `undefined` when no servers are configured.
 */
export function createMcpManagerFromConfig(
  mcpServers: McpServersEntry | undefined,
  options: CreateMcpManagerOptions = {},
): McpManager | undefined {
  if (!mcpServers || Object.keys(mcpServers).length === 0) {
    return undefined;
  }
  return new McpManager(mcpServers as McpServersConfig, {
    connector: options.connector ?? createMcpConnection,
  });
}
