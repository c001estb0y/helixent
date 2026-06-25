# Helixent

Helixent models ReAct-style agent execution with explicit boundaries between what the agent is, what the model sees as context, and what actually happened in the conversation.

## Language

**Agent prompt**:
The agent's built-in identity and behavior contract.
_Avoid_: project instructions, user memory

**Instruction context**:
User- or project-provided guidance that is model-visible but is not part of the conversation transcript.
_Avoid_: agent identity, transcript message

**Local project instructions**:
Private project-scoped instruction context that is narrower than checked-in project instructions.
_Avoid_: global user instructions

**Instruction override**:
An explicit local instruction item that replaces another instruction item within a defined scope.
_Avoid_: later text wins

**Prompt context item**:
A source-aware instruction or environment fact prepared for prompt assembly.
_Avoid_: raw context string, chat message

**Prompt context item hash**:
The content hash for one prompt context item and its source metadata.
_Avoid_: session hash

**Effective prompt context**:
The current prompt context items a live session would use for a future run.
_Avoid_: prompt context snapshot

**Effective prompt context hash**:
The aggregate hash for the current source set and prompt context item hashes.
_Avoid_: prompt context item hash

**Prompt context refresh**:
The pre-run check that detects changed instruction sources and updates effective prompt context.
_Avoid_: model request rendering

**Prompt context snapshot**:
The prompt context items actually used by one run.
_Avoid_: current instruction state

**Rendered prompt context snapshot**:
The provider-neutral request message list produced by Helixent prompt assembly for one run.
_Avoid_: prompt context item, concatenated prompt string

**Prompt assembler**:
The provider-neutral renderer that turns agent prompt, prompt context, turn context, and transcript into rendered model request messages.
_Avoid_: provider adapter

**Rendered model request**:
The provider-neutral model request produced by prompt assembly before provider adapter lowering.
_Avoid_: provider raw request

**Context budget**:
The model-visible capacity Helixent allocates across a rendered model request.
_Avoid_: transcript limit, message limit

**Model context window**:
The model-specific maximum context capacity Helixent uses as the upper bound for a context budget.
_Avoid_: provider usage, token estimate

**Known model context window**:
A model context window resolved from Helixent-owned model metadata.
_Avoid_: guessed window, provider default

**Non-compactable request context**:
Model-visible request context that must remain current rather than being summarized from transcript history.
_Avoid_: fixed overhead, unimportant context

**Compactable transcript context**:
The model-visible request context derived from transcript messages and eligible for lossy summarization.
_Avoid_: full prompt, all context

**Transcript compaction**:
A lossy transcript rewrite that installs a synthetic continuity summary plus preserved tail as the active transcript.
_Avoid_: prompt compaction, deleting history

**Compact summary message**:
A synthetic user-role transcript message that carries continuity summary after transcript compaction.
_Avoid_: user input, system prompt

**Compaction source material**:
The transcript portion rendered as evidence for compact summary generation, distinct from the replacement transcript installed after compaction.
_Avoid_: active transcript, provider request

**Preserved tail**:
The recent contiguous transcript suffix kept after transcript compaction, with message order and tool-pair structure preserved.
_Avoid_: recent user messages, last prompt

**Token estimate**:
A conservative local approximation of rendered request size used when provider token counting is unavailable.
_Avoid_: exact token count, billing usage

**Provider raw request**:
The provider-specific API payload after adapter lowering.
_Avoid_: rendered prompt context snapshot

**Prompt assembly order**:
The cache-aware ordering used to render agent prompt, instruction context, turn context, and transcript into model request messages.
_Avoid_: transcript order

**Prompt cache segment**:
A rendered prompt region with shared cache stability, such as stable agent instructions or volatile turn context.
_Avoid_: prompt context item

**Model request record**:
Trace evidence for one model request within a turn run.
_Avoid_: turn run trace record

**Trace record**:
One append-only execution evidence entry in a session-level trace.
_Avoid_: transcript message

**Session event log**:
The append-only physical event stream for one session.
_Avoid_: transcript

**Event envelope**:
The stable outer shape for one session event log record.
_Avoid_: event payload

**Projection**:
A derived view over the session event log, such as transcript, session state, or trace.
_Avoid_: physical store

**Trace incomplete**:
A degraded debug state where session resume can proceed but some execution evidence is unavailable.
_Avoid_: session corruption

