import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  McpCallToolResult,
  McpConnector,
  McpHttpServerConfig,
  McpServerConfig,
  McpServerConnection,
  McpStdioServerConfig,
  McpToolDefinition,
} from "./types";

const CLIENT_INFO = { name: "helixent", version: "1.0.0" };

/**
 * Resolves the environment passed to a stdio MCP server process. By default only
 * a minimal safe environment is provided; configured `env` is layered on top, and
 * `inheritEnv` opts into inheriting the full host environment.
 */
export function resolveStdioEnvironment(
  config: McpStdioServerConfig,
  host: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const base = config.inheritEnv ? definedStringEntries(host) : getDefaultEnvironment();
  return { ...base, ...(config.env ?? {}) };
}

/** Resolves remote request headers from static headers and environment-derived headers. */
export function resolveRemoteHeaders(
  config: McpHttpServerConfig,
  host: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  for (const [headerName, envVar] of Object.entries(config.envHeaders ?? {})) {
    const value = host[envVar];
    if (value !== undefined) {
      headers[headerName] = value;
    }
  }
  return headers;
}

/**
 * Builds the stdio server parameters for a stdio MCP server.
 *
 * The child process stderr is discarded so MCP server logs never leak into the
 * parent terminal and corrupt the Ink TUI rendering.
 */
export function buildStdioServerParameters(config: McpStdioServerConfig): StdioServerParameters {
  return {
    command: config.command,
    args: config.args,
    env: resolveStdioEnvironment(config),
    cwd: config.cwd,
    stderr: "ignore",
  };
}

/** Builds the SDK transport for a server configuration entry. */
export function createMcpTransport(config: McpServerConfig): Transport {
  const type = config.type ?? "stdio";
  if (type === "stdio") {
    return new StdioClientTransport(buildStdioServerParameters(config as McpStdioServerConfig));
  }
  const http = config as McpHttpServerConfig;
  const url = new URL(http.url);
  const requestInit = { headers: resolveRemoteHeaders(http) };
  if (type === "streamable_http") {
    return new StreamableHTTPClientTransport(url, { requestInit });
  }
  return new SSEClientTransport(url, { requestInit });
}

/**
 * Default connector backed by the MCP SDK `Client`. Establishes the transport,
 * initializes the client, and exposes a provider-neutral {@link McpServerConnection}.
 */
export const createMcpConnection: McpConnector = async (
  _serverName: string,
  config: McpServerConfig,
): Promise<McpServerConnection> => {
  const transport = createMcpTransport(config);
  let toolListChangedHandler: (() => void) | undefined;
  const client = new Client(CLIENT_INFO, {
    capabilities: {},
    listChanged: {
      tools: { onChanged: () => toolListChangedHandler?.() },
    },
  });
  await client.connect(transport);

  return {
    async listTools(): Promise<McpToolDefinition[]> {
      const response = await client.listTools();
      return response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as McpToolDefinition["inputSchema"],
      }));
    },
    async callTool(toolName, args): Promise<McpCallToolResult> {
      const response = await client.callTool({ name: toolName, arguments: args });
      const content = Array.isArray((response as { content?: unknown }).content)
        ? ((response as { content: McpCallToolResult["content"] }).content)
        : [];
      return { content, isError: (response as { isError?: boolean }).isError };
    },
    async close() {
      await client.close();
    },
    setToolListChangedHandler(handler) {
      toolListChangedHandler = handler;
    },
    instructions: client.getInstructions(),
  };
};

function definedStringEntries(host: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(host)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}
