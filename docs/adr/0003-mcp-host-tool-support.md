# ADR 0003: MCP Host Tool Support

## Status

Accepted for this fork.

## Date

2026-06-25

## Context

Helixent needs to connect to external MCP servers such as agent-memory and expose their tools to the agent without turning `Agent` or `Session` into owners of live external connections. MCP support also introduces JSON Schema tool parameters, transport lifecycle, tool-list refresh, approval defaults, and prompt-cache stability concerns.

## Decision

Helixent will implement MCP host support for tools. The MVP supports `stdio`, `streamable_http`, and `sse` transports; it does not implement MCP resources or prompts.

An app-runtime `McpManager` owns MCP connections and per-server tool snapshots. The manager is created by the CLI/app runtime, connected during startup, closed during shutdown, and passed into turn execution as a runtime dependency. `Agent` remains immutable capability configuration and `Session` remains durable conversation state; neither stores MCP connections. `TurnRun` assembles an effective tool set for each provider request from `agent.tools` plus currently visible MCP tool snapshots. It does not call remote `tools/list` for every request.

On connection, each MCP server is initialized and queried with `tools/list`; the result fills that server's local tool snapshot. `notifications/tools/list_changed` triggers an asynchronous snapshot refresh; concurrent refreshes are coalesced, successful refreshes replace the snapshot, and failed refreshes keep the previous snapshot. Manually closing or disabling a server clears its snapshot and removes its schemas from future effective tool sets. A transient transport disconnect hides that server's tools, but does not mean the user disabled it; remote transports may perform limited automatic reconnect, while stdio servers are not automatically restarted in the MVP.

MCP tools are exposed to models with Helixent-visible names of the form `mcp_<sanitized_server_name>_<sanitized_tool_name>`. The original server name and MCP tool name are retained in an explicit binding; Helixent must not infer routing by parsing the visible name. Tool calls are routed through that binding to MCP `tools/call`.

Foundation tool parameters become provider-neutral: built-in tools may continue using Zod, while MCP-discovered tools may use JSON Schema. Provider adapters render both sources as JSON Schema. MCP arguments are not fully validated by Helixent in the MVP; the owning MCP server validates them. Helixent uses a minimal MCP schema sanitizer before exposing external schemas to providers, but does not implement a full JSON Schema validator or compiler.

MCP tool results are normalized into Helixent structured tool results before entering the transcript. Text content becomes the model-visible observation; non-text MCP content is retained in structured result data with textual placeholders in the transcript. `initialize` server instructions are recorded as server metadata in the MVP, but are not injected into model context or tool descriptions.

MCP tools require approval by default unless server or tool configuration explicitly allows automatic execution. Tool calls are serial per MCP server by default, with explicit per-server opt-in for parallel calls. Optional MCP server startup failures do not block Helixent and contribute no visible tools; required MCP server failures prevent agent execution from starting. Stdio servers receive a minimal safe environment plus configured variables by default, with full environment inheritance only when explicitly configured.

MCP configuration lives under the top-level `mcpServers` field. Configuration changes take effect on the next Helixent start in the MVP. Remote authentication supports static headers and explicit environment-derived headers; OAuth, browser login, token refresh, and header helper commands are out of scope.

## Considered Options

One alternative was storing MCP tools directly on `Agent`. That would make `tools/list_changed` require mutating or rebuilding an immutable configuration object, so Helixent instead assembles effective tools at request time from runtime manager state.

Another alternative was a global registry generation model like Hermes. Helixent's MVP keeps a simpler centralized snapshot model without registry generation. Prompt-cache stability is preserved by avoiding remote `tools/list` on every provider request and by only updating snapshots when connection-time discovery, explicit close/disable, or tool-list change handling requires it.

A third alternative was full MCP capability support, including resources and prompts. Those capabilities need separate semantics in Helixent because they overlap with instruction context, prompt context, skills, and UI selection. The MVP stays tools-only.

## Consequences

The MCP integration belongs in `src/community/mcp`, with CLI/app runtime wiring responsible for manager lifecycle. Foundation must support JSON Schema-capable tool parameter schemas without making MCP a foundation dependency. `AgentRunner` and `TurnRun` need a runtime dependency path for the manager or an equivalent effective-tool provider. Provider adapters must render both Zod and JSON Schema tool parameters. The TUI should render MCP tool calls generically from binding metadata, showing server name, original tool name, and a compact argument preview.
