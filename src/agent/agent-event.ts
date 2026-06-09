import type { MessageId, TurnId } from "./session";

/** Discriminator values for {@link TurnRunProgressEvent.subtype}. */
export type TurnRunProgressSubtype = "thinking" | "tool";

/** Fired when the turn run begins execution. */
export interface TurnStartedEvent {
  type: "turn_started";
  turnId: TurnId;
}

/** Fired while the model is streaming progress. */
export type TurnRunProgressEvent =
  | { type: "progress"; turnId: TurnId; subtype: "thinking" }
  | { type: "progress"; turnId: TurnId; subtype: "tool"; name: string; input: unknown };

/** Fired when a transcript message has been appended to the session. */
export interface TurnRunMessageEvent {
  type: "message";
  turnId: TurnId;
  messageId: MessageId;
}

/** Fired immediately before a tool call is invoked. */
export interface ToolStartedEvent {
  type: "tool_started";
  turnId: TurnId;
  toolUseId: string;
  name: string;
}

/** Fired after a tool result message has been appended. */
export interface ToolFinishedEvent {
  type: "tool_finished";
  turnId: TurnId;
  toolUseId: string;
  messageId: MessageId;
}

/** Fired when a turn reaches a terminal or interrupted state. */
export type TurnStoppedEvent =
  | { type: "turn_interrupted"; turnId: TurnId }
  | { type: "turn_completed"; turnId: TurnId }
  | { type: "turn_failed"; turnId: TurnId; error: string }
  | { type: "turn_cancelled"; turnId: TurnId };

/** Observation events emitted by a {@link TurnRun}. */
export type TurnRunEvent =
  | TurnStartedEvent
  | TurnRunProgressEvent
  | TurnRunMessageEvent
  | ToolStartedEvent
  | ToolFinishedEvent
  | TurnStoppedEvent;

/** Backward-compatible name for turn-run events during the runner migration. */
export type AgentEvent = TurnRunEvent;
