import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { McpManager } from "../mcp-manager";
import { createMcpConnection } from "../transport";

const FIXTURE = join(import.meta.dir, "fixtures", "echo-mcp-server.ts");

describe("stdio MCP acceptance", () => {
  test("connects to a stdio MCP server, fills the snapshot, and calls a tool", async () => {
    const manager = new McpManager(
      { "agent-memory": { command: "bun", args: [FIXTURE], autoApprove: true } },
      { connector: createMcpConnection },
    );

    await manager.connect();
    try {
      const tools = manager.getEffectiveTools();
      expect(tools.map((tool) => tool.name)).toContain("mcp_agent_memory_echo");

      const echoTool = tools.find((tool) => tool.name === "mcp_agent_memory_echo");
      expect(echoTool?.parameters).toMatchObject({
        kind: "json-schema",
        jsonSchema: { type: "object", properties: { message: { type: "string" } } },
      });

      expect(manager.requiresApproval("mcp_agent_memory_echo")).toBe(false);

      const result = await manager.callTool("mcp_agent_memory_echo", { message: "hi" });
      expect(result).toMatchObject({ ok: true, summary: "echo: hi" });
    } finally {
      await manager.close();
    }
  }, 20000);
});
