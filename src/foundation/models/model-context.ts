import type { NonSystemMessage } from "../messages";
import type { Tool } from "../tools";

export interface ModelContextBlock {
  content: string;
  source?: string;
}

export interface ModelContext {
  prompt: string;
  contextBlocks?: ModelContextBlock[];
  messages: NonSystemMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
}
