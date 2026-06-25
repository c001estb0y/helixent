import { describe, expect, test } from "bun:test";

import { McpManager } from "../mcp-manager";
import type { McpCallToolResult, McpServerConnection, McpToolDefinition } from "../types";

interface FakeConnectionOptions {
  tools: McpToolDefinition[];
  onCall?: (
    // eslint-disable-next-line no-unused-vars
    toolName: string,
    // eslint-disable-next-line no-unused-vars
    args: Record<string, unknown>,
  ) => Promise<McpCallToolResult> | McpCallToolResult;
}

class FakeConnection implements McpServerConnection {
  tools: McpToolDefinition[];
  listToolsCalls = 0;
  callLog: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  closed = false;
  private _handler?: () => void;
  private readonly _onCall?: FakeConnectionOptions["onCall"];

  constructor(options: FakeConnectionOptions) {
    this.tools = options.tools;
    this._onCall = options.onCall;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    this.listToolsCalls++;
    return this.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
    this.callLog.push({ toolName, args });
    if (this._onCall) return this._onCall(toolName, args);
    return { content: [{ type: "text", text: `called ${toolName}` }] };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  setToolListChangedHandler(handler: () => void): void {
    this._handler = handler;
  }

  emitToolListChanged() {
    this._handler?.();
  }
}

describe("McpManager.connect", () => {
  test("fills a per-server tool snapshot and exposes mcp_<server>_<tool> tools", async () => {
    const connection = new FakeConnection({
      tools: [
        {
          name: "search",
          description: "Search memory",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      ],
    });
    const manager = new McpManager(
      { memory: { command: "x" } },
      { connector: async () => connection },
    );

    await manager.connect();

    expect(connection.listToolsCalls).toBe(1);
    const tools = manager.getEffectiveTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("mcp_memory_search");
    expect(tools[0]!.parameters).toMatchObject({
      kind: "json-schema",
      jsonSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    });
  });

  test("throws when a required server fails to connect but skips optional failures", async () => {
    const optional = new McpManager(
      { bad: { command: "x" } },
      { connector: async () => { throw new Error("boom"); } },
    );
    await optional.connect();
    expect(optional.getEffectiveTools()).toHaveLength(0);

    const required = new McpManager(
      { bad: { command: "x", required: true } },
      { connector: async () => { throw new Error("boom"); } },
    );
    await expect(required.connect()).rejects.toThrow(/bad/);
  });
});

describe("McpManager binding and approval", () => {
  test("routes a call through the binding to the original server tool", async () => {
    const connection = new FakeConnection({
      tools: [{ name: "search", inputSchema: { type: "object" } }],
    });
    const manager = new McpManager(
      { memory: { command: "x" } },
      { connector: async () => connection },
    );
    await manager.connect();

    const result = await manager.callTool("mcp_memory_search", { query: "hi" });

    expect(connection.callLog).toEqual([{ toolName: "search", args: { query: "hi" } }]);
    expect(result).toMatchObject({ ok: true, summary: "called search" });
  });

  test("requires approval by default and honors autoApprove", async () => {
    const connection = new FakeConnection({ tools: [{ name: "search", inputSchema: { type: "object" } }] });
    const requireApproval = new McpManager(
      { memory: { command: "x" } },
      { connector: async () => connection },
    );
    await requireApproval.connect();
    expect(requireApproval.requiresApproval("mcp_memory_search")).toBe(true);

    const autoConnection = new FakeConnection({ tools: [{ name: "search", inputSchema: { type: "object" } }] });
    const autoApprove = new McpManager(
      { memory: { command: "x", autoApprove: true } },
      { connector: async () => autoConnection },
    );
    await autoApprove.connect();
    expect(autoApprove.requiresApproval("mcp_memory_search")).toBe(false);
  });
});

describe("McpManager scheduling", () => {
  test("serializes tool calls against the same server by default", async () => {
    let active = 0;
    let maxActive = 0;
    const connection = new FakeConnection({
      tools: [{ name: "work", inputSchema: { type: "object" } }],
      onCall: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    const manager = new McpManager(
      { memory: { command: "x" } },
      { connector: async () => connection },
    );
    await manager.connect();

    await Promise.all([
      manager.callTool("mcp_memory_work", {}),
      manager.callTool("mcp_memory_work", {}),
      manager.callTool("mcp_memory_work", {}),
    ]);

    expect(maxActive).toBe(1);
  });
});

describe("McpManager tool list refresh", () => {
  test("replaces the snapshot on list_changed and keeps the old snapshot on refresh failure", async () => {
    let listCall = 0;
    const connection = new FakeConnection({ tools: [{ name: "search", inputSchema: { type: "object" } }] });
    connection.listTools = async () => {
      listCall++;
      if (listCall === 1) return [{ name: "search", inputSchema: { type: "object" } }];
      if (listCall === 2) return [{ name: "search", inputSchema: { type: "object" } }, { name: "create", inputSchema: { type: "object" } }];
      throw new Error("refresh failed");
    };
    const manager = new McpManager(
      { memory: { command: "x" } },
      { connector: async () => connection },
    );
    await manager.connect();
    expect(manager.getEffectiveTools().map((t) => t.name)).toEqual(["mcp_memory_search"]);

    connection.emitToolListChanged();
    await manager.whenIdle();
    expect(manager.getEffectiveTools().map((t) => t.name).sort()).toEqual([
      "mcp_memory_create",
      "mcp_memory_search",
    ]);

    connection.emitToolListChanged();
    await manager.whenIdle();
    expect(manager.getEffectiveTools().map((t) => t.name).sort()).toEqual([
      "mcp_memory_create",
      "mcp_memory_search",
    ]);
  });
});
