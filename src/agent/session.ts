import type { NonSystemMessage, ToolMessage, ToolUseContent, UserMessage } from "@/foundation";

import {
  cloneEffectivePromptContext,
  defineEffectivePromptContext,
  type EffectivePromptContext,
} from "./prompt-context";
import {
  MemorySessionEventLog,
  type SessionEventCriticality,
  type SessionEventEnvelope,
  type SessionEventLog,
} from "./session-event-log";

/** Session identifier. */
export type SessionId = string;
/** Turn identifier. */
export type TurnId = string;
/** Agent identifier. */
export type AgentId = string;
/** Session message identifier. */
export type MessageId = string;

/** Lifecycle state for a task execution boundary inside a session. */
export type TurnStatus = "created" | "running" | "interrupted" | "completed" | "failed" | "cancelled";

/** Runtime options recorded on a turn. */
export interface TurnOptions {
  /** Explicit skill requested for this turn. */
  requestedSkillName?: string | null;
}

/** A single task execution boundary owned by a session. */
export interface Turn {
  id: TurnId;
  agentId: AgentId;
  status: TurnStatus;
  inputMessageIds: MessageId[];
  messageStartIndex: number;
  messageEndIndex?: number;
  createdAt: Date;
  startedAt?: Date;
  interruptedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  cancelledAt?: Date;
  error?: string;
  options?: TurnOptions;
}

/** Metadata attached to a durable session transcript entry. */
export interface SessionMessageMetadata {
  turnInputKind?: "initial" | "steer";
  synthetic?: boolean;
  source?: string;
  reason?: "interrupt" | string;
}

/** Transcript entry with a session-level stable ID. */
export interface SessionMessage {
  id: MessageId;
  message: NonSystemMessage;
  metadata?: SessionMessageMetadata;
}

export interface SessionOptions {
  id?: SessionId;
  promptContext?: EffectivePromptContext;
  promptContextRefresh?: () => Promise<EffectivePromptContext | undefined>;
  eventLog?: SessionEventLog;
  recordInitialPromptContext?: boolean;
}

export interface CreateTurnParams {
  agentId: AgentId;
  input: string | UserMessage;
  options?: TurnOptions;
}

export interface InstallCompactedTranscriptParams {
  summaryText: string;
  compactedMessageIds: MessageId[];
  preservedTailEntries: SessionMessage[];
  tokenEstimate: unknown;
  modelContextWindow: unknown;
  compactionSourceMaterial?: string;
  reason: "auto-pre-request" | string;
  turnId?: TurnId;
}

/**
 * Durable state for an agent conversation.
 */
export class Session {
  readonly id: SessionId;

  readonly eventLog: SessionEventLog;

  private readonly _turns: Turn[] = [];
  private readonly _messages: SessionMessage[] = [];
  private _promptContext: EffectivePromptContext;
  private readonly _promptContextRefresh?: () => Promise<EffectivePromptContext | undefined>;
  private _nextEventNumber = 1;
  private _nextRunNumber = 1;
  private _nextRequestNumber = 1;
  private _nextTurnNumber = 1;
  private _nextMessageNumber = 1;

  constructor({
    id = "session-1",
    promptContext,
    promptContextRefresh,
    eventLog,
    recordInitialPromptContext = true,
  }: SessionOptions = {}) {
    this.id = id;
    this.eventLog = eventLog ?? new MemorySessionEventLog();
    this._promptContext = promptContext
      ? cloneEffectivePromptContext(promptContext)
      : defineEffectivePromptContext([]);
    this._promptContextRefresh = promptContextRefresh;
    if (recordInitialPromptContext) {
      this._recordEvent({
        type: "prompt_context_set",
        criticality: "session",
        data: { promptContext: this.promptContext },
      });
    }
  }

  /** Provider-facing transcript projection. */
  get messages(): NonSystemMessage[] {
    return this._messages.map((entry) => entry.message);
  }

  /** Active transcript entries with stable session message IDs. */
  get transcript(): SessionMessage[] {
    return this._messages.map((entry) => this._cloneMessage(entry));
  }

  /** Typed durable prompt context outside the turn transcript. */
  get promptContext(): EffectivePromptContext {
    return cloneEffectivePromptContext(this._promptContext);
  }

  /** Replaces the current effective prompt context projection. */
  setPromptContext(promptContext: EffectivePromptContext) {
    this._promptContext = cloneEffectivePromptContext(promptContext);
    this._recordEvent({
      type: "prompt_context_set",
      criticality: "session",
      data: { promptContext: this.promptContext },
    });
  }

  /** Refreshes prompt context before a run when a session factory provides a loader. */
  async refreshPromptContext(): Promise<boolean> {
    if (!this._promptContextRefresh) {
      return false;
    }
    const nextPromptContext = await this._promptContextRefresh();
    if (!nextPromptContext || nextPromptContext.sourceSetHash === this._promptContext.sourceSetHash) {
      return false;
    }
    this.setPromptContext(nextPromptContext);
    return true;
  }

