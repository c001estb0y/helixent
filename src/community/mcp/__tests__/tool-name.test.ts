import { describe, expect, test } from "bun:test";

import { buildMcpToolName } from "../tool-name";

describe("buildMcpToolName", () => {
  test("builds mcp_<server>_<tool> names", () => {
    expect(buildMcpToolName("memory", "search")).toBe("mcp_memory_search");
  });

  test("sanitizes characters that are unsafe for provider tool names", () => {
    expect(buildMcpToolName("agent-memory", "create.entity")).toBe("mcp_agent_memory_create_entity");
  });
});
