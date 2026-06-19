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
TurnContext;
ModelContext patch;
```

`Session.messages` contains the real transcript: user messages, assistant messages, and tool result messages. It is the durable fact stream for the session.

`Session.contextBlocks` contains durable session-level context such as `AGENTS.md`, project instructions, and user preferences. These are model-visible, but they are not ordinary user turn messages.

`Session.contextBlocks` is the Phase 1 implementation name. The target model is typed prompt context items, not an undifferentiated string list. User-global instruction files and project instruction files are the same semantic family, but different typed items with different scope, source path, precedence, and cache stability.

```ts
type PromptContextItem =
  | {
      kind: "global_user_instructions";
      sourcePath: string;
      content: string;
      cacheStable: true;
    }
  | {
      kind: "project_instructions";
      sourcePath: string;
      content: string;
      cacheStable: true;
    }
  | {
      kind: "local_project_instructions";
      sourcePath: string;
      content: string;
      cacheStable: true;
      overrideOf?: string;
    };
```

For example, a user-level `AGENTS.md` and a project-level `AGENTS.md` should not be collapsed at load time. They should be stored as separate typed context items, then rendered together during prompt assembly according to the chosen precedence order.

This keeps the source model explicit for resume, trace, cache invalidation, and debugging. It also avoids promoting user/project instruction files into `Agent.prompt`; the agent prompt remains the agent's identity and behavior contract.

Helixent should support a narrow local override file, such as `AGENTS.override.md`, but the override semantics should be explicit and scoped. A local override replaces the checked-in instruction file in the same directory; it should not silently erase global user instructions, parent-directory project instructions, or child-directory instructions. In typed form, the item should be marked as local/private and may carry an `overrideOf` reference to the source item it replaces.

Instruction precedence should be stable and source-aware:

1. global user instructions;
2. checked-in project instructions, ordered from project root toward the current working directory;
3. local/private project instructions, ordered from project root toward the current working directory;
4. explicit override items, applied only to their declared scope.

Ordinary instruction items are additive. Narrower-scope instructions can add constraints or resolve direct conflicts, but deletion/replacement should require an explicit override item. This mirrors the useful parts of the reference projects: Codex concatenates `AGENTS.md` from root to cwd and treats `AGENTS.override.md` as preferred within a directory; ClaudeCode loads managed, user, project, then local memory with later entries taking higher priority; Hermes uses a first-found priority list for project context files instead of treating all files as equal.

`TurnContext` contains prompt-visible execution facts for a specific turn execution. Phase 1 should include `currentDate`, `timezone`, `cwd`, and `model`. These facts are not conversation messages, and they are not instruction context. They should not be stored in `Session.messages`.

`currentDate` belongs in `TurnContext`, not in `PromptContextItem`. Dates are volatile, turn-scoped environment facts; instruction files are source-scoped guidance that is usually stable enough to participate in prompt caching.

By default, `TurnContext` should include date-level time information, timezone, working directory, and model identity:

```ts
interface TurnContext {
  currentDate: string; // YYYY-MM-DD in the captured timezone
  timezone: string;
  cwd: string;
  model: string;
}
```

Do not include minute- or second-precision timestamps by default. Most agent tasks need to know today's date, not the exact wall-clock time. High-precision timestamps make the volatile prompt segment change constantly and reduce prompt-cache reuse. If exact time becomes necessary, it should be exposed through an explicit opt-in field such as `currentDateTime` or through a tool that the model calls when the task actually requires wall-clock precision.

For Phase 1, `timezone` should come from the runtime's system local timezone. Do not add user config, session config, or per-turn timezone overrides yet. The captured timezone should still be recorded in the `TurnContext` snapshot and trace so debug/replay can explain which date boundary was used. If Helixent later needs remote-worker or cross-timezone behavior, add a small clock/environment provider rather than baking override policy into `Session`.

Do not include sandbox policy in `TurnContext` for Phase 1. Sandbox/permission state may be rendered elsewhere as provider or tool-use instructions, but it should not be part of this date/environment snapshot until Helixent has a separate permission-context design.

All Phase 1 `TurnContext` fields are model-visible by default. Prompt assembly should render `currentDate`, `timezone`, `cwd`, and `model` together in a volatile turn-context block. This block is outside the transcript and outside stable instruction context.

For example:

```text
<turn_context>
Current date: 2026-06-11
Timezone: Asia/Shanghai
Working directory: E:\Github\helixent\helixent
Model: gpt-5
</turn_context>
```

This makes cwd and model identity available for ordinary coding-agent reasoning without promoting them into `Session.messages` or stable prompt cache prefix. If a provider needs a different role or wrapper, that is a rendering concern; the semantic source remains the `TurnContext` snapshot.

`AgentRunner` and `TurnRun` are responsible for default `TurnContext` capture. Phase 1 should not expose a public `TurnContextProvider`, `turnContextOverride`, or test-only injection point. `runner.startTurn(...)` should be enough for normal callers:

```ts
runner.startTurn({
  session,
  agent,
  turnId,
});
```

The runtime path should capture:

```text
currentDate/timezone from the system clock
cwd from the runner/session runtime cwd
model from the Agent's model identity
```

Tests can assert behavior through the public run path or through focused pure helpers if the implementation naturally extracts them, but the domain model should not grow an override API before there is a real caller that needs it.

`TurnContext` is captured immediately before the first model request for a `TurnRun`, whether that run comes from `runner.startTurn(...)` or from continuing an interrupted turn. It is then frozen for that `TurnRun`; later ReAct steps in the same run reuse the same snapshot instead of re-reading the clock or environment.

Do not capture `TurnContext` when the `Session` is created, because a long-lived session can cross date, timezone, cwd, or model/runtime boundaries. Do not re-capture it before every ReAct step, because one execution attempt should see a coherent environment snapshot.

If a turn is interrupted and later continued, the continuation creates a new `TurnRun` and therefore a new `TurnContext` snapshot. That allows a session or turn to cross midnight without appending a synthetic date message to the transcript.

`TurnContext` is not core `Session` state. The `Session` should not own it as part of the durable conversation model, and the core in-memory `Session` state should not need it to validate turn/message ownership, resume the conversation, or expose the transcript. During execution, the active `TurnRun` owns the frozen `TurnContext` snapshot in memory so every model request in that run can render the same environment facts.

For debugging and replay, the same snapshot should be written to a trace or run record, not to `Session.messages`. A resumed live conversation should sample a fresh `TurnContext`; a replay/debug view should read the recorded snapshot to explain exactly what the model saw in the original run.

This creates one physical persistence stream with multiple semantic projections. Phase 1 should use a single session-level append-only event log, similar to Codex's rollout-style model. `Transcript`, `SessionStore`, and `TraceStore` are projections over that event log, not necessarily separate files.

- The transcript projection contains actual user, assistant, and tool messages.
- The session-state projection contains the latest conversation state needed to resume a live session: turns, transcript messages, and latest effective prompt context.
- The trace projection contains execution evidence: run records, rendered request context, `TurnContext` snapshots, model/tool events, timings, and provider metadata needed to debug or replay what happened.

Trace projection records should be written by default. "Not transcript" does not mean "not persisted"; it means persisted as execution evidence rather than conversation messages. A default trace must be lightweight enough to keep always on, but complete enough to answer what key context the model saw for a run.

Always-on trace should include:

- `TurnContext` snapshot;
- full typed `PromptContext` snapshot content, source metadata, item hashes, and aggregate hash;
- full rendered provider-neutral message snapshots for each model request;
- request ID, run ID, turn ID, step index, timing, usage, and error metadata.

Verbose trace may include heavier or more sensitive evidence:

- provider-specific raw API payloads;
- full tool inputs and outputs when they are not already transcript messages;
- streaming chunks and low-level adapter events.

For example, if a user later asks why a previous run thought the current date was `2026-06-10`, the always-on trace should be enough to inspect that run's `TurnContext` and rendered request messages. It should not require the user to have enabled debug mode beforehand.

Prompt context snapshots should store full typed item content by default. Do not persist only `sourcePath` plus `contentHash`, because that makes replay and debugging depend on mutable files outside the trace. Phase 1 does not add truncation or sensitive-content redaction policy for prompt context snapshots; those can be designed later as trace retention controls.

Rendered message snapshots should also store full provider-neutral message content by default. The trace must preserve role, ordering, wrapper text, content parts, and source mappings for each model request. Persisting only rendered hashes would leave the trace unable to explain what Helixent actually sent after prompt assembly. Provider-specific `providerRawRequest` remains optional or verbose evidence because it may duplicate rendered content while adding adapter/provider details.

Phase 1 should store all session persistence as one session-level JSONL event stream, not separate session and trace files. A single event file contains records for transcript messages, session-state changes, turn runs, interrupted-turn continuations, and model requests in that session timeline. Each record carries the IDs needed to select the desired projection and granularity.

Each JSONL record should use a stable event envelope. The envelope carries routing, ordering, and recovery fields; `data` carries the event-specific payload.

```ts
interface SessionEventEnvelope<TType extends string, TData> {
  eventId: string;
  type: TType;
  sessionId: string;
  timestamp: string;
  criticality: "session" | "trace";
  turnId?: string;
  runId?: string;
  requestId?: string;
  messageId?: string;
  data: TData;
}
```

Examples:

```jsonl
{"eventId":"evt-1","type":"message_appended","sessionId":"s1","timestamp":"2026-06-11T07:00:00.000Z","criticality":"session","turnId":"t1","messageId":"m1","data":{"message":{"role":"user","content":"帮我改一下"}}}
{"eventId":"evt-2","type":"turn_context_snapshot","sessionId":"s1","timestamp":"2026-06-11T07:00:01.000Z","criticality":"trace","turnId":"t1","runId":"r1","data":{"turnContext":{"currentDate":"2026-06-11","timezone":"Asia/Shanghai","cwd":"E:\\Github\\helixent\\helixent","model":"gpt-5"}}}
```

The envelope makes projection-aware recovery possible. If event-specific `data` fails schema validation, the reader can still use the envelope's `type` and `criticality` to decide whether resume must fail or whether the trace projection can be marked incomplete. If the whole line is not valid JSON, the reader cannot trust the envelope and should treat recovery conservatively.

Suggested layout:

```text
~/.helixent/projects/<projectKey>/
  events/<sessionId>.jsonl
