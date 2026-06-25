import { defineJsonSchemaTool, type StructuredToolResult, type Tool } from "@/foundation";

import { normalizeMcpToolResult } from "./result";
import { sanitizeMcpToolSchema } from "./schema-sanitizer";
import { buildMcpToolName } from "./tool-name";
import type {
  McpConnector,
  McpServerConfig,
  McpServerConnection,
  McpServersConfig,
  McpToolBinding,
  McpToolDefinition,
} from "./types";

interface ServerState {
  name: string;
  config: McpServerConfig;
  connection: McpServerConnection;
  snapshot: McpToolDefinition[];
  /** Serial execution chain for tool calls when parallel calls are not allowed. */
  queue: Promise<unknown>;
  refreshing: boolean;
  refreshQueued: boolean;
}

export interface McpManagerOptions {
  connector: McpConnector;
}

/**
 * App-runtime owner of MCP connections and per-server tool snapshots.
 *
 * The manager is created and connected by the CLI/app runtime and passed into
 * turn execution as a runtime dependency. It is not stored on Agent or Session.
 */
export class McpManager {
  private readonly _servers: McpServersConfig;
  private readonly _connector: McpConnector;
  private readonly _states = new Map<string, ServerState>();
  private readonly _bindings = new Map<string, McpToolBinding>();
  private readonly _pendingRefreshes = new Set<Promise<void>>();

  constructor(servers: McpServersConfig, options: McpManagerOptions) {
    this._servers = servers;
    this._connector = options.connector;
  }

  /** Connects all enabled servers and fills their tool snapshots. */
  async connect(): Promise<void> {
    for (const [name, config] of Object.entries(this._servers)) {
      if (config.enabled === false) continue;
      try {
        const connection = await this._connector(name, config);
        const snapshot = await connection.listTools();
        const state: ServerState = {
          name,
          config,
          connection,
          snapshot,
          queue: Promise.resolve(),
          refreshing: false,
          refreshQueued: false,
        };
        this._states.set(name, state);
        connection.setToolListChangedHandler(() => this._scheduleRefresh(name));
        this._rebuildBindings();
      } catch (error) {
        if (config.required) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Required MCP server "${name}" failed to connect: ${message}`, { cause: error });
        }
      }
    }
  }

  /** Returns the effective MCP tools assembled from current per-server snapshots. */
  getEffectiveTools(): Tool[] {
    const tools: Tool[] = [];
    for (const state of this._states.values()) {
      for (const def of state.snapshot) {
        const visibleName = buildMcpToolName(state.name, def.name);
        tools.push(
          defineJsonSchemaTool({
            name: visibleName,
            description: def.description ?? "",
            jsonSchema: sanitizeMcpToolSchema(def.inputSchema),
            invoke: (input, signal) => this.callTool(visibleName, input, signal),
          }),
        );
      }
    }
    return tools;
  }

  /** Whether an MCP tool requires approval before it may run. */
  requiresApproval(visibleName: string): boolean {
    const binding = this._bindings.get(visibleName);
    if (!binding) return true;
    const config = this._states.get(binding.serverName)?.config;
    const autoApprove = config?.autoApprove;
    if (autoApprove === true) return false;
    if (Array.isArray(autoApprove)) return !autoApprove.includes(binding.toolName);
    return true;
  }

  /** Looks up the binding for a Helixent-visible MCP tool name. */
  getBinding(visibleName: string): McpToolBinding | undefined {
    return this._bindings.get(visibleName);
  }

  /** Calls an MCP tool by its Helixent-visible name, routing through the binding. */
  async callTool(
    visibleName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<StructuredToolResult> {
    const binding = this._bindings.get(visibleName);
    if (!binding) {
      return { ok: false, summary: `Unknown MCP tool: ${visibleName}`, error: `Unknown MCP tool: ${visibleName}`, code: "MCP_TOOL_NOT_FOUND" };
    }
    const state = this._states.get(binding.serverName);
    if (!state) {
      return { ok: false, summary: `MCP server not connected: ${binding.serverName}`, error: `MCP server not connected: ${binding.serverName}`, code: "MCP_SERVER_UNAVAILABLE" };
    }

    const run = async (): Promise<StructuredToolResult> => {
      try {
        const result = await state.connection.callTool(binding.toolName, args, signal);
        return normalizeMcpToolResult(binding.serverName, binding.toolName, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, summary: message, error: message, code: "MCP_CALL_FAILED", details: { server: binding.serverName, tool: binding.toolName } };
      }
    };

    if (state.config.allowParallel) {
      return run();
    }
    const chained = state.queue.then(run, run);
    state.queue = chained.catch(() => undefined);
    return chained;
  }

  /** Resolves once all in-flight snapshot refreshes have settled. */
  async whenIdle(): Promise<void> {
    while (this._pendingRefreshes.size > 0) {
      await Promise.all([...this._pendingRefreshes]);
    }
  }

  /** Closes all connections and clears snapshots. */
  async close(): Promise<void> {
    for (const state of this._states.values()) {
      try {
        await state.connection.close();
      } catch {
        // Ignore close errors during shutdown.
      }
    }
    this._states.clear();
    this._bindings.clear();
  }

  private _scheduleRefresh(name: string) {
    const state = this._states.get(name);
    if (!state) return;
    if (state.refreshing) {
      state.refreshQueued = true;
      return;
    }
    state.refreshing = true;
    const promise = this._refreshServer(state).finally(() => {
      this._pendingRefreshes.delete(promise);
    });
    this._pendingRefreshes.add(promise);
  }

  private async _refreshServer(state: ServerState): Promise<void> {
    try {
      const next = await state.connection.listTools();
      state.snapshot = next;
      this._rebuildBindings();
    } catch {
      // Keep the previous snapshot on refresh failure.
    } finally {
      state.refreshing = false;
      if (state.refreshQueued) {
        state.refreshQueued = false;
        this._scheduleRefresh(state.name);
      }
    }
  }

  private _rebuildBindings() {
    this._bindings.clear();
    for (const state of this._states.values()) {
      for (const def of state.snapshot) {
        const visibleName = buildMcpToolName(state.name, def.name);
        this._bindings.set(visibleName, { visibleName, serverName: state.name, toolName: def.name });
      }
    }
  }
}
