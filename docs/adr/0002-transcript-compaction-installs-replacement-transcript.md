# ADR 0002: Automatic Transcript Compaction

## Status

Accepted for this fork.

## Date

2026-06-19

## Context

Helixent needs automatic context compaction for long ReAct-style sessions. Token pressure is measured against the full rendered model request, including agent prompt, prompt context, turn context, transcript, and tool schemas, but the compactable part is the transcript history. The first implementation targets providers such as DeepSeek V4 where provider-side token counting may be unavailable.

## Decision

Automatic compaction uses Helixent-owned model metadata to resolve a known model context window. DeepSeek V4 is treated as a known large-context model by default, so users do not need to configure its context window manually. The first DeepSeek metadata table uses exact normalized model-name matches: `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-chat`, and `deepseek-reasoner` resolve to a 1,000,000-token model context window. Helixent should not treat every model name containing `deepseek` as 1M context; unknown or custom DeepSeek-like names should remain unknown unless explicitly added to Helixent-owned metadata later. If a model does not resolve to a known context window, automatic compaction is disabled for that model rather than guessing a fallback window.

Provider `countTokens` support is not required for the first implementation. Helixent uses a conservative local token estimate to size the rendered model request. The estimate must include agent prompt, prompt context, turn context, transcript messages, and tool schemas. Provider-reported usage remains useful evidence after a model response, but it is not required to decide whether a future request should compact.

The first estimator uses a simple request-level formula: count text-like rendered request content and tool schemas as `ceil(serializedChars / 3)`, and count each `image_url` content block as 2,000 tokens. Image blocks should be represented as compact textual placeholders when building the summary input, so the summary knows an image existed without pretending to preserve visual details.

The first implementation uses the active agent's main model to generate compact summaries. Helixent should not introduce a separate compact model selection path until the core compaction semantics are stable. Compact summary generation sends no tool schemas and permits no tool calls; the model summarizes only the transcript text selected for compaction. Compact summary generation must not recursively trigger automatic compaction.

The summary generation request should use a bounded output budget so compaction cannot immediately refill the context window. The first implementation should compute the summary output cap as `min(20_000, max(4_000, compactedInputEstimate * 0.10))` tokens and pass it as a temporary `max_tokens` model option when the provider supports that option. This cap applies only to the summary generation request and must not change the agent model's normal options for future turns.

Compact summaries should follow a Claude Code-style nine-section structure so the next model turn receives a continuation checkpoint rather than a casual chat summary:

1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work
9. Optional Next Step

The summary prompt may ask the model to self-check for completeness, but only the summary checkpoint is installed into the replacement transcript. The installed summary should preserve exact file paths, function names, command outcomes, decisions, user corrections, and the immediate next step when one exists. Empty sections should be explicit rather than omitted.

The compaction source material should be serialized as provider-neutral labeled text rather than as provider-specific chat messages. Each transcript message should carry its message id and role. User text and assistant text are included as text; image URL blocks are replaced with textual placeholders; assistant `tool_use` blocks are serialized with id, tool name, and JSON input; and `tool_result` blocks are serialized with their matching `tool_use_id` and content. Long tool result content in the summary source material may use explicit head/tail truncation markers. Provider-exposed thinking blocks are not included in the first version's summary input. This source material is embedded in the compact summary prompt as transcript evidence and is sent without tool schemas.

If compact summary generation fails, Helixent aborts the compaction attempt and keeps the active transcript unchanged. It must not install a static fallback summary such as "summary unavailable", because that would drop evidence without preserving meaning. The failed attempt should be recorded in the session event log with the error and token estimate details so the next turn can decide whether to retry, warn, or continue without compacting.

After an automatic compaction failure, the current `TurnRun` should skip further automatic compaction attempts even if later model steps still exceed the trigger threshold. This prevents a failed summary request from creating a repeated compact-fail loop inside one ReAct turn. A later turn, started by new user input or steer input, may attempt automatic compaction again. Future manual compaction should be allowed to bypass this per-turn failure guard.

Automatic compaction triggers when the estimated rendered request reaches 85% of the effective input budget. The compacted result should target about 55% of the effective input budget so the session does not compact again after only one or two turns.

The first implementation runs automatic compaction only before a model request is sent. A turn run estimates the rendered request, compacts if the 85% trigger is reached, installs the replacement transcript on success, and then renders the model request again from the compacted transcript. It does not attempt reactive compaction after provider prompt-too-long errors, and it does not compact in the middle of an active model/tool loop.