```

Example records:

```jsonl
{"eventId":"evt-3","type":"turn_run_started","sessionId":"s1","timestamp":"2026-06-11T07:00:01.000Z","criticality":"trace","turnId":"t1","runId":"r1","data":{}}
{"eventId":"evt-4","type":"turn_context_snapshot","sessionId":"s1","timestamp":"2026-06-11T07:00:01.000Z","criticality":"trace","turnId":"t1","runId":"r1","data":{"turnContext":{"currentDate":"2026-06-11","timezone":"Asia/Shanghai","cwd":"E:\\Github\\helixent\\helixent","model":"gpt-5"}}}
{"eventId":"evt-5","type":"model_request","sessionId":"s1","timestamp":"2026-06-11T07:00:02.000Z","criticality":"trace","turnId":"t1","runId":"r1","requestId":"req1","data":{"stepIndex":0,"renderedMessages":[]}}
{"eventId":"evt-6","type":"turn_run_completed","sessionId":"s1","timestamp":"2026-06-11T07:00:03.000Z","criticality":"trace","turnId":"t1","runId":"r1","data":{}}
```

This makes session debugging straightforward because a continued turn naturally appears as a later run in the same event timeline. It also avoids cross-file consistency problems, such as a trace record referencing a message that failed to persist in a separate session file. If event files become too large later, Helixent can add sharding under the same record schema.

Resume should treat projections with different criticality. Session-state records are required to continue a live conversation; trace-only records are debugging evidence. If a `message_appended`, `turn_created`, `turn_status_changed`, or latest `prompt_context_set` record is corrupt or unreadable, resume should fail or require repair because the conversation state is not trustworthy. If a `model_request`, `turn_context_snapshot`, `prompt_context_snapshot`, or tool timing record is corrupt, resume may continue while marking the trace projection incomplete.

This keeps the unified event log from making debug evidence more critical than conversation recovery. A broken trace record should reduce replay/debug fidelity, not prevent the user from continuing the session when the transcript and session-state projection remain valid.

Phase 1 session-level event JSONL should include this small trace-oriented record set in addition to session-state records such as `message_appended`, `turn_created`, `turn_status_changed`, and `prompt_context_set`:

```text
turn_run_started
turn_context_snapshot
prompt_context_snapshot
model_request
model_response
tool_started
tool_finished
turn_run_completed
turn_run_failed
```

Responsibilities:

- `turn_context_snapshot` persists the full `TurnContext` for one run: `currentDate`, `timezone`, `cwd`, and `model`.
- `prompt_context_snapshot` persists full typed prompt context items, source metadata, item hashes, and aggregate hash.
- `model_request` persists full provider-neutral rendered messages for one model request, plus `requestId`, `runId`, `turnId`, and `stepIndex`.
- `model_response` records response metadata and links to appended transcript messages where applicable. It should not duplicate the full assistant message content already available from `message_appended` events.
- `tool_started` and `tool_finished` record tool execution evidence and link to the corresponding tool use/result IDs. `tool_finished` should not duplicate tool result message content already available from `message_appended` events.
- `turn_run_completed` and `turn_run_failed` close the run timeline.

Do not put streaming chunks, middleware hook events, adapter raw events, or full provider-specific payloads in the default record set. Those belong to verbose trace or a later trace extension.

The deduplication rule is: transcript message content is persisted once as `message_appended` events; trace records reference transcript messages by `messageId`. For example:

```jsonl
{"type":"model_response","sessionId":"s1","turnId":"t1","runId":"r1","requestId":"req1","assistantMessageId":"message-2","finishReason":"tool_calls","usage":{"inputTokens":100,"outputTokens":20}}
```

If a future adapter needs to preserve a raw provider response that does not map cleanly to a transcript message, store it as verbose trace evidence rather than duplicating normal assistant content in always-on trace.

The same rule applies to tool results. Successful tool result content belongs in the transcript `tool` message. Trace records keep execution metadata and references:

```jsonl
{"type":"tool_started","sessionId":"s1","turnId":"t1","runId":"r1","toolUseId":"call_1","name":"read_file","startedAt":"2026-06-11T07:00:00.000Z"}
{"type":"tool_finished","sessionId":"s1","turnId":"t1","runId":"r1","toolUseId":"call_1","status":"ok","toolResultMessageId":"message-3","durationMs":42}
```

If a tool fails before a transcript `tool_result` message is appended, `tool_finished` must still preserve an error summary so the trace does not lose the failure:

```jsonl
{"type":"tool_finished","sessionId":"s1","turnId":"t1","runId":"r1","toolUseId":"call_1","status":"error","error":"ENOENT: file not found","durationMs":42}
```

`PromptContextItem` appears in multiple projections with different semantics. In the session-state projection, it is the current effective instruction state used to continue the conversation. In the trace projection, it is the context snapshot actually used by a specific run, including source metadata and rendered ordering. If an `AGENTS.md` file changes later, existing trace records should still explain the older content that the model saw.

Prompt context loading should follow the same split. The live session should hold the current effective typed items, while each `TurnRun` freezes the used prompt context snapshot before its first model request. A running `TurnRun` must not re-read instruction files between ReAct steps or model requests.

This means instruction files are neither permanently fixed at session creation nor reloaded for every model request. Session creation or restoration establishes an effective prompt context. Before a new `TurnRun` starts, Helixent may refresh the session's effective prompt context from the current source files. The `TurnRun` then copies that effective context into a run-scoped snapshot, and every model request in that run uses the same snapshot.

If `AGENTS.md` changes while a run is active, the active run continues with its frozen snapshot. A later turn or interrupted-turn continuation may refresh and use the new effective context. Trace records should point to the run snapshot, not to whatever the source files contain later.

The session-state projection should use the latest effective prompt context snapshot, not a full history of prompt context changes. Resume only needs the current instruction state that the next run should use. Prompt context change history, old item content, and old rendered requests belong to the trace projection.

For example, the event log may contain successive state-setting records:

```jsonl
{"type":"prompt_context_set","sessionId":"s1","sourceSetHash":"sha256:aaa","items":[...]}
{"type":"prompt_context_set","sessionId":"s1","sourceSetHash":"sha256:bbb","items":[...]}
```

When restoring the session, Helixent reads the last `prompt_context_set` as the latest effective prompt context. If a user needs to understand why run `r1` used hash `aaa` while run `r2` used hash `bbb`, that question is answered from trace records in the same event log, not from the resume projection.

Prompt context refresh should be automatic before every new `TurnRun`. The refresh should be cheap when nothing changed: check the discovered instruction source set and source metadata/content hashes, reuse the existing effective context when the hashes match, and reload typed items only when the source set or content hash changes.

This is a pre-run refresh, not a per-model-request reload. It applies when starting a new turn and when continuing an interrupted turn, because both create a new `TurnRun`. It does not apply between ReAct steps inside an active run.

Prompt context hashes should be source-aware. Helixent should compute and persist both per-item hashes and an aggregate effective context hash:

```ts
interface PromptContextItem {
  id: string;
  kind:
    | "global_user_instructions"
    | "project_instructions"
    | "local_project_instructions";
  sourcePath: string;
  scope: "user" | "project" | "local_project";
  precedence: number;
  content: string;
  contentHash: string;
  contentLength: number;
}

