import type { AssistantMessage, NonSystemMessage, ToolUseContent, UserMessage } from "@/foundation";

import { getToolUseSummary } from "./tool-use-summary";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const WHITE = `${ESC}37m`;
const GRAY = `${ESC}90m`;

const white = (s: string) => `${WHITE}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const dim = (s: string) => `${DIM}${GRAY}${s}${RESET}`;

export function messageToPlainText(message: NonSystemMessage): string | null {
  switch (message.role) {
    case "user":
      return userMessageText(message);
    case "assistant":
      return assistantMessageText(message);
    case "tool":
      return null;
    default:
      return null;
  }
}

function userMessageText(message: UserMessage): string {
  const text = message.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
  return `${bold(white("❯"))} ${white(text)}`;
}

function assistantMessageText(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const content of message.content) {
    switch (content.type) {
      case "text":
        if (content.text) {
          parts.push(`${white("⏺")} ${content.text}`);
        }
        break;
      case "tool_use":
        parts.push(toolUseText(content));
        break;
    }
  }
  return parts.join("\n");
}

function toolUseText(content: ToolUseContent): string {
  const summary = getToolUseSummary(content);
  return `${dim("⏺")} ${summary.title}${summary.detail ? `\n  ${dim(`└─ ${summary.detail}`)}` : ""}`;
}