  /** Turn snapshots owned by this session. */
  get turns(): Turn[] {
    return this._turns.map((turn) => ({ ...turn, inputMessageIds: [...turn.inputMessageIds] }));
  }

  /** Records a new turn and appends its initial user input. */
  createTurn({ agentId, input, options }: CreateTurnParams): Turn {
    this._assertNoActiveTurn();

    const turn: Turn = {
      id: this._nextTurnId(),
      agentId,
      status: "created",
      inputMessageIds: [],
      messageStartIndex: this._messages.length,
      createdAt: new Date(),
      options,
    };
    this._turns.push(turn);
    this._recordEvent({
      type: "turn_created",
      criticality: "session",
      turnId: turn.id,
      data: { turn: this._cloneTurn(turn) },
    });

    const messageId = this._appendMessage(inputToUserMessage(input), {
      turnInputKind: "initial",
    }, turn.id);
    turn.inputMessageIds.push(messageId);

    return this._cloneTurn(turn);
  }

  /** Returns a transcript entry by ID. */
  getMessage(messageId: MessageId): SessionMessage | undefined {
    const entry = this._messages.find((message) => message.id === messageId);
    return entry ? this._cloneMessage(entry) : undefined;
  }

  /** Returns a turn by ID. */
  getTurn(turnId: TurnId): Turn | undefined {
    const turn = this._findTurn(turnId);
    return turn ? this._cloneTurn(turn) : undefined;
  }

  /** Appends steer input to a paused turn without starting execution. */
  continueTurn(turnId: TurnId, input: string | UserMessage): Turn {
    const turn = this._requireTurn(turnId);
    if (turn.status !== "interrupted") {
      throw new Error(`Cannot continue turn ${turnId} from status ${turn.status}`);
    }
    this._repairDanglingToolUses(turn);
    const messageId = this._appendMessage(inputToUserMessage(input), {
      turnInputKind: "steer",
    }, turn.id);
    turn.inputMessageIds.push(messageId);
    turn.messageEndIndex = undefined;
    return this._cloneTurn(turn);
  }

  appendMessageToTurn(
    turnId: TurnId,
    message: NonSystemMessage,
    metadata?: SessionMessageMetadata,
  ): MessageId {
    const turn = this._requireTurn(turnId);
    if (this._isTerminal(turn.status)) {
      throw new Error(`Cannot append messages to terminal turn ${turnId}`);
    }
    return this._appendMessage(message, metadata, turnId);
  }