interface EffectivePromptContext {
  sourceSetHash: string;
  items: PromptContextItem[];
}
```

The aggregate `sourceSetHash` is derived from the ordered source set and each item's source metadata and `contentHash`. It is useful for quick equality checks. The per-item `contentHash` is the debugging and trace unit: it lets UI/trace explain that one nested `AGENTS.md` changed while the global and root project instructions stayed the same.

Do not use only a hash of the final concatenated prompt text. A concatenated hash can detect that something changed, but it loses the source boundary needed for selective reload, trace diffs, prompt cache boundaries, and user-facing diagnostics. The rendered prompt may still have its own request-level hash, but that is separate evidence from the typed source-aware context hash.

The intended behavior is:

```text
new TurnRun starts
  discover instruction sources
  compare source set + hash/mtime metadata with current effective context
  unchanged -> reuse current effective PromptContextItem[]
  changed -> reload typed items and update the session-state projection's effective context
  freeze used PromptContextSnapshot for this TurnRun
```

This matches the user expectation that editing `AGENTS.md` affects the next run in the same live session, while preserving cache and replay stability within a run. It is closest to Codex's per-turn context snapshot model, but keeps the reload cheap like ClaudeCode's cached user-context path and avoids Hermes-style full session immutability for instruction files.

When refresh detects changed instruction files, Helixent should not add a model-visible "context changed" notice by default. The next run should simply render the current effective instructions. The change itself belongs in trace/UI evidence, where it can explain why one run saw different instruction content from another run without spending model tokens or disturbing prompt cache.

A model-visible change notice may still be injected deliberately by middleware for a concrete workflow, such as explaining a user-requested rule update. That notice is a runtime `ModelContext` patch, not a transcript message and not part of the durable instruction source model.

The trace projection should preserve both a typed prompt context snapshot and a rendered prompt context snapshot:

- the typed snapshot preserves full content, `kind`, `sourcePath`, content hash, scope, precedence, and cache stability for each context item;
- the rendered snapshot preserves the provider request message list after prompt assembly, including each message's role, content, ordering, wrappers, and source item mapping.

These are complementary evidence. The typed snapshot explains where context came from and how it should participate in cache/diff logic. The rendered snapshot proves what the provider request actually looked like. Storing only source paths and hashes makes replay depend on mutable files; storing only rendered text loses source and cache semantics.

The rendered snapshot should not be collapsed into a single concatenated string. The canonical trace shape should be provider-neutral rendered messages after Helixent prompt assembly but before provider-adapter lowering. A provider-specific raw request payload is optional evidence recorded after adapter lowering when an adapter materially changes roles, wrappers, cache-control annotations, tool schema placement, or content part structure.

The provider-neutral rendered messages are the default trace truth for Helixent behavior. The provider raw request is additional adapter evidence for debugging the exact API payload; it should not replace the provider-neutral snapshot.

Trace granularity should separate run-scoped snapshots from request-scoped snapshots. A `TurnRun` trace record owns the shared typed prompt context snapshot and the shared `TurnContext` snapshot for that execution attempt. Each model request inside that `TurnRun` owns its own rendered message snapshot, because ReAct steps add assistant messages, tool calls, and tool results between model requests.

```ts
interface TurnRunTraceRecord {
  runId: string;
  sessionId: string;
  turnId: string;
  promptContextSnapshotId: string;
  turnContextSnapshotId: string;
}

