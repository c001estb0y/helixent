import type { AssistantMessage, AssistantMessageContent, TokenUsage } from "@/foundation";

import { getReasoningContent, type OpenAIChatCompletionChunk } from "./types";

function toTokenUsage(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}) {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

export class StreamAccumulator {
  private reasoningContent = "";
  private textContent = "";
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage: TokenUsage | undefined;
  private finishReason: string | null | undefined;

  push(chunk: OpenAIChatCompletionChunk): void {
    const delta = chunk.choices[0]?.delta;
    const finishReason = chunk.choices[0]?.finish_reason;
    if (finishReason !== undefined) {
      this.finishReason = finishReason;
    }

    if (delta) {
      // Reasoning / thinking content
      const reasoning = getReasoningContent(delta);
      if (reasoning) {
        this.reasoningContent += reasoning;
      }

      // Text content
      if (typeof delta.content === "string") {
        this.textContent += delta.content;
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let entry = this.toolCalls.get(tc.index);
          if (!entry) {
            entry = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
            this.toolCalls.set(tc.index, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }

    // Usage arrives on the final chunk (choices is empty)
    if (chunk.usage) {
      this.usage = toTokenUsage(chunk.usage);
    }
  }

  snapshot(): AssistantMessage {
    const content: AssistantMessageContent = [];

    if (this.reasoningContent) {
      content.push({ type: "thinking", thinking: this.reasoningContent });
    }
    if (this.textContent) {
      content.push({ type: "text", text: this.textContent });
    }

    // Sort by index to preserve order
    const sorted = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    const isFinal = this.usage !== undefined;
    for (const [, tc] of sorted) {
      let input: Record<string, unknown> = {};
      let parsed = false;
      try {
        input = JSON.parse(tc.arguments);
        parsed = true;
      } catch {
        // arguments JSON is still streaming — fall through
      }
      // During streaming (non-final snapshots) we intentionally withhold
      // a tool_use entry until its arguments parse successfully, so
      // downstream consumers (e.g. agent progress events) never observe
      // a half-formed payload. On the final snapshot we fall back to the
      // best-effort empty object to preserve the previous contract.
      if (!parsed && !isFinal) continue;
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }

    return {
      role: "assistant",
      content,
      usage: this.usage,
      finishReason: this.finishReason,
      ...(this.usage ? {} : { streaming: true }),
    };
  }
}