  markTurnRunning(turnId: TurnId): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "running");
    turn.startedAt ??= new Date();
    this._recordTurnStatusChanged(turn);
    return this._cloneTurn(turn);
  }

  interruptTurn(turnId: TurnId): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "interrupted");
    turn.interruptedAt = new Date();
    turn.messageEndIndex = this._messages.length;
    this._recordTurnStatusChanged(turn);
    return this._cloneTurn(turn);
  }

  completeTurn(turnId: TurnId): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "completed");
    turn.completedAt = new Date();
    turn.messageEndIndex = this._messages.length;
    this._recordTurnStatusChanged(turn);
    return this._cloneTurn(turn);
  }

  failTurn(turnId: TurnId, error: string): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "failed");
    turn.failedAt = new Date();
    turn.messageEndIndex = this._messages.length;
    turn.error = error;
    this._recordTurnStatusChanged(turn);
    return this._cloneTurn(turn);
  }

  cancelTurn(turnId: TurnId): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "cancelled");
    turn.cancelledAt = new Date();
    turn.messageEndIndex = this._messages.length;
    this._recordTurnStatusChanged(turn);
    return this._cloneTurn(turn);
  }

  nextRunId() {
    return `run-${this._nextRunNumber++}`;
  }

  nextRequestId() {
    return `request-${this._nextRequestNumber++}`;
  }

  recordTraceEvent<TType extends string, TData>({
    type,
    turnId,
    runId,
    requestId,
    messageId,
    toolUseId,
    data,
  }: {
    type: TType;
    turnId?: TurnId;
    runId?: string;
    requestId?: string;
    messageId?: MessageId;
    toolUseId?: string;
    data: TData;
  }) {
    this._recordEvent({
      type,
      criticality: "trace",
      turnId,
      runId,
      requestId,
      messageId,
      toolUseId,
      data,
    });
  }

  installCompactedTranscript({
    summaryText,
    compactedMessageIds,
    preservedTailEntries,
    tokenEstimate,
    modelContextWindow,
    compactionSourceMaterial,
    reason,
    turnId,
  }: InstallCompactedTranscriptParams): SessionMessage {
    const summaryMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: summaryText }],
    };
    const summaryEntry: SessionMessage = {
      id: this._nextMessageId(),
      message: summaryMessage,
      metadata: { synthetic: true, source: "compact" },
    };
    const preservedTail = preservedTailEntries.map((entry) => this._cloneMessage(entry));
    this._messages.length = 0;
    this._messages.push(summaryEntry, ...preservedTail);

    const preservedTailMessageIds = preservedTail.map((entry) => entry.id);
    const replacementMessageIds = [summaryEntry.id, ...preservedTailMessageIds];
    const replacementTranscript = [summaryEntry, ...preservedTail].map((entry) => this._cloneMessage(entry));
    this._recordEvent({
      type: "transcript_compacted",
      criticality: "session",
      turnId,
      messageId: summaryEntry.id,
      data: {
        summaryMessage: this._cloneMessage(summaryEntry),
        compactedMessageIds,
        preservedTailMessageIds,
        replacementMessageIds,
        replacementTranscript,
        tokenEstimate,
        modelContextWindow,
        compactionSourceMaterial,
        reason,
      },
    });

    return this._cloneMessage(summaryEntry);
  }

  private _appendMessage(
    message: NonSystemMessage,
    metadata?: SessionMessageMetadata,
    turnId?: TurnId,
  ): MessageId {
    const id = this._nextMessageId();
    this._messages.push({ id, message, metadata });
    this._recordEvent({
      type: "message_appended",
      criticality: "session",
      turnId,
      messageId: id,
      data: { message, metadata },
    });
    return id;
  }

  private _repairDanglingToolUses(turn: Turn) {
    const turnMessages = this._messages.slice(turn.messageStartIndex, turn.messageEndIndex ?? this._messages.length);
    const openToolUses = new Map<string, ToolUseContent>();

    for (const entry of turnMessages) {
      if (entry.message.role === "assistant") {
        for (const content of entry.message.content) {
          if (content.type === "tool_use") {
            openToolUses.set(content.id, content);
          }
        }
      }
      if (entry.message.role === "tool") {
        for (const content of entry.message.content) {
          openToolUses.delete(content.tool_use_id);
        }
      }
    }

    for (const toolUse of openToolUses.values()) {
      const toolMessage: ToolMessage = {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: "Tool call interrupted before completion.",
          },
        ],
      };
      this._appendMessage(toolMessage, {
        synthetic: true,
        source: "session",
        reason: "interrupt",
      }, turn.id);
    }
  }

  private _recordTurnStatusChanged(turn: Turn) {
    this._recordEvent({
      type: "turn_status_changed",
      criticality: "session",
      turnId: turn.id,
      data: { status: turn.status, error: turn.error },
    });
  }

  private _recordEvent<TType extends string, TData>({
    type,
    criticality,
    turnId,
    runId,
    requestId,
    messageId,
    toolUseId,
    data,
  }: {
    type: TType;
    criticality: SessionEventCriticality;
    turnId?: TurnId;
    runId?: string;
    requestId?: string;
    messageId?: MessageId;
    toolUseId?: string;
    data: TData;
  }) {
    const event: SessionEventEnvelope<TType, TData> = {
      eventId: this._nextEventId(),
      type,
      sessionId: this.id,
      timestamp: new Date().toISOString(),
      criticality,
      data,
    };
    if (turnId) event.turnId = turnId;
    if (runId) event.runId = runId;
    if (requestId) event.requestId = requestId;
    if (messageId) event.messageId = messageId;
    if (toolUseId) event.toolUseId = toolUseId;
    void this.eventLog.write(event);
  }

  private _assertNoActiveTurn() {
    const activeTurn = this._turns.find((turn) => !this._isTerminal(turn.status));
    if (activeTurn) {
      throw new Error(`Session already has active turn ${activeTurn.id}`);
    }
  }

  private _transitionTurn(turn: Turn, nextStatus: TurnStatus) {
    const allowed = ALLOWED_TURN_TRANSITIONS[turn.status];
    if (!allowed.includes(nextStatus)) {
      throw new Error(`Invalid turn status transition: ${turn.status} -> ${nextStatus}`);
    }
    turn.status = nextStatus;
  }

  private _findTurn(turnId: TurnId): Turn | undefined {
    return this._turns.find((turn) => turn.id === turnId);
  }

  private _requireTurn(turnId: TurnId): Turn {
    const turn = this._findTurn(turnId);
    if (!turn) {
      throw new Error(`Turn ${turnId} not found`);
    }
    return turn;
  }

  private _isTerminal(status: TurnStatus) {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  private _nextTurnId() {
    return `turn-${this._nextTurnNumber++}`;
  }

  private _nextMessageId() {
    return `message-${this._nextMessageNumber++}`;
  }

  private _nextEventId() {
    return `event-${this._nextEventNumber++}`;
  }

  private _cloneTurn(turn: Turn): Turn {
    return { ...turn, inputMessageIds: [...turn.inputMessageIds] };
  }

  private _cloneMessage(entry: SessionMessage): SessionMessage {
    return { ...entry, metadata: entry.metadata ? { ...entry.metadata } : undefined };
  }
}

const ALLOWED_TURN_TRANSITIONS: Record<TurnStatus, TurnStatus[]> = {
  created: ["running"],
  running: ["interrupted", "completed", "failed", "cancelled"],
  interrupted: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function inputToUserMessage(input: string | UserMessage): UserMessage {
  if (typeof input !== "string") {
    return input;
  }
  return {
    role: "user",
    content: [{ type: "text", text: input }],
  };
}