interface ModelRequestRecord {
  requestId: string;
  runId: string;
  stepIndex: number;
  renderedMessages: RenderedPromptMessage[];
  providerRawRequest?: unknown;
}
```

This keeps stable/shared context facts from being duplicated on every model request while still preserving the exact rendered messages that caused each model response.

The runtime execution objects (`AgentRunner`, `TurnRun`, `AgentRunContext`) are not themselves the trace system. They may emit or hand off evidence to a trace writer, but the trace remains a separate record keyed by shared IDs such as `sessionId`, `turnId`, `runId`, `messageId`, and `toolUseId`.

`ModelContext` patches are runtime-only request shaping, such as skills listings, selected skill hints, middleware-provided prompt additions, and provider options.

`AGENTS.md` belongs in `Session.contextBlocks`, not in `Session.messages`.

`createCodingAgent(...)` should stop loading `AGENTS.md` as initial agent messages. Session creation or a coding-session factory should load those files into `Session.contextBlocks`.

Prompt assembly should be a first-class provider-neutral boundary, not private string/message construction hidden inside `Model`. Phase 1 should extract a pure renderer that takes the semantic prompt inputs and returns the exact provider-neutral message list Helixent will send to the model layer.

The target shape is:

```ts
interface PromptAssemblyInput {
  agentPrompt: string;
  promptContextItems: PromptContextItem[];
  turnContext: TurnContext;
  transcriptMessages: NonSystemMessage[];
}

