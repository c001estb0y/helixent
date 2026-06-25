import { describe, expect, test } from "bun:test";

import type { AgentContext } from "@/agent";
import type { ToolUseContent } from "@/foundation";

import type { ApprovalDecision } from "../approval-types";
import { createCodingApprovalMiddleware } from "../coding-approval-middleware";

function makeToolUse(name: string): ToolUseContent {
  return { type: "tool_use", id: "tc_1", name, input: {} };
}

const mockAgentContext: AgentContext = { prompt: "", messages: [], tools: [] };

describe("createCodingApprovalMiddleware", () => {
  test("allows tools not in the requiresApproval list", async () => {
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["bash", "write_file"],
      askUser: async () => "deny" as ApprovalDecision,
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("read_file"),
    });

    expect(result).toBeUndefined();
  });

  test("asks user for tools matched by the dynamic requiresApprovalFor predicate", async () => {
    let askedName: string | undefined;
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["bash"],
      requiresApprovalFor: (name) => name.startsWith("mcp_"),
      askUser: async (toolUse) => {
        askedName = toolUse.name;
        return "allow_once" as ApprovalDecision;
      },
    });

    const allowed = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("read_file"),
    });
    expect(allowed).toBeUndefined();
    expect(askedName).toBeUndefined();

    await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("mcp_memory_search"),
    });
    expect(askedName).toBe("mcp_memory_search");
  });

  test("asks user for tools in the requiresApproval list", async () => {
    let asked = false;
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["bash"],
      askUser: async () => {
        asked = true;
        return "allow_once" as ApprovalDecision;
      },
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("bash"),
    });

    expect(asked).toBe(true);
    expect(result).toBeUndefined();
  });

  test("skips approval when tool is in the allow list", async () => {
    let asked = false;
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["bash"],
      askUser: async () => {
        asked = true;
        return "allow_once" as ApprovalDecision;
      },
      approvalPersistence: {
        loadAllowList: async () => new Set(["bash"]),
        persistAllowedTool: async () => {},
      },
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("bash"),
    });

    expect(asked).toBe(false);
    expect(result).toBeUndefined();
  });

  test("returns skip result when user denies", async () => {
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["bash"],
      askUser: async () => "deny" as ApprovalDecision,
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("bash"),
    });

    expect(result).toMatchObject({
      __skip: true,
      result: expect.stringContaining("User denied execution of tool: bash"),
    });
  });

  test("persists tool when user allows always for project", async () => {
    let persistedTool: string | undefined;
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["bash"],
      askUser: async () => "allow_always_project" as ApprovalDecision,
      approvalPersistence: {
        loadAllowList: async () => new Set(),
        persistAllowedTool: async (_cwd, toolName) => {
          persistedTool = toolName;
        },
      },
    });

    await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("bash"),
    });

    expect(persistedTool).toBe("bash");
  });

  test("does not throw when persistence fails on allow_always_project", async () => {
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["bash"],
      askUser: async () => "allow_always_project" as ApprovalDecision,
      approvalPersistence: {
        loadAllowList: async () => new Set(),
        persistAllowedTool: async () => {
          throw new Error("disk full");
        },
      },
    });

    // Should not throw despite persistence error
    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("bash"),
    });

    expect(result).toBeUndefined();
  });

  test("works without approvalPersistence", async () => {
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["bash"],
      askUser: async () => "allow_always_project" as ApprovalDecision,
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      toolUse: makeToolUse("bash"),
    });

    expect(result).toBeUndefined();
  });
});
