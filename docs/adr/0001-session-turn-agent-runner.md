# ADR 0001: First-Class Session, Turn, and Agent Runner

## Status

Accepted for this fork.

## Date

2026-06-09

## Context

Helixent currently centers execution around a stateful `Agent`. The agent owns the model-facing prompt, messages, tools, middleware state, streaming flag, abort controller, and skill selection state. This keeps the initial implementation small, but it makes several future capabilities harder to model cleanly:

- starting a new session without rebuilding unrelated agent capability configuration;
- preserving a clear turn boundary for UI rendering, interruption, replay, and future compaction;
- distinguishing durable conversation facts from runtime-only prompt injection;
- supporting subagents or parallel work without state leaking through a shared agent instance;
- keeping `AGENTS.md` and similar project instructions separate from ordinary user messages.

This fork intentionally prioritizes a clean first-principles model over compatibility with the current public `Agent` API. The changes described here are not intended to be merged back into the upstream repository as a non-breaking evolution.

## Decision

Introduce first-class `Session`, `Turn`, `AgentRunner`, and `TurnRun` concepts.

`Session` is the working environment and source of truth for durable state. It owns turns, transcript messages, context blocks, and the active turn constraint. Phase 1 allows only one active turn per session.

`Turn` is the task execution boundary. A turn starts from an initial user input, may be interrupted, may receive later steer inputs, and eventually reaches a terminal state. A turn is not merely one user message plus one assistant response.

`Agent` becomes an immutable capability/configuration object. It owns identity and capability configuration such as model, prompt, tools, middleware, and max steps. It does not own transcript messages, streaming state, abort controllers, or requested skill state.

The target shape is:

```ts
interface Agent {
  readonly id: AgentId;
  readonly name?: string;
  readonly model: Model;
  readonly prompt: string;
  readonly tools?: Tool[];
  readonly middlewares: AgentMiddleware[];
  readonly options: {
    readonly maxSteps: number;
  };
}
```

`AgentRunner` is a stateless orchestrator. It starts execution for a session turn using an agent configuration.

`TurnRun` is the runtime handle for one execution attempt. It owns the abort controller, event stream, completion promise, and runtime-only agent context.

Ownership summary:

```text
Session owns Turn.
Session owns transcript messages and context blocks.
Agent owns capability configuration only.
AgentRunner creates TurnRun.
TurnRun owns AgentRunContext, AbortController, events, and done.
```

`AgentRunContext` is a runtime-only parameter bag owned by `TurnRun`. It is not a persistent domain object.

`Session` does not literally own `Agent` instances in Phase 1. Turns reference agents by `agentId`, while the caller supplies the matching `Agent` configuration to `AgentRunner`. This keeps session state durable and agent capability configuration replaceable.

## Concept Model

Use simple string IDs in Phase 1.

```ts
type SessionId = string;
type TurnId = string;
type AgentId = string;
type MessageId = string;
```

Branded types can be added later if they become useful, but Phase 1 should avoid type ceremony while the model is still settling.

```ts
type TurnStatus =
  | "created"
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

interface Turn {
  id: TurnId;
  agentId: AgentId;
  status: TurnStatus;
  inputMessageIds: MessageId[];
  messageStartIndex: number;
  messageEndIndex?: number; // exclusive, like array.slice(start, end)
  createdAt: Date;
  startedAt?: Date;
  interruptedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  cancelledAt?: Date;
  error?: string;
}
```

Allowed status transitions:

```text
created -> running
running -> interrupted
running -> completed
running -> failed
running -> cancelled
interrupted -> running
interrupted -> failed
interrupted -> cancelled
```

Terminal turns cannot be resumed.

`messageStartIndex` and `messageEndIndex` cover only the messages owned by the turn. Session context blocks are outside this range.

Messages should have IDs at the session layer without changing `foundation/messages`.

```ts
interface SessionMessage {
  id: MessageId;
  message: NonSystemMessage;
  metadata?: {
    turnInputKind?: "initial" | "steer";
    synthetic?: boolean;
    source?: string;
    reason?: "interrupt" | string;
  };
}
```

Turn message ranges are the canonical ownership model. Phase 1 should not require `turnId` on every message, because that creates a second source of truth beside `messageStartIndex` and `messageEndIndex`. A future implementation may add message-level `turnId` metadata only if it has a concrete UI/debugging need and keeps the turn range authoritative.

`Session.messages` may expose provider-facing `NonSystemMessage[]`, derived from session entries. Display code can keep view snapshots, but the session remains the transcript source of truth.

