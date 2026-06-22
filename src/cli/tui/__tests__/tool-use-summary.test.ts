import { describe, expect, test } from "bun:test";

import type { ToolUseContent } from "@/foundation";

import { getToolUseSummary } from "../tool-use-summary";

describe("getToolUseSummary", () => {
  test("falls back when a known tool call omits description", () => {
    const content: ToolUseContent = {
      type: "tool_use",
      id: "tool-1",
      name: "read_file",
      input: { path: "C:/demo/SKILL.md" },
    };

    expect(getToolUseSummary(content)).toEqual({
      title: "Read file",
      detail: "C:/demo/SKILL.md",
    });
  });

  test("preserves a provided description", () => {
    const content: ToolUseContent = {
      type: "tool_use",
      id: "tool-1",
      name: "bash",
      input: { description: "Query today's session summaries", command: "sqlite3 db.sqlite 'SELECT 1'" },
    };

    expect(getToolUseSummary(content)).toEqual({
      title: "Query today's session summaries",
      detail: "sqlite3 db.sqlite 'SELECT 1'",
    });
  });

  test("does not expose blank descriptions", () => {
    const content: ToolUseContent = {
      type: "tool_use",
      id: "tool-1",
      name: "grep_search",
      input: { description: "   ", path: "src", pattern: "undefined" },
    };

    expect(getToolUseSummary(content)).toEqual({
      title: "Search files",
      detail: "src :: undefined",
    });
  });
});
