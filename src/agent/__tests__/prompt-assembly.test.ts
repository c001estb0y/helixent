import { describe, expect, test } from "bun:test";

import { renderModelRequest } from "../prompt-assembly";
import { definePromptContextItem } from "../prompt-context";

describe("renderModelRequest", () => {
  test("renders stable prompt context before volatile turn context and transcript with source mappings", () => {
    const promptContextItem = definePromptContextItem({
      id: "project-rules",
      kind: "project_instructions",
      sourcePath: "AGENTS.md",
      scope: "project",
      precedence: 0,
      content: "Use Bun.",
    });

    const rendered = renderModelRequest({
      agentPrompt: "You are Helixent.",
      promptContextItems: [promptContextItem],
      turnContext: {
        currentDate: "2026-06-12",
        timezone: "Asia/Shanghai",
        cwd: "E:\\Github\\helixent\\helixent",
        model: "fake-model",
      },
      transcriptMessages: [{ role: "user", content: [{ type: "text", text: "Today?" }] }],
    });

    expect(rendered.messages.map((message) => message.role)).toEqual(["system", "user", "user", "user"]);
    expect(rendered.renderedMessages.map((message) => message.source)).toEqual([
      "agent_prompt",
      "prompt_context",
      "turn_context",
      "transcript",
    ]);
    expect(rendered.renderedMessages.map((message) => message.cacheSegment)).toEqual([
      "stable",
      "stable",
      "volatile",
      "transcript",
    ]);
    expect(rendered.renderedMessages[1]).toEqual(expect.objectContaining({
      index: 1,
      sourceItemIds: ["project-rules"],
    }));
    expect(textOf(rendered.messages[2]!)).toContain("Current date: 2026-06-12");
  });
});

function textOf(message: { content: Array<{ type: string; text?: string }> }) {
  const content = message.content[0];
  if (content?.type !== "text" || typeof content.text !== "string") {
    throw new Error("Expected text content");
  }
  return content.text;
}
