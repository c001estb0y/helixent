import { describe, expect, test } from "bun:test";

import { type Message, type Tool, toolParametersToJsonSchema } from "@/foundation";

import {
  buildCompactionSummaryRequest,
  estimateRenderedRequestTokens,
  resolveKnownModelContextWindow,
  selectPreservedTail,
  serializeCompactionSourceMaterial,
} from "../compaction";
import type { SessionMessage } from "../session";

describe("transcript compaction", () => {
  test("resolves only known DeepSeek V4 model context windows", () => {
    expect(resolveKnownModelContextWindow("deepseek-v4-pro")).toEqual({
      model: "deepseek-v4-pro",
      contextWindowTokens: 1_000_000,
      source: "helixent-known-model",
    });
    expect(resolveKnownModelContextWindow("DeepSeek-V4-Flash")).toEqual({
      model: "deepseek-v4-flash",
      contextWindowTokens: 1_000_000,
      source: "helixent-known-model",
    });
    expect(resolveKnownModelContextWindow("deepseek-chat")?.contextWindowTokens).toBe(1_000_000);
    expect(resolveKnownModelContextWindow("deepseek-reasoner")?.contextWindowTokens).toBe(1_000_000);

    expect(resolveKnownModelContextWindow("deepseek-ai/DeepSeek-V3.2")).toBeNull();
    expect(resolveKnownModelContextWindow("my-deepseek-proxy")).toBeNull();
    expect(resolveKnownModelContextWindow("unknown-model")).toBeNull();
  });

  test("estimates full rendered request tokens including tools and images", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "agent prompt" }] },
      { role: "user", content: [{ type: "text", text: "prompt context" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image_url", image_url: { url: "file:///tmp/screenshot.png", detail: "high" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }],
      },
    ];
    const tools = [fakeTool({
      name: "read_file",
      description: "Read a file",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    })];

    const textLikeChars = JSON.stringify(messagesWithoutImagePayloads(messages)).length +
      JSON.stringify(toolSchemaPayloads(tools)).length;

    expect(estimateRenderedRequestTokens({ messages, tools })).toEqual({
      totalTokens: Math.ceil(textLikeChars / 3) + 2_000,
      textTokens: Math.ceil(textLikeChars / 3),
      imageTokens: 2_000,
      imageCount: 1,
    });
  });

  test("serializes compaction source material as provider-neutral transcript evidence", () => {
    const entries: SessionMessage[] = [
      { id: "message-1", message: { role: "user", content: [{ type: "text", text: "看这个截图" }, { type: "image_url", image_url: { url: "file:///tmp/a.png", detail: "high" } }] } },
      {
        id: "message-2",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden reasoning should not be serialized" },
            { type: "text", text: "我先读文件。" },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/a.ts" } },
          ],
        },
      },
      { id: "message-3", message: { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "line 1\nline 2" }] } },
    ];

    const material = serializeCompactionSourceMaterial(entries);

    expect(material).toContain("[MESSAGE message-1 role=user]");
    expect(material).toContain("看这个截图");
    expect(material).toContain("[image_url omitted during transcript compaction: detail=high, url=file:///tmp/a.png]");
    expect(material).toContain("[MESSAGE message-2 role=assistant]");
    expect(material).toContain("我先读文件。");
    expect(material).toContain("[TOOL_USE id=toolu_1 name=read_file]");
    expect(material).toContain(JSON.stringify({ path: "src/a.ts" }, null, 2));
    expect(material).toContain("[MESSAGE message-3 role=tool]");
    expect(material).toContain("[TOOL_RESULT tool_use_id=toolu_1]");
    expect(material).toContain("line 1\nline 2");
    expect(material).not.toContain("hidden reasoning should not be serialized");
  });

  test("selects a contiguous preserved tail from the latest user message through assistant and tool messages", () => {
    const entries: SessionMessage[] = [
      textEntry("message-1", "user", "old request"),
      textEntry("message-2", "assistant", "old answer"),
      textEntry("message-3", "user", "please inspect src/a.ts"),
      {
        id: "message-4",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Reading it now." },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "src/a.ts" } },
          ],
        },
      },
      { id: "message-5", message: { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file contents" }] } },
      textEntry("message-6", "assistant", "The issue is line 12."),
    ];

    const tail = selectPreservedTail(entries);

    expect(tail.entries.map((entry) => entry.id)).toEqual(["message-3", "message-4", "message-5", "message-6"]);
    expect(tail.preservedTailMessageIds).toEqual(["message-3", "message-4", "message-5", "message-6"]);
    expect(tail.compactedMessageIds).toEqual(["message-1", "message-2"]);
  });

  test("expands the preserved tail boundary backward to keep tool pairs complete", () => {
    const entries: SessionMessage[] = [
      textEntry("message-1", "user", "old request"),
      {
        id: "message-2",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "long running command" } }],
        },
      },
      textEntry("message-3", "user", "please continue after interruption"),
      { id: "message-4", message: { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "done" }] } },
      textEntry("message-5", "assistant", "The command finished."),
    ];

    const tail = selectPreservedTail(entries);

    expect(tail.entries.map((entry) => entry.id)).toEqual(["message-2", "message-3", "message-4", "message-5"]);
    expect(tail.compactedMessageIds).toEqual(["message-1"]);
  });

  test("shortens only tool_result content when preserved tail exceeds its budget", () => {
    const entries: SessionMessage[] = [
      textEntry("message-1", "user", "old request"),
      textEntry("message-2", "user", "inspect the huge output"),
      {
        id: "message-3",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "generate huge output" } }],
        },
      },
      {
        id: "message-4",
        message: {
          role: "tool",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: `HEAD-${"x".repeat(4_000)}-TAIL` }],
        },
      },
    ];

    const tail = selectPreservedTail(entries, { targetTokens: 250 });
    const toolResult = tail.entries[2]?.message.content[0];

    expect(tail.aborted).toBe(false);
    expect(tail.entries.map((entry) => entry.id)).toEqual(["message-2", "message-3", "message-4"]);
    expect(tail.entries[0]?.message).toEqual(entries[1]?.message);
    expect(tail.entries[1]?.message).toEqual(entries[2]?.message);
    if (!toolResult || toolResult.type !== "tool_result") {
      throw new Error("Expected a tool_result in the preserved tail");
    }
    const originalToolResult = entries[3]!.message.content[0];
    if (!originalToolResult || originalToolResult.type !== "tool_result") {
      throw new Error("Expected original content to be a tool_result");
    }
    expect(toolResult.content).toContain("tool_result truncated during transcript compaction");
    expect(toolResult.content).toContain("HEAD-");
    expect(toolResult.content).toContain("-TAIL");
    expect(toolResult.content.length).toBeLessThan(originalToolResult.content.length);
  });

  test("aborts preserved tail fitting instead of truncating user or assistant content", () => {
    const entries: SessionMessage[] = [
      textEntry("message-1", "user", "old request"),
      textEntry("message-2", "user", "latest user message that must not be truncated"),
      textEntry("message-3", "assistant", "assistant text ".repeat(1_000)),
    ];

    const tail = selectPreservedTail(entries, { targetTokens: 100 });

    expect(tail.aborted).toBe(true);
    expect(tail.abortReason).toBe("preserved_tail_exceeds_budget_after_tool_result_truncation");
    expect(tail.entries[0]?.message).toEqual(entries[1]?.message);
    expect(tail.entries[1]?.message).toEqual(entries[2]?.message);
  });

  test("builds a no-tools summary request with the Claude Code-style sections and output cap", () => {
    const request = buildCompactionSummaryRequest({
      model: "deepseek-v4-flash",
      modelOptions: { temperature: 0.2, max_tokens: 8_192 },
      compactedInputEstimateTokens: 500_000,
      sourceMaterial: "[MESSAGE message-1 role=user]\n继续实现 compact",
    });

    expect(request.model).toBe("deepseek-v4-flash");
    expect(request.tools).toBeUndefined();
    expect(request.options).toEqual({ temperature: 0.2, max_tokens: 20_000 });
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe("user");
    expect(request.messages[0]?.content[0]?.type).toBe("text");
    const prompt = request.messages[0]?.content[0]?.type === "text" ? request.messages[0].content[0].text : "";
    expect(prompt).toContain("Primary Request and Intent");
    expect(prompt).toContain("Key Technical Concepts");
    expect(prompt).toContain("Files and Code Sections");
    expect(prompt).toContain("Errors and Fixes");
    expect(prompt).toContain("Problem Solving");
    expect(prompt).toContain("All User Messages");
    expect(prompt).toContain("Pending Tasks");
    expect(prompt).toContain("Current Work");
    expect(prompt).toContain("Optional Next Step");
    expect(prompt).toContain("[MESSAGE message-1 role=user]\n继续实现 compact");
  });
});

function textEntry(id: string, role: "user" | "assistant", text: string): SessionMessage {
  return { id, message: { role, content: [{ type: "text", text }] } };
}

function fakeTool({ name, description, schema }: { name: string; description: string; schema: unknown }): Tool {
  return {
    name,
    description,
    parameters: {
      toJSONSchema: () => schema,
    },
    invoke: async () => undefined,
  } as unknown as Tool;
}

function messagesWithoutImagePayloads(messages: Message[]): unknown[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    return {
      ...message,
      content: message.content.map((content) => (
        content.type === "image_url"
          ? { type: "image_url", image_url: { detail: content.image_url.detail } }
          : content
      )),
    };
  });
}

function toolSchemaPayloads(tools: Tool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toolParametersToJsonSchema(tool.parameters),
  }));
}
