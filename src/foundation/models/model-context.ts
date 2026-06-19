import type { Message } from "../messages";
import type { Tool } from "../tools";

/** Prompt-visible execution facts captured once for a turn run. */
export interface TurnContext {
  currentDate: string;
  timezone: string;
  cwd: string;
  model: string;
}

/** Runtime-only model request patch point used by middleware before prompt assembly. */
export interface ModelContext {
  prompt: string;
  tools?: Tool[];
  signal?: AbortSignal;
}

/** Already rendered provider-neutral model request. */
export interface RenderedModelRequest {
  model: string;
  messages: Message[];
  tools?: Tool[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}
