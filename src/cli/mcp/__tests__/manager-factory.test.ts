import { describe, expect, test } from "bun:test";

import type { McpServerConnection } from "@/community/mcp";

import { createMcpManagerFromConfig } from "../manager-factory";

function fakeConnection(): McpServerConnection {
  return {
    listTools: async () => [{ name: "search", inputSchema: { type: "object" } }],
    callTool: async () => ({ content: [] }),
    close: async () => undefined,
    setToolListChangedHandler: () => undefined,
  };
}

describe("createMcpManagerFromConfig", () => {
  test("returns undefined when no servers are configured", () => {
    expect(createMcpManagerFromConfig(undefined)).toBeUndefined();
    expect(createMcpManagerFromConfig({})).toBeUndefined();
  });

  test("builds a manager that connects configured servers via the connector", async () => {
    const manager = createMcpManagerFromConfig(
      { memory: { command: "x" } },
      { connector: async () => fakeConnection() },
    );
    expect(manager).toBeDefined();

    await manager!.connect();
    expect(manager!.getEffectiveTools().map((tool) => tool.name)).toEqual(["mcp_memory_search"]);
  });
});