The session transcript is the model-visible message timeline, not merely a log file. JSONL is only a possible future persistence format for this transcript and related typed context items.

## Session API Direction

The session creates and mutates domain state. It does not execute the agent loop.

```ts
const turn = session.createTurn({
  agentId: agent.id,
  input,
  options: { requestedSkillName },
});
```

The runner executes an existing turn.

```ts
const run = runner.startTurn({
  session,
  agent,
  turnId: turn.id,
});
```

The names are intentionally different: `createTurn` records domain state, while `startTurn` starts runtime execution.

`runner.startTurn(...)` returns a `TurnRun`. Convenience wrappers such as `runner.streamTurn(...)` or `runner.runTurn(...)` may be added, but they should delegate to the same `TurnRun` execution path.

`session.createTurn(...)` appends the initial user message internally and records its ID in `turn.inputMessageIds`. Callers should not append the initial user message separately.

Phase 1 session methods should be explicit and mutation-safe:

```ts
session.createTurn(...);
session.interruptTurn(turnId);
session.continueTurn(turnId, input);
session.cancelTurn(turnId);
session.getMessage(messageId);
```

`session.continueTurn(...)` appends a steer user message to the same turn and records the new message ID in `turn.inputMessageIds`.

Do not expose mutable transcript arrays. Appending messages should go through session methods used by `TurnRun`.

## Transcript, Context, and Prompt Injection

The design separates three model-visible concepts:

```ts
Session.messages;
Session.contextBlocks;
ModelContext patch;
```

`Session.messages` contains the real transcript: user messages, assistant messages, and tool result messages. It is the durable fact stream for the session.

`Session.contextBlocks` contains durable session-level context such as `AGENTS.md`, project instructions, and user preferences. These are model-visible, but they are not ordinary user turn messages.

`ModelContext` patches are runtime-only request shaping, such as skills listings, selected skill hints, middleware-provided prompt additions, and provider options.

`AGENTS.md` belongs in `Session.contextBlocks`, not in `Session.messages`.

`createCodingAgent(...)` should stop loading `AGENTS.md` as initial agent messages. Session creation or a coding-session factory should load those files into `Session.contextBlocks`.

Prompt layer meanings:

- `Agent.prompt` is the agent's system prompt: identity, behavior contract, and tool-use policy.
- `Session.contextBlocks` are session-level user/project instructions: `AGENTS.md`, project conventions, and preferences.
- Turn input is the user's task prompt for that turn.

`Session.contextBlocks` may be rendered as contextual user instructions or another provider-specific prompt slot, but conceptually they are not turn input.

This follows the broad shape of the reference agents:

- Codex resolves `AGENTS.md` into `user_instructions` and injects it as contextual user/developer context, not as a normal user turn message.
- ClaudeCode loads `CLAUDE.md` into `userContext.claudeMd` and prepends it when constructing a model request; subagents may omit it to save tokens.
- Hermes folds project context files into the system prompt context tier and stores system prompt separately from ordinary messages.

```ts
// TODO(resume/compact): Persist Session.contextBlocks as typed context items,
// not as normal Session.messages. This keeps project/user instructions durable
// across resume/compact without polluting turn transcript.
```

Future compaction should continue the same session. It should replace or summarize the model-visible context according to turn boundaries; it should not be treated as session termination.

## Interruption and Continue

Interrupting a running turn is not terminal. It stops the current step and moves the turn to `interrupted`. The user may then provide steer input and continue the same turn.

Failed or interrupted turns keep the partial messages already appended to the transcript. The turn status records how execution stopped; the transcript is not rolled back by default.

To the model, steer input is still a normal `user` message. Internally, it should be marked as a turn input with metadata such as `turnInputKind: "steer"`.

If interruption leaves an assistant `tool_use` without a matching `tool_result`, `TurnRun` must append a synthetic tool result before appending the steer user message. This keeps provider message history valid.

```ts
// Synthetic tool results preserve provider protocol after interruption.
// They are transcript messages, but should be metadata-marked as synthetic.
```

TUI routing:

```text
idle + submit         -> create turn and start run
running + submit      -> queue as next turn input in TUI state
running + Esc         -> interrupt current turn
interrupted + submit  -> continue same turn as steer input
```

Queued next-turn prompts live in TUI state until they are submitted as an actual turn. They are not session transcript facts before that point and have no `TurnId`.

## Events

`TurnRun.events` is an observation stream. It reports execution progress but does not drive execution.