**Transcript**:
The ordered record of user, assistant, and tool messages that actually happened in a session.
_Avoid_: trace, log, prompt

**Turn context**:
Per-turn-run execution facts, such as current date and timezone, that may be shown to the model without becoming conversation messages.
_Avoid_: transcript metadata

**Trace**:
A richer debugging record that may include transcript, prompt context items, turn context, events, timings, and model/tool metadata.
_Avoid_: transcript

**Session core state**:
The durable conversation state needed to continue a session, excluding execution-attempt snapshots.
_Avoid_: trace, run record

**Session store**:
Projection for conversation state.
_Avoid_: trace store

**Trace store**:
Projection for execution evidence.
_Avoid_: session store

**Always-on trace**:
The default lightweight execution evidence recorded for every run.
_Avoid_: verbose trace

**Verbose trace**:
Optional heavier execution evidence for deep debugging.
_Avoid_: always-on trace

**Session-level trace**:
A trace projection organized around one session timeline, with run and request records inside it.
_Avoid_: per-run physical file

**MCP host**:
The Helixent-side participant that connects to external MCP servers and exposes their capabilities to an agent.
_Avoid_: MCP server, provider adapter

**MCP server**:
An external capability provider that publishes tools, resources, or prompts over the Model Context Protocol.
_Avoid_: MCP host, model provider

**MCP transport**:
The communication channel used between an MCP host and an MCP server.
_Avoid_: tool schema, model provider

**MCP server configuration**:
The `mcpServers` configuration entry that tells Helixent how to connect to an MCP server.
_Avoid_: MCP tool schema, Agent configuration

**MCP stdio environment**:
The environment variables Helixent passes to a stdio MCP server process.
_Avoid_: host process environment, provider credentials

**MCP server instructions**:
Optional server-level guidance returned by MCP initialize.
_Avoid_: tool description, Helixent instruction context

**MCP remote authentication**:
Static request headers and environment-derived headers used by remote MCP transports.
_Avoid_: OAuth flow, browser login

**MCP environment header**:
A remote MCP request header whose value is resolved from an environment variable at runtime.
_Avoid_: string interpolation, checked-in secret

**Streamable HTTP MCP transport**:
The HTTP-based MCP transport selected by `streamable_http` configuration.
_Avoid_: https transport, SSE transport

**MCP-discovered tool**:
A tool definition learned from an MCP server and made available through Helixent's tool system.
_Avoid_: built-in coding tool, provider function

**MCP tool support**:
Helixent's MCP host capability for discovering and calling MCP server tools.
_Avoid_: MCP resource support, MCP prompt support

**MCP connection manager**:
The app-runtime owner of live MCP server connections and their discovered capabilities.
_Avoid_: agent state, session state

**MCP tool registry**:
The local projection of tool definitions discovered from connected MCP servers.
_Avoid_: remote tool list, agent tools

**MCP tool snapshot**:
The current local set of model-visible tool definitions for one connected MCP server.
_Avoid_: remote tool list, tool cache generation

**Effective tool set**:
The model-visible tools assembled for one model request from agent-configured tools and current MCP tool snapshots.
_Avoid_: agent tools, MCP registry

**MCP tool binding**:
The mapping from a Helixent-visible MCP tool name to the original MCP server name and tool name.
_Avoid_: parsed tool name, inferred server name

**MCP tool display**:
The generic UI rendering of an MCP tool call using its server name, original tool name, and argument preview.
_Avoid_: sanitized tool name as display truth

**MCP tool approval policy**:
The rule that decides whether an MCP-discovered tool may run automatically or must ask the user first.
_Avoid_: transport trust, server capability

**MCP tool call scheduling**:
The ordering policy Helixent applies when executing MCP-discovered tools against a server.
_Avoid_: agent parallelism, model tool choice

**Required MCP server**:
An MCP server whose connection failure should prevent starting agent execution.
_Avoid_: trusted server, built-in tool

**Transient MCP disconnect**:
An unexpected MCP transport loss where Helixent hides the server's tools without treating the server as manually disabled.
_Avoid_: manual close, tool-list change

**Tool parameter schema**:
The provider-neutral description of a tool's accepted input shape, sourced from either Zod or JSON Schema.
_Avoid_: Zod-only parameters, provider tool schema