interface RenderedModelRequest {
  messages: RenderedPromptMessage[];
}

function renderModelRequest(input: PromptAssemblyInput): RenderedModelRequest;
```

Responsibilities:

- `TurnRun` owns runtime capture: refresh effective prompt context, freeze used prompt context snapshot, capture `TurnContext`, invoke prompt assembly, and append `model_request` trace records.
- the prompt assembler owns provider-neutral ordering, wrappers, source mappings, and cache segment metadata;
- `Model` owns provider invocation and provider adapter lowering;
- provider adapters own provider-specific role mapping, content-part lowering, tool schema placement, cache-control annotations, and optional `providerRawRequest` evidence.

This is intentionally stronger than the current implementation, where `Model._buildModelProviderParams(...)` privately assembles messages from `prompt`, `contextBlocks`, and `messages`. Keeping assembly private inside `Model` prevents `TurnRun` from recording the full rendered messages before the provider request. Moving assembly into `TurnRun` directly would make the agent layer know too much about model request construction. A shared provider-neutral assembler keeps the responsibilities explicit.

The execution path should become:

```text
TurnRun
  captures TurnContext
  freezes PromptContext snapshot
  applies middleware ModelContext patches
  calls renderModelRequest(...)
  writes model_request trace with full renderedMessages
  calls Model with rendered provider-neutral request

