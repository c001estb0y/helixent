import type { NonSystemMessage, ToolMessage, ToolUseContent, UserMessage } from "@/foundation";

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

/** Durable model-visible context that is not part of the turn transcript. */
export interface SessionContextBlock {
  id: string;
  content: string;
  source?: string;
}

export interface SessionOptions {
  id?: SessionId;
  contextBlocks?: SessionContextBlock[];
}

export interface CreateTurnParams {
  agentId: AgentId;
  input: string | UserMessage;
  options?: TurnOptions;
}

/**
 * Durable state for an agent conversation.
 */
export class Session {
  readonly id: SessionId;

  private readonly _turns: Turn[] = [];
  private readonly _messages: SessionMessage[] = [];
  private readonly _contextBlocks: SessionContextBlock[];
  private _nextTurnNumber = 1;
  private _nextMessageNumber = 1;

  constructor({ id = "session-1", contextBlocks = [] }: SessionOptions = {}) {
    this.id = id;
    this._contextBlocks = [...contextBlocks];
  }

  /** Provider-facing transcript projection. */
  get messages(): NonSystemMessage[] {
    return this._messages.map((entry) => entry.message);
  }

  /** Durable session context outside the turn transcript. */
  get contextBlocks(): SessionContextBlock[] {
    return [...this._contextBlocks];
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

    const messageId = this._appendMessage(inputToUserMessage(input), {
      turnInputKind: "initial",
    });
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
    });
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
    return this._appendMessage(message, metadata);
  }

  markTurnRunning(turnId: TurnId): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "running");
    turn.startedAt ??= new Date();
    return this._cloneTurn(turn);
  }

  interruptTurn(turnId: TurnId): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "interrupted");
    turn.interruptedAt = new Date();
    turn.messageEndIndex = this._messages.length;
    return this._cloneTurn(turn);
  }

  completeTurn(turnId: TurnId): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "completed");
    turn.completedAt = new Date();
    turn.messageEndIndex = this._messages.length;
    return this._cloneTurn(turn);
  }

  failTurn(turnId: TurnId, error: string): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "failed");
    turn.failedAt = new Date();
    turn.messageEndIndex = this._messages.length;
    turn.error = error;
    return this._cloneTurn(turn);
  }

  cancelTurn(turnId: TurnId): Turn {
    const turn = this._requireTurn(turnId);
    this._transitionTurn(turn, "cancelled");
    turn.cancelledAt = new Date();
    turn.messageEndIndex = this._messages.length;
    return this._cloneTurn(turn);
  }

  private _appendMessage(message: NonSystemMessage, metadata?: SessionMessageMetadata): MessageId {
    const id = this._nextMessageId();
    this._messages.push({ id, message, metadata });
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
      });
    }
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
