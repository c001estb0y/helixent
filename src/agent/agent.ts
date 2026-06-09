import type { Model, NonSystemMessage, Tool } from "@/foundation";

import type { AgentMiddleware } from "./agent-middleware";
import type { AgentId } from "./session";
import type { SkillFrontmatter } from "./skills/types";

/**
 * Runtime-only context used by a single agent turn run.
 */
export interface AgentContext {
  /** The system prompt to use to invoke the agent. */
  prompt: string;
  /** The messages to use to invoke the agent. */
  messages: NonSystemMessage[];
  /** The tools to use to invoke the agent. */
  tools?: Tool[];
  /** The skills to use to invoke the agent. */
  skills?: SkillFrontmatter[];
  /** Explicitly requested skill for this run, when set by the turn. */
  requestedSkillName?: string | null;
}

/** Options for an agent configuration. */
export interface AgentOptions {
  /** The maximum number of steps to take. */
  maxSteps?: number;
}

/**
 * Immutable agent capability configuration.
 */
export class Agent {
  readonly id: AgentId;
  readonly name?: string;
  readonly model: Model;
  readonly prompt: string;
  readonly tools?: Tool[];
  readonly middlewares: AgentMiddleware[];
  readonly options: Required<AgentOptions>;

  constructor({
    id,
    name,
    model,
    prompt,
    tools,
    middlewares = [],
    maxSteps = 100,
  }: {
    id: AgentId;
    name?: string;
    model: Model;
    prompt: string;
    tools?: Tool[];
    middlewares?: AgentMiddleware[];
    maxSteps?: number;
  }) {
    this.id = id;
    this.name = name;
    this.model = model;
    this.prompt = prompt;
    this.tools = tools;
    this.middlewares = middlewares;
    this.options = { maxSteps };
  }
}
