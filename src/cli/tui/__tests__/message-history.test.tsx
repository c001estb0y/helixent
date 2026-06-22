import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";

import type { AssistantMessage } from "@/foundation";

import { MessageHistoryItem } from "../components/message-history";

describe("MessageHistoryItem", () => {
  test("renders a fallback title for tool calls without description", () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "read_file",
          input: { path: "C:/demo/SKILL.md" },
        },
      ],
    };

    const output = renderToString(
      <MessageHistoryItem message={message} messageIndex={0} todoSnapshots={new Map()} />,
      { columns: 100 },
    );

    expect(output).toContain("Read file");
    expect(output).toContain("C:/demo/SKILL.md");
    expect(output).not.toContain("undefined");
  });
});