The implementation belongs to the turn execution runtime, not to the `Agent` configuration object. `TurnRun` should trigger the pre-request compaction check, a `src/agent/compaction/*` module should hold token estimation, tail selection, summary prompting, and orchestration helpers, and `Session` should expose the state-changing installation method that replaces the active transcript and records the session event.

Transcript compaction installs a replacement active transcript. The replacement transcript starts with a user-role synthetic compact summary message, marked with metadata such as `synthetic: true` and `source: "compact"`, followed by the preserved tail messages. The preserved tail is a contiguous transcript suffix, not a user-message-only extract: it keeps user, assistant, and tool messages in transcript order so recent user intent stays attached to the assistant reasoning, actions, and observations that followed. The summary text must explicitly say it is background context from transcript compaction, not a new user request. Future assistant and tool messages append to this replacement transcript, not to the pre-compaction transcript.

The compact boundary must preserve complete tool pairs. A replacement transcript must not contain a `tool_result` whose corresponding assistant `tool_use` was compacted away, and it must not contain an assistant `tool_use` whose corresponding `tool_result` was compacted away. The first implementation should prefer simple safe boundaries: start the preserved tail at or before the most recent user message, include every following assistant and tool message, and expand the boundary backward when needed to keep tool pairs complete.

If the preserved tail alone exceeds the compact target budget, the first implementation may shorten `tool_result` content inside the preserved tail, but it must not remove the tool result message or split the surrounding tool pair. It should truncate the largest eligible tool results first. Each shortened tool result should preserve both the head and tail of the original result and include an explicit marker such as `[..., tool_result truncated during transcript compaction: originalChars=123456, keptHeadChars=6000, keptTailChars=3000, ...]`. It must not truncate user messages, assistant text, assistant `tool_use` blocks, or image placeholders. If the tail still exceeds the compact target after eligible tool results are shortened, Helixent aborts the compaction attempt and keeps the active transcript unchanged.

The session event log remains append-only evidence. Compact installation should be recorded as a session-critical `transcript_compacted` event that captures the compacted boundary, summary, replacement transcript, preserved tail identifiers, token estimate details, model context window metadata, and enough source evidence to debug or reconstruct what happened before compaction. Its payload should include the new synthetic `summaryMessage`, `compactedMessageIds`, `preservedTailMessageIds`, `replacementMessageIds`, `tokenEstimate`, `modelContextWindow`, and `reason: "auto-pre-request"`. The active transcript is the compacted continuation; the event log is the durable audit trail.

Failed compaction attempts should be recorded as trace evidence, such as `transcript_compaction_failed`, with the error, token estimate, model context window metadata, and reason. A failed attempt must not change the active transcript projection.

## Considered Options

One alternative was request-time projection: keep the original active transcript unchanged and inject `summary + tail` only when rendering a model request. That keeps the original transcript pristine, but it makes the model-visible conversation differ from the session's active conversation after every compact, and it complicates continuation semantics. Installing a replacement transcript is easier to understand, closer to Codex, Claude Code's main compact path, and Hermes-agent, and keeps `Session.messages` aligned with what the model will see after compaction.

Another alternative was requiring users to configure context windows. That would avoid stale built-in metadata, but it makes the common DeepSeek V4 path harder to use and creates a footgun where compaction silently never works until users discover the setting. Helixent should provide defaults for known models and disable automatic compaction only for unknown models.

A third alternative was calling provider token-count APIs before compacting. That is more accurate where supported, but DeepSeek-compatible providers may not expose such an API. The first implementation should be provider-portable and can add optional provider counting later as a refinement.

## Consequences

Compaction is a semantic boundary in the active transcript. UI, trace, and debug tools must be able to distinguish synthetic compact summaries from user-authored messages. Tests should cover that tool call and tool result pairs are not split across the compact boundary, that recent tail message order is preserved, that tool result truncation is explicit and limited to eligible tail tool results, that unknown models do not auto-compact, that the 85% trigger and 55% target are applied to the effective input budget, and that the original pre-compaction evidence remains available through the session event log. Tests should also cover compaction source material serialization: message ids and roles are retained, image blocks become placeholders, assistant tool calls and matching tool results are represented, provider-exposed thinking blocks are omitted in the first version, and summary generation is invoked without tool schemas.

The first implementation's test suite should stay focused on deterministic local behavior rather than provider live tests. It should cover request-level token estimation, known and unknown model context window resolution, summary request construction, compaction source material serialization, preserved-tail selection, tail `tool_result` truncation, replacement transcript installation, summary-generation failure behavior, and success/failure event payloads.
