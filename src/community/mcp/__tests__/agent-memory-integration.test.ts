import { existsSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { McpManager } from "../mcp-manager";
import { createMcpConnection } from "../transport";

// Real agent-memory (codebuddy-mem) MCP server. The acceptance is skipped when the
// external project is not present (e.g. CI), and runs for real on a dev machine.
const AGENT_MEMORY_MCP = "E:/Github/agent-memory/dist/servers/mcp-server.js";
const hasAgentMemory = existsSync(AGENT_MEMORY_MCP);

describe("agent-memory MCP acceptance", () => {
  test.skipIf(!hasAgentMemory)(
    "connects to the real agent-memory stdio server, lists tools, and calls a worker-free tool",
    async () => {
      const manager = new McpManager(
        { "agent-memory": { command: "node", args: [AGENT_MEMORY_MCP], autoApprove: true } },
        { connector: createMcpConnection },
      );

      await manager.connect();
      try {
        const toolNames = manager.getEffectiveTools().map((tool) => tool.name);
        // tools/list does not require the worker, so the snapshot must be populated.
        expect(toolNames).toContain("mcp_agent_memory_search");
        expect(toolNames).toContain("mcp_agent_memory_timeline");
        expect(toolNames).toContain("mcp_agent_memory_get_observations");

        // The external JSON Schema survives the sanitizer with its required field intact.
        const searchTool = manager.getEffectiveTools().find((tool) => tool.name === "mcp_agent_memory_search");
        expect(searchTool?.parameters).toMatchObject({
          kind: "json-schema",
          jsonSchema: {
            type: "object",
            properties: expect.objectContaining({ query: expect.objectContaining({ type: "string" }) }),
            required: ["query"],
          },
        });

        // The __IMPORTANT tool is handled locally by the server (no worker needed),
        // so the routed call returns a deterministic, normalized success result.
        const result = await manager.callTool("mcp_agent_memory___IMPORTANT", {});
        expect(result.ok).toBe(true);
        expect(result.summary).toContain("Memory Search Workflow");
      } finally {
        await manager.close();
      }
    },
    30000,
  );
});