**MCP schema sanitizer**:
The minimal cleanup step that turns external MCP tool schemas into provider-safe tool parameter schemas.
_Avoid_: JSON Schema validator, schema compiler

## Relationships

- An **Agent prompt** is agent-owned; **Instruction context** is user- or project-owned.
- **Local project instructions** are still **Instruction context**, but they should have narrower scope and explicit source metadata.
- An **Instruction override** must be explicit; ordinary later instruction text is additive unless a conflict-resolution rule applies.
- **Instruction context** may be represented as one or more **Prompt context items**.
- A **Prompt context item hash** identifies one source-aware item; an **Effective prompt context hash** identifies the current ordered source set.
- **Effective prompt context** is live session state; a **Prompt context snapshot** is the frozen context actually used by one run.
- A **Prompt context refresh** updates **Effective prompt context** before a new run; it does not mutate an active run's **Prompt context snapshot**.
- A **Prompt context item** in the **Session store** is current instruction state; a **Prompt context snapshot** in the **Trace store** is typed evidence of what one run used.
- A **Rendered prompt context snapshot** records the prompt context after rendering, including provider-visible message boundaries, ordering, roles, and wrappers.
- A **Prompt assembler** produces a **Rendered model request** before provider-specific lowering.
- A **Provider raw request** is adapter evidence; it may accompany a **Rendered prompt context snapshot**, but does not replace it.
- A **Rendered model request** consumes **Context budget** across agent prompt, instruction context, turn context, transcript, and tools.
- A **Context budget** is bounded by a **Known model context window** when automatic compaction is enabled.
- **Transcript compaction** changes **Compactable transcript context**, not **Non-compactable request context**.
- **Transcript compaction** installs a new active **Transcript** while the **Session event log** remains append-only evidence.
- A **Compact summary message** is part of the active **Transcript**, but it is not user-authored input.
- **Compaction source material** may include user, assistant, and tool transcript evidence that will not remain verbatim in the replacement **Transcript**.
- A **Preserved tail** may include user, assistant, and tool messages; it preserves their transcript order and complete tool pairs, though oversized tool result content may be shortened with an explicit truncation marker.
- A **Token estimate** may guide **Transcript compaction**, but it is distinct from provider-reported usage.
- **Prompt assembly order** should keep stable **Prompt cache segments** before volatile **Turn context** when provider semantics allow it.
- A **Model request record** owns request-scoped rendered messages; a **Turn context** snapshot is shared across a turn run.
- A **Session event log** physically stores mixed event types; **Transcript**, **Session store**, and **Trace store** are projections over it.
- An **Event envelope** carries routing and recovery fields; event-specific data belongs in its payload.
- A **Transcript** may be derived from the same **Session event log** as a **Trace**, but it includes only actual conversation messages.
- **Turn context** can affect a model request without becoming part of the **Transcript**.
- **Turn context** is separate from **Instruction context**; dates and timezones are execution facts, not user or project instructions.
- A continued **Turn** may receive a new **Turn context** snapshot because the continuation is a new execution attempt.
- **Turn context** belongs to a run attempt and its **Trace**, not to **Session core state**.
- A **Session store** and a **Trace store** may share IDs and the same physical **Session event log**, but they project different facts.
- An **Always-on trace** should be sufficient to explain the key context a model saw; a **Verbose trace** may add heavier provider/tool payloads.
- A **Session-level trace** may contain many turn runs and model requests, each distinguished by IDs.
- A **Trace record** is not a **Transcript** message, even when it references a transcript `messageId`.
- **Trace incomplete** is acceptable when trace-only records are damaged; it must not be confused with damaged session-state records.
- An **MCP host** connects to one or more **MCP servers** through **MCP transports**.
- An **MCP server** may publish one or more **MCP-discovered tools**.
- An **MCP-discovered tool** is an agent capability, but its invocation evidence belongs in the **Transcript** and **Trace** like any other tool use.
- Helixent MCP host support includes `stdio`, `streamable_http`, and `sse` **MCP transports**.
- A **Streamable HTTP MCP transport** may use an `https://` URL, but `https` is not the transport name.
- **MCP server configuration** lives under the `mcpServers` top-level configuration field.
- **MCP server configuration** changes take effect on the next Helixent start in the MVP.
- **MCP stdio environment** defaults to a minimal safe environment plus configured variables; full host environment inheritance requires explicit configuration.
- **MCP server instructions** are recorded as server metadata in the MVP, but they are not injected into model context or tool descriptions.
- **MCP remote authentication** in the MVP does not include OAuth, browser login, or token refresh.
- **MCP environment headers** are configured explicitly; Helixent does not use `${ENV}` string interpolation for MCP headers.
- An **MCP connection manager** is outside **Agent** and **Session** ownership; it supplies **MCP-discovered tools** to agent capability assembly.
- An **MCP connection manager** updates the **MCP tool registry** after connection-time discovery or a server tool-list change.
- An **MCP tool registry** contains one **MCP tool snapshot** per connected **MCP server**.
- **MCP tool support** in the MVP covers tools only; MCP resources and prompts are outside the MVP.
- A server tool-list change triggers an asynchronous **MCP tool snapshot** refresh; refresh failures keep the previous snapshot.
- An **Effective tool set** is assembled at model-request time; it does not mutate the **Agent**.
- **Agent** tools are configuration, while **MCP tool snapshots** are app-runtime state.
- An **MCP connection manager** is passed into turn execution as a runtime dependency, not stored on **Agent** or **Session**.
- An **MCP-discovered tool** uses an **MCP tool binding** to call its original **MCP server** tool; Helixent must not infer that binding by parsing the model-visible tool name.
- **MCP tool display** uses **MCP tool binding** metadata when available and falls back to the Helixent-visible tool name.
- An **MCP tool approval policy** defaults to requiring approval unless server or tool configuration explicitly allows automatic execution.
- **MCP tool call scheduling** is serial per server by default, with explicit per-server opt-in for parallel calls.
- MCP integration code belongs in `community/mcp`; Foundation only owns provider-neutral tool schema concepts.
- A failed optional **MCP server** contributes no **MCP tool snapshot**; a failed **Required MCP server** prevents agent execution from starting.
- Closing or disabling an **MCP server** clears its **MCP tool snapshot**, removing its schemas from subsequent **Effective tool sets**.
- A **Transient MCP disconnect** hides the server's **MCP tool snapshot** from subsequent **Effective tool sets** but does not mean the user disabled the server.
- A **Transient MCP disconnect** on a remote MCP transport may trigger limited automatic reconnect; stdio servers are not automatically restarted in the MVP.
- Each model request receives a freshly assembled **Effective tool set** from **Agent** tools and current **MCP tool snapshots**.
- A **Tool parameter schema** may originate from Zod for built-in tools or JSON Schema for **MCP-discovered tools**.
- Provider adapters render every **Tool parameter schema** as JSON Schema for model requests.
- An **MCP schema sanitizer** is used for external MCP tool schemas in the MVP, but it is not a full JSON Schema validator or compiler.
- **MCP-discovered tool** arguments are validated by the owning **MCP server** in the MVP; Helixent only ensures the call targets a known **MCP tool binding**.
- **MCP-discovered tool** results are normalized into Helixent structured tool results before becoming **Transcript** tool results.
- Non-text MCP tool result content is retained in structured result data while the **Transcript** tool result receives a textual placeholder in the MVP.

## Example dialogue

> **Dev:** "Should the user's global AGENTS.md become part of the agent prompt?"
> **Domain expert:** "No. It is **Instruction context**. Keep it separate from **Agent prompt**, preserve its source as a **Prompt context item**, and render it during prompt assembly."

## Flagged ambiguities

- "context" can mean **Instruction context**, **Turn context**, or provider request context. Use the narrower term when discussing persistence, transcript semantics, or prompt cache.
- "token count" can mean a provider-reported usage value or a local **Token estimate**; resolved: compact triggering may use **Token estimate** when provider counting is unavailable.
- `AGENTS.md` can exist at user and project scopes. Both are **Instruction context**, not **Agent prompt**.
- Local override files are **Local project instructions**, not a general license to replace every broader instruction.
- `currentDate` belongs to **Turn context**, not **Instruction context** or **Transcript**.
- "MCP support" can mean implementing an **MCP host** or exposing Helixent as an **MCP server**; resolved: the current plan is host support first, with external servers as capability providers.
- "https MCP" should be called **Streamable HTTP MCP transport** when referring to the MCP transport; `https://` is only the URL scheme.
- "dirty" for MCP tools means an **MCP tool snapshot** needs refresh; do not imply a cache generation unless cache invalidation is explicitly being designed.
