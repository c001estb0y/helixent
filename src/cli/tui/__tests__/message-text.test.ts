import { describe, expect, test } from "bun:test";

import type { AssistantMessage } from "@/foundation";

import { messageToPlainText } from "../message-text";

describe("messageToPlainText", () => {
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

    const output = messageToPlainText(message);

    expect(output).toContain("Read file");
    expect(output).toContain("C:/demo/SKILL.md");
    expect(output).not.toContain("undefined");
  });
});