Model
  lowers rendered provider-neutral request through provider adapter
  invokes provider
```

This mirrors the useful parts of the reference projects: Codex has model-visible context items that can be recorded in rollout evidence; ClaudeCode can preserve the exact request message set for debug/share; Hermes keeps prompt building in explicit prompt-builder modules rather than burying it in provider calls.

`Model` should receive an already rendered provider-neutral request. Remove the old semantic `model.invoke(context)` / `model.stream(context)` API rather than keeping it as the primary path. `TurnRun` should call the prompt assembler once, write the `model_request` trace from that exact object, and pass the same object to `Model`.

Target model-facing API:

```ts
interface RenderedModelRequest {
  model: string;
  messages: Message[];
  tools?: Tool[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

model.invokeRendered(request: RenderedModelRequest);
model.streamRendered(request: RenderedModelRequest);
```

Do not have both `TurnRun` and `Model` independently render messages. Double rendering risks trace drift, where the recorded `renderedMessages` differ from the request actually sent to the provider. If a convenience API is reintroduced later, it must delegate through the same prompt assembler and expose the rendered request for trace before invocation.

Prompt layer meanings:

- `Agent.prompt` is the agent's system prompt: identity, behavior contract, and tool-use policy.
- `Session.contextBlocks` are the current coarse representation for session-level instruction context: user-global instructions, project instructions, project conventions, and preferences.
- `TurnContext` is a per-`TurnRun` environment snapshot: date, timezone, cwd, model identity, and similar volatile execution inputs.
- Turn input is the user's task prompt for that turn.

`Session.contextBlocks` may be rendered as contextual user instructions or another provider-specific prompt slot, but conceptually they are not turn input.

`TurnContext` may also be rendered into the provider request, but should be rendered outside the transcript. Prompt cache implementations should be able to keep stable agent/instruction prefix content separate from volatile turn context.

Prompt assembly order should be cache-aware. When provider semantics allow it, render model-visible inputs in this order:

1. stable agent/system identity and tool behavior contract;
2. stable instruction context, ordered by precedence, such as global user instructions, project instructions, and local/private project instructions if supported;
3. volatile `TurnContext`, such as date, timezone, cwd, and model identity;
4. transcript messages.

This order makes date and environment changes invalidate only the volatile suffix instead of the stable agent and instruction prefix. The order is a prompt assembly strategy, not a transcript rule: `TurnContext` still does not become a session message, and instruction context still remains source-aware typed context even if rendering merges it into one provider-visible section.

Trace records should preserve cache-relevant boundaries. Rendered message snapshots should retain enough segment metadata to identify which rendered messages or content parts came from stable agent prompt, stable instruction context, volatile `TurnContext`, or transcript. Provider-specific cache-control annotations, when emitted by an adapter, belong in optional adapter evidence such as `providerRawRequest`.

This follows the broad shape of the reference agents:

- Codex resolves `AGENTS.md` into `user_instructions` and injects it as contextual user/developer context, not as a normal user turn message.
- ClaudeCode loads `CLAUDE.md` into `userContext.claudeMd` and prepends it when constructing a model request; subagents may omit it to save tokens.
- Hermes folds project context files into the system prompt context tier and stores system prompt separately from ordinary messages.

Prompt assembly may merge typed instruction items into one provider-visible context section for token efficiency or provider compatibility. That merge is a rendering concern only; the durable session/trace representation should preserve item boundaries and source metadata.

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
- implement Phase 1 prompt context and trace architecture as a coherent slice:
  event envelope and session-level event log,
  provider-neutral prompt assembler,
  rendered `Model` API,
  `TurnContext` capture/render/trace,
  typed prompt context items,
  `AGENTS.override.md`,
  item hashes and aggregate source-set hash,
  automatic pre-run prompt context refresh;
- move `requestedSkillName` into turn options;
- adapt middleware to runtime/model context without direct transcript mutation;
- keep step as runtime state visible through `AgentRunContext`, not as a persisted `Step`;
- preserve parallel tool invocation within a single assistant step;
- add focused tests for the state machine, interrupt/continue behavior, and synthetic tool result repair.

Do not do yet:

- compaction;
- resume;
- separate JSONL transcript persistence outside the unified event log;
- multiple active turns in one session;
- first-class `Step`;
- separate persistence of `Session.contextBlocks` outside typed prompt context events.

Implementation order for the prompt context and trace slice:

1. Add the session event envelope and session-level event log writer/reader.
2. Extract provider-neutral prompt assembly and switch `Model` to rendered request APIs.
3. Add `TurnContext` capture, volatile rendering, and trace records.
4. Introduce typed `PromptContextItem`s while preserving a compatibility adapter for existing `contextBlocks`.
5. Add `AGENTS.override.md`, source-aware item hashes, aggregate source-set hash, and automatic pre-run refresh.
6. Add focused tests for event projection, prompt assembly ordering, rendered model requests, trace records, and refresh behavior.

```ts
// TODO(trace/resume/debug): Promote Step to a first-class domain concept when
// step-level replay, timeline inspection, or resumable partial turns become necessary.
```

## Consequences

The architecture becomes easier to reason about because durable state, runtime execution, and agent capability configuration have separate owners.

The TUI will need to consume events while reading durable facts from the session. This adds some ceremony, but it avoids duplicating transcript state in UI-only structures.

The migration is intentionally breaking. That is acceptable for this fork because the goal is to evolve Helixent as a personal fork rather than maintain upstream API compatibility.
