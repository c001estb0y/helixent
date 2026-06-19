import type { Message, NonSystemMessage, TurnContext } from "@/foundation";

import type { PromptContextItem } from "./prompt-context";

export type RenderedPromptMessageSource =
  | "agent_prompt"
  | "prompt_context"
  | "turn_context"
  | "transcript";

export interface RenderedPromptMessage {
  index: number;
  role: Message["role"];
  content: Message["content"];
  source: RenderedPromptMessageSource;
  sourceItemIds?: string[];
  cacheSegment: "stable" | "volatile" | "transcript";
}

export interface PromptAssemblyInput {
  agentPrompt: string;
  promptContextItems: PromptContextItem[];
  turnContext: TurnContext;
  transcriptMessages: NonSystemMessage[];
}

export interface PromptAssemblyResult {
  messages: Message[];
  renderedMessages: RenderedPromptMessage[];
}

/** Renders provider-neutral messages while preserving source boundaries for trace. */
export function renderModelRequest(input: PromptAssemblyInput): PromptAssemblyResult {
  const renderedMessages: RenderedPromptMessage[] = [];

  if (input.agentPrompt) {
    renderedMessages.push(renderedMessage({
      message: { role: "system", content: [{ type: "text", text: input.agentPrompt }] },
      source: "agent_prompt",
      cacheSegment: "stable",
    }));
  }

  for (const item of [...input.promptContextItems].sort((a, b) => a.precedence - b.precedence)) {
    renderedMessages.push(renderedMessage({
      message: {
        role: "user",
        content: [{ type: "text", text: `Context from ${item.sourcePath}:\n\n${item.content}` }],
      },
      source: "prompt_context",
      sourceItemIds: [item.id],
      cacheSegment: "stable",
    }));
  }

  renderedMessages.push(renderedMessage({
    message: {
      role: "user",
      content: [{ type: "text", text: renderTurnContext(input.turnContext) }],
    },
    source: "turn_context",
    cacheSegment: "volatile",
  }));

  for (const message of input.transcriptMessages) {
    renderedMessages.push(renderedMessage({
      message,
      source: "transcript",
      cacheSegment: "transcript",
    }));
  }

  return {
    messages: renderedMessages.map(({ role, content }) => ({ role, content } as Message)),
    renderedMessages: renderedMessages.map((message, index) => ({ ...message, index })),
  };
}

export function renderTurnContext(turnContext: TurnContext) {
  return [
    "Turn context:",
    "",
    `Current date: ${turnContext.currentDate}`,
    `Timezone: ${turnContext.timezone}`,
    `Working directory: ${turnContext.cwd}`,
    `Model: ${turnContext.model}`,
  ].join("\n");
}

function renderedMessage({
  message,
  source,
  sourceItemIds,
  cacheSegment,
}: {
  message: Message;
  source: RenderedPromptMessageSource;
  sourceItemIds?: string[];
  cacheSegment: RenderedPromptMessage["cacheSegment"];
}): RenderedPromptMessage {
  return {
    index: -1,
    role: message.role,
    content: message.content,
    source,
    sourceItemIds,
    cacheSegment,
  };
}