```ts
// Events observe execution; they do not drive it. Session remains the source of truth.
```

`TurnRun.done` waits for the internal run loop to finish. It must not consume `TurnRun.events`. Event consumption is optional observation, not the mechanism that advances the agent loop.

Phase 1 should treat a `TurnRun.events` async iterator as a single-consumer UI stream. If multiple consumers are needed later, add an explicit broadcaster or event log projection instead of sharing one iterator between consumers.

Events should reference session facts by ID where possible:

```ts
type TurnRunEvent =
  | { type: "turn_started"; turnId: TurnId }
  | { type: "progress"; turnId: TurnId; subtype: "thinking" | "tool"; name?: string; input?: unknown }
  | { type: "message"; turnId: TurnId; messageId: MessageId }
  | { type: "tool_started"; turnId: TurnId; toolUseId: string; name: string }
  | { type: "tool_finished"; turnId: TurnId; toolUseId: string; messageId: MessageId }
  | { type: "turn_interrupted"; turnId: TurnId }
  | { type: "turn_completed"; turnId: TurnId }
  | { type: "turn_failed"; turnId: TurnId; error: string }
  | { type: "turn_cancelled"; turnId: TurnId };
```

The TUI should read message content from `Session`, not from event payload copies.

Tool calls within one assistant message should keep the existing Helixent behavior: invoke tools in parallel and append each `tool_result` message as its tool resolves. This is part of the runner behavior, not session mutation policy leaking into tool implementations.

## Middleware Boundary

Middleware may observe and shape runtime/model context. Middleware must not directly mutate the session transcript.

All transcript writes go through `TurnRun` and session methods. This keeps message IDs, turn boundaries, interruption handling, and future compaction coherent.

Phase 1 keeps middleware injection runtime-only by default. For example, skills middleware may append skill instructions to the current `ModelContext`, but those instructions should not be appended to `Session.messages`.

Phase 1 does not open a middleware `appendMessages` capability. If a later feature needs middleware-originated transcript writes, the middleware should return an explicit write request and `TurnRun` should perform the actual session mutation.

`requestedSkillName` belongs to turn options, not to `Agent` state.

```ts
session.createTurn({
  agentId,
  input,
  options: { requestedSkillName },
});
```

## Compatibility

This fork will not preserve the old stateful `Agent` API as a compatibility wrapper.

Remove or replace:

- `agent.stream(...)`
- `agent.abort()`
- `agent.messages`
- `agent.clearMessages()`
- `agent.streaming`
- `agent.setRequestedSkillName(...)`

New call sites should use `Session`, `AgentRunner`, and `TurnRun` directly.

## Parallelism and Subagents

Phase 1 supports clean parallelism by avoiding agent-owned runtime state. Independent work should use independent turns and `TurnRun` handles, typically in separate sessions until multi-active-turn sessions are designed.

One session still has at most one active turn in Phase 1. This keeps transcript ordering, interruption, and TUI routing simple. Future subagent/thread support can either:

- create separate child sessions with their own turns and transcripts; or
- add multiple active turns per session as a later explicit state-machine extension.

Do not simulate parallel subagents by constructing multiple stateful `Agent` instances that each own their own transcript. The transcript belongs to the session model, not the agent model.

## Phase 1 Scope

Do:

- add session and turn types;
- make `Agent` a configuration object;
- add `AgentRunner` and `TurnRun`;
- migrate the TUI to `Session` plus `AgentRunner`;
- move `AGENTS.md` loading into session context blocks;
- move `requestedSkillName` into turn options;
- adapt middleware to runtime/model context without direct transcript mutation;
- keep step as runtime state visible through `AgentRunContext`, not as a persisted `Step`;
- preserve parallel tool invocation within a single assistant step;
- add focused tests for the state machine, interrupt/continue behavior, and synthetic tool result repair.

Do not do yet:

- compaction;
- resume;
- JSONL transcript persistence;
- multiple active turns in one session;
- first-class `Step`;
- persistence of `Session.contextBlocks`.

```ts
// TODO(trace/resume/debug): Promote Step to a first-class domain concept when
// step-level replay, timeline inspection, or resumable partial turns become necessary.
```

## Consequences

The architecture becomes easier to reason about because durable state, runtime execution, and agent capability configuration have separate owners.

The TUI will need to consume events while reading durable facts from the session. This adds some ceremony, but it avoids duplicating transcript state in UI-only structures.

The migration is intentionally breaking. That is acceptable for this fork because the goal is to evolve Helixent as a personal fork rather than maintain upstream API compatibility.
