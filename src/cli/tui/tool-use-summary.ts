import type { ToolUseContent } from "@/foundation";

export type ToolUseSummary = {
  title: string;
  detail?: string;
};

export function getToolUseSummary(content: ToolUseContent): ToolUseSummary {
  switch (content.name) {
    case "bash":
      return withDetail(content, "Run command", stringInput(content, "command"));
    case "str_replace":
      return withDetail(content, "Replace text", stringInput(content, "path"));
    case "read_file":
      return withDetail(content, "Read file", stringInput(content, "path"));
    case "write_file":
      return withDetail(content, "Write file", stringInput(content, "path"));
    case "list_files":
      return withDetail(content, "List files", stringInput(content, "path"));
    case "file_info":
      return withDetail(content, "Inspect path", stringInput(content, "path"));
    case "mkdir":
      return withDetail(content, "Create directory", stringInput(content, "path"));
    case "glob_search":
      return withDetail(content, "Find files", searchDetail(content));
    case "grep_search":
      return withDetail(content, "Search files", searchDetail(content));
    case "move_path":
      return withDetail(content, "Move path", moveDetail(content));
    case "apply_patch":
      return withDetail(content, "Apply patch", "unified diff patch");
    case "todo_write":
      return { title: "Working on todos" };
    case "ask_user_question":
      return askUserQuestionSummary(content);
    default:
      return { title: "Tool call", detail: content.name };
  }
}

function withDetail(content: ToolUseContent, fallbackTitle: string, detail?: string): ToolUseSummary {
  return {
    title: stringInput(content, "description") ?? fallbackTitle,
    ...(detail ? { detail } : {}),
  };
}

function stringInput(content: ToolUseContent, key: string): string | undefined {
  const value = content.input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function searchDetail(content: ToolUseContent): string | undefined {
  const path = stringInput(content, "path");
  const pattern = stringInput(content, "pattern");
  if (path && pattern) return `${path} :: ${pattern}`;
  return path ?? pattern;
}

function moveDetail(content: ToolUseContent): string | undefined {
  const from = stringInput(content, "from");
  const to = stringInput(content, "to");
  if (from && to) return `${from} -> ${to}`;
  return from ?? to;
}

function askUserQuestionSummary(content: ToolUseContent): ToolUseSummary {
  const qs = (content.input as { questions?: { header?: string }[] }).questions;
  const n = qs?.length ?? 0;
  const first = qs?.[0]?.header?.trim();
  return {
    title: `Ask user${n ? `: ${n} question(s)` : ""}${first ? ` - ${first}` : ""}`,
  };
}
