import type { JsonSchemaObject } from "@/foundation";

/** The MCP transport selected by a server configuration entry. */
export type McpTransportType = "stdio" | "streamable_http" | "sse";

/** Common policy fields shared by every MCP server configuration entry. */
export interface McpServerPolicy {
  /** Whether the server is connected at startup. Defaults to true. */
  enabled?: boolean;
  /** Whether a connection failure prevents agent execution from starting. Defaults to false. */
  required?: boolean;
  /** Auto-approval policy: `true` for all tools, or a list of original MCP tool names. Defaults to require approval. */
  autoApprove?: boolean | string[];
  /** Whether tool calls against this server may run in parallel. Defaults to false (serial). */
  allowParallel?: boolean;
}

/** Configuration for a stdio MCP server. */
export interface McpStdioServerConfig extends McpServerPolicy {
  type?: "stdio";
  command: string;
  args?: string[];
  /** Extra environment variables layered on top of the minimal safe environment. */
  env?: Record<string, string>;
  cwd?: string;
  /** When true, inherit the full host environment instead of the minimal safe set. Defaults to false. */
  inheritEnv?: boolean;
}

/** Configuration for a remote (HTTP-based) MCP server. */
export interface McpHttpServerConfig extends McpServerPolicy {
  type: "streamable_http" | "sse";
  url: string;
  /** Static request headers. */
  headers?: Record<string, string>;
  /** Map of header name to environment variable name, resolved at connect time. */
  envHeaders?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpServersConfig = Record<string, McpServerConfig>;

/** A tool definition learned from an MCP server's `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchemaObject;
}

/** A single content block in an MCP tool result. */
export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** The result of an MCP `tools/call`. */
export interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/**
 * The connection abstraction the manager talks to. The real implementation wraps
 * the MCP SDK `Client`; tests inject a fake to exercise manager behavior in isolation.
 */
export interface McpServerConnection {
  listTools(): Promise<McpToolDefinition[]>;
  callTool(
    // eslint-disable-next-line no-unused-vars
    toolName: string,
    // eslint-disable-next-line no-unused-vars
    args: Record<string, unknown>,
    // eslint-disable-next-line no-unused-vars
    signal?: AbortSignal,
  ): Promise<McpCallToolResult>;
  close(): Promise<void>;
  // eslint-disable-next-line no-unused-vars
  setToolListChangedHandler(handler: () => void): void;
  /** Optional server-level instructions returned by MCP initialize. */
  instructions?: string;
}

/** Factory that establishes a connection for one configured MCP server. */
// eslint-disable-next-line no-unused-vars
export type McpConnector = (serverName: string, config: McpServerConfig) => Promise<McpServerConnection>;

/** Maps a Helixent-visible MCP tool name back to its origin server and tool name. */
export interface McpToolBinding {
  visibleName: string;
  serverName: string;
  toolName: string;
}
