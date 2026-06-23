import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AssistantMessage, NonSystemMessage, TurnContext } from "@/foundation";

import type { RenderedPromptMessage } from "./prompt-assembly";
import type { EffectivePromptContext } from "./prompt-context";
import type { MessageId, SessionId, SessionMessageMetadata, Turn, TurnId, TurnStatus } from "./session";

export type SessionEventCriticality = "session" | "trace";

export interface SessionEventEnvelope<TType extends string = string, TData = unknown> {
  eventId: string;
  type: TType;
  sessionId: SessionId;
  timestamp: string;
  criticality: SessionEventCriticality;
  turnId?: TurnId;
  runId?: string;
  requestId?: string;
  messageId?: MessageId;
  toolUseId?: string;
  data: TData;
}

export interface RenderedToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ModelRequestTraceData {
  model: string;
  modelOptions?: Record<string, unknown>;
  stepIndex: number;
  renderedMessages: RenderedPromptMessage[];
  renderedTools: RenderedToolSchema[];
}

export interface SessionEventLog {
  write<TType extends string, TData>(
    // eslint-disable-next-line no-unused-vars
    event: SessionEventEnvelope<TType, TData>,
  ): void | Promise<void>;
}

export class MemorySessionEventLog implements SessionEventLog {
  private readonly _events: SessionEventEnvelope[] = [];

  get events(): SessionEventEnvelope[] {
    return this._events.map(cloneEnvelope);
  }

  write<TType extends string, TData>(event: SessionEventEnvelope<TType, TData>) {
    this._events.push(cloneEnvelope(event));
  }
}

export class JsonlSessionEventLog implements SessionEventLog {
  private readonly _path: string;

  constructor({ path }: { path: string }) {
    this._path = path;
  }

  write<TType extends string, TData>(event: SessionEventEnvelope<TType, TData>) {
    mkdirSync(dirname(this._path), { recursive: true });
    appendFileSync(this._path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

export function projectEventLogPath({
  helixentHome,
  cwd,
  sessionId,
}: {
  helixentHome: string;
  cwd: string;
  sessionId: SessionId;
}) {
  return join(helixentHome, "projects", projectKeyFromCwd(cwd), "events", `${sessionId}.jsonl`);
}

export function projectKeyFromCwd(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

export interface SessionEventReadResult {
  events: SessionEventEnvelope[];
  invalidLines: Array<{ line: number; content: string; error: string }>;
}

export async function readSessionEventsJsonl(path: string): Promise<SessionEventReadResult> {
  const text = await readFile(path, "utf8");
  const events: SessionEventEnvelope[] = [];
  const invalidLines: SessionEventReadResult["invalidLines"] = [];

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as SessionEventEnvelope;
      if (!isSessionEventEnvelope(value)) {
        throw new Error("Invalid session event envelope");
      }
      events.push(value);
    } catch (error) {
      invalidLines.push({
        line: index + 1,
        content: line,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { events, invalidLines };
}

export type SessionStateEvent =
  | SessionEventEnvelope<"prompt_context_set", { promptContext: EffectivePromptContext }>
  | SessionEventEnvelope<"turn_created", { turn: Turn }>
  | SessionEventEnvelope<"message_appended", { message: NonSystemMessage; metadata?: SessionMessageMetadata }>
  | SessionEventEnvelope<"turn_status_changed", { status: TurnStatus; error?: string }>;

export type SessionTraceEvent =
  | SessionEventEnvelope<"turn_run_started", Record<string, never>>
  | SessionEventEnvelope<"turn_context_snapshot", { turnContext: TurnContext }>
  | SessionEventEnvelope<"prompt_context_snapshot", { promptContext: EffectivePromptContext }>
  | SessionEventEnvelope<"model_request", ModelRequestTraceData>
  | SessionEventEnvelope<
      "model_response",
      {
        assistantMessageId?: MessageId;
        usage?: AssistantMessage["usage"];
        finishReason?: string | null;
        durationMs: number;
      }
    >
  | SessionEventEnvelope<"tool_started", { name: string; input: unknown; startedAt: string }>
  | SessionEventEnvelope<
      "tool_finished",
      {
        toolResultMessageId?: MessageId;
        ok: boolean;
        error?: string;
        startedAt?: string;
        finishedAt: string;
        durationMs: number;
      }
    >
  | SessionEventEnvelope<"turn_run_completed", { durationMs: number }>
  | SessionEventEnvelope<"turn_run_interrupted", { reason: string; durationMs: number }>
  | SessionEventEnvelope<"turn_run_failed", { error: string; durationMs: number }>;

export type HelixentSessionEvent = SessionStateEvent | SessionTraceEvent;

export interface SessionProjection {
  sessionId?: SessionId;
  promptContext?: EffectivePromptContext;
  turns: Turn[];
  messages: Array<{ id: MessageId; message: NonSystemMessage; metadata?: SessionMessageMetadata }>;
  traceEvents: SessionEventEnvelope[];
  traceIncomplete: boolean;
  errors: Array<{ eventId?: string; type?: string; criticality?: SessionEventCriticality; message: string }>;
}

export function projectSessionEvents(events: SessionEventEnvelope[]): SessionProjection {
  const projection: SessionProjection = {
    turns: [],
    messages: [],
    traceEvents: [],
    traceIncomplete: false,
    errors: [],
  };

  for (const event of events) {
    projection.sessionId ??= event.sessionId;
    try {
      applyEvent(projection, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      projection.errors.push({
        eventId: event.eventId,
        type: event.type,
        criticality: event.criticality,
        message,
      });
      if (event.criticality === "trace") {
        projection.traceIncomplete = true;
        continue;
      }
      throw error;
    }
  }

  return projection;
}

function applyEvent(projection: SessionProjection, event: SessionEventEnvelope) {
  if (event.criticality === "trace") {
    projection.traceEvents.push(event);
    return;
  }

  if (event.type === "prompt_context_set") {
    projection.promptContext = requireObjectField<EffectivePromptContext>(event, "promptContext");
    return;
  }

  if (event.type === "turn_created") {
    projection.turns.push(requireObjectField<Turn>(event, "turn"));
    return;
  }

  if (event.type === "message_appended") {
    const message = requireObjectField<NonSystemMessage>(event, "message");
    if (!event.messageId) {
      throw new Error("message_appended event is missing messageId");
    }
    const metadata = (event.data as { metadata?: SessionMessageMetadata }).metadata;
    projection.messages.push({ id: event.messageId, message, metadata });
    return;
  }

  if (event.type === "turn_status_changed") {
    const status = requireObjectField<TurnStatus>(event, "status");
    const turn = projection.turns.find((candidate) => candidate.id === event.turnId);
    if (!turn) {
      throw new Error(`turn_status_changed references unknown turn ${event.turnId ?? ""}`);
    }
    turn.status = status;
    turn.error = (event.data as { error?: string }).error;
  }
}

function requireObjectField<T>(event: SessionEventEnvelope, field: string): T {
  if (!event.data || typeof event.data !== "object" || !(field in event.data)) {
    throw new Error(`${event.type} event is missing data.${field}`);
  }
  return (event.data as Record<string, unknown>)[field] as T;
}

function isSessionEventEnvelope(value: unknown): value is SessionEventEnvelope {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SessionEventEnvelope>;
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.timestamp === "string" &&
    (candidate.criticality === "session" || candidate.criticality === "trace") &&
    "data" in candidate
  );
}

function cloneEnvelope<T extends SessionEventEnvelope>(event: T): T {
  return structuredClone(event);
}
