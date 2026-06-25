import type {
  AssistantMessage,
  ModelContext,
  NonSystemMessage,
  RenderedModelRequest,
  Tool,
  ToolMessage,
  ToolUseContent,
} from "@/foundation";
import { toolParametersToJsonSchema } from "@/foundation";

import type { Agent, AgentContext } from "./agent";
import type { TurnRunEvent } from "./agent-event";
import {
  buildCompactionSummaryRequest,
  estimateRenderedRequestTokens,
  resolveKnownModelContextWindow,
  selectPreservedTail,
  serializeCompactionSourceMaterial,
} from "./compaction";
import { renderModelRequest } from "./prompt-assembly";
import type { EffectivePromptContext, PromptContextItem } from "./prompt-context";
import type { Session, SessionMessage, TurnId } from "./session";
import type { RenderedToolSchema } from "./session-event-log";
import { formatToolResultForMessage } from "./tool-result-runtime";
import { captureTurnContext, type TurnContext } from "./turn-context";

export interface TurnRunOptions {
  session: Session;
  agent: Agent;
  turnId: TurnId;
}

/**
 * Runtime handle for one execution attempt of a session turn.
 */
export class TurnRun {
  readonly events: AsyncIterable<TurnRunEvent>;
  readonly done: Promise<void>;

  private readonly _session: Session;
  private readonly _agent: Agent;
  private readonly _turnId: TurnId;
  private readonly _runId: string;
  private readonly _startedAtMs = Date.now();
  private readonly _abortController = new AbortController();
  private readonly _events = new AsyncEventQueue<TurnRunEvent>();
  private _agentContext: AgentContext | null = null;
  private _turnContext: TurnContext | null = null;
  private _promptContextSnapshot: EffectivePromptContext | null = null;
  private _autoCompactFailed = false;

  constructor({ session, agent, turnId }: TurnRunOptions) {
    this._session = session;
    this._agent = agent;
    this._turnId = turnId;
    this._runId = session.nextRunId();
    this.events = this._events;
    this.done = this._run();
  }

  /** Interrupts this run. The turn can be continued later. */
  interrupt() {
    this._abortController.abort(new Error("Turn interrupted"));
  }

  private async _run() {
    try {
      const turn = this._session.getTurn(this._turnId);
      if (!turn) {
        throw new Error(`Turn ${this._turnId} not found`);
      }
      await this._session.refreshPromptContext();
      this._session.markTurnRunning(this._turnId);
      this._events.push({ type: "turn_started", turnId: this._turnId });

      this._agentContext = {
        prompt: this._agent.prompt,
        messages: this._session.messages,
        tools: this._agent.tools,
        requestedSkillName: turn.options?.requestedSkillName,
      };
      this._turnContext = captureTurnContext({
        cwd: process.cwd(),
        model: this._agent.model.name,
      });
      this._promptContextSnapshot = this._session.promptContext;
      this._recordTrace("turn_run_started", {});
      this._recordTrace("turn_context_snapshot", { turnContext: this._turnContext });
      this._recordTrace("prompt_context_snapshot", { promptContext: this._promptContextSnapshot });
      await this._beforeAgentRun();

      for (let step = 1; step <= this._agent.options.maxSteps; step++) {
        this._abortController.signal.throwIfAborted();
        await this._beforeAgentStep(step);
        const { assistantMessage, requestId, durationMs } = await this._think(step);
        this._abortController.signal.throwIfAborted();
        await this._afterModel(assistantMessage);
        const messageId = this._appendMessage(assistantMessage);
        this._recordTrace("model_response", {
          assistantMessageId: messageId,
          usage: assistantMessage.usage,
          finishReason: assistantMessage.finishReason,
          durationMs,
        }, { requestId, messageId });
        this._events.push({ type: "message", turnId: this._turnId, messageId });

        const toolUses = this._extractToolUses(assistantMessage);
        if (toolUses.length === 0) {
          await this._afterAgentRun();
          this._session.completeTurn(this._turnId);
          this._recordTrace("turn_run_completed", {
            durationMs: this._durationMs(),
          });
          this._events.push({ type: "turn_completed", turnId: this._turnId });
          return;
        }

        await this._act(toolUses);
        await this._afterAgentStep(step);
      }
      throw new Error("Maximum number of steps reached");
    } catch (error) {
      if (this._abortController.signal.aborted) {
        this._session.interruptTurn(this._turnId);
        this._recordTrace("turn_run_interrupted", {
          reason: abortReason(this._abortController.signal.reason),
          durationMs: this._durationMs(),
        });
        this._events.push({ type: "turn_interrupted", turnId: this._turnId });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this._session.failTurn(this._turnId, message);
      this._recordTrace("turn_run_failed", {
        error: message,
        durationMs: this._durationMs(),
      });
      this._events.push({ type: "turn_failed", turnId: this._turnId, error: message });
      throw error;
    } finally {
      this._events.close();
    }
  }

  private async _think(
    step: number,
  ): Promise<{ assistantMessage: AssistantMessage; requestId: string; durationMs: number }> {
    const modelContext: ModelContext = {
      prompt: this._context.prompt,
      tools: this._context.tools,
      signal: this._abortController.signal,
    };
    await this._beforeModel(modelContext);

    const assembled = await this._assembleRequestAfterOptionalCompaction(modelContext);
    const requestId = this._session.nextRequestId();
    const startedAtMs = Date.now();
    const renderedRequest: RenderedModelRequest = {
      model: this._agent.model.name,
      options: this._agent.model.options,
      messages: assembled.messages,
      tools: modelContext.tools,
      signal: modelContext.signal,
    };
    this._recordTrace("model_request", {
      model: renderedRequest.model,
      ...(renderedRequest.options ? { modelOptions: renderedRequest.options } : {}),
      stepIndex: step - 1,
      renderedMessages: assembled.renderedMessages,
      renderedTools: renderToolSchemas(renderedRequest.tools ?? []),
    }, { requestId });

    let latest: AssistantMessage | null = null;
    for await (const snapshot of this._agent.model.streamRendered(renderedRequest)) {
      latest = snapshot;
      if (snapshot.streaming) {
        this._events.push(this._deriveProgress(snapshot));
      }
    }
    if (!latest) {
      throw new Error("Model stream ended without producing a message");
    }
    if (latest.streaming) {
      delete latest.streaming;
    }
    return { assistantMessage: latest, requestId, durationMs: Date.now() - startedAtMs };
  }

  private async _assembleRequestAfterOptionalCompaction(modelContext: ModelContext) {
    const promptContextItems = this._getPromptContextSnapshot().items;
    const turnContext = this._getTurnContext();
    const assembled = this._assembleRequest(modelContext.prompt, promptContextItems, turnContext);
    if (this._autoCompactFailed) {
      return assembled;
    }

    const modelContextWindow = resolveKnownModelContextWindow(this._agent.model.name);
    if (!modelContextWindow) {
      return assembled;
    }

    const tokenEstimate = estimateRenderedRequestTokens({
      messages: assembled.messages,
      tools: modelContext.tools,
    });
    const triggerTokens = Math.floor(modelContextWindow.contextWindowTokens * 0.85);
    if (tokenEstimate.totalTokens < triggerTokens) {
      return assembled;
    }

    const targetTokens = Math.floor(modelContextWindow.contextWindowTokens * 0.55);
    const transcript = this._session.transcript;
    const tail = selectPreservedTail(transcript, { targetTokens });
    if (tail.aborted) {
      this._recordTrace("transcript_compaction_failed", {
        reason: tail.abortReason,
        tokenEstimate,
        modelContextWindow,
      });
      this._autoCompactFailed = true;
      return assembled;
    }

    const compactedEntries = transcript.filter((entry) => tail.compactedMessageIds.includes(entry.id));
    if (compactedEntries.length === 0) {
      return assembled;
    }

    try {
      const sourceMaterial = serializeCompactionSourceMaterial(compactedEntries);
      const summaryText = await this._generateCompactionSummary({
        compactedEntries,
        compactedInputEstimateTokens: tokenEstimate.totalTokens,
        sourceMaterial,
      });
      const summaryMessage = [
        "This is background context from transcript compaction, not a new user request.",
        "",
        summaryText,
      ].join("\n");
      const replacementTranscriptMessages: NonSystemMessage[] = [
        { role: "user", content: [{ type: "text", text: summaryMessage }] },
        ...tail.entries.map((entry) => entry.message),
      ];
      const after = this._assembleRequest(modelContext.prompt, promptContextItems, turnContext, replacementTranscriptMessages);
      const afterEstimate = estimateRenderedRequestTokens({ messages: after.messages, tools: modelContext.tools });
      if (afterEstimate.totalTokens > targetTokens) {
        this._autoCompactFailed = true;
        this._recordTrace("transcript_compaction_failed", {
          reason: "compacted_transcript_exceeds_target_budget",
          tokenEstimate,
          afterTokens: afterEstimate.totalTokens,
          targetTokens,
          modelContextWindow,
        });
        return assembled;
      }
      this._session.installCompactedTranscript({
        summaryText: summaryMessage,
        compactedMessageIds: tail.compactedMessageIds,
        preservedTailEntries: tail.entries,
        tokenEstimate: {
          beforeTokens: tokenEstimate.totalTokens,
          afterTokens: afterEstimate.totalTokens,
          triggerTokens,
          targetTokens,
        },
        modelContextWindow,
        compactionSourceMaterial: sourceMaterial,
        reason: "auto-pre-request",
        turnId: this._turnId,
      });
      this._recordTrace("transcript_compaction_succeeded", {
        beforeTokens: tokenEstimate.totalTokens,
        afterTokens: afterEstimate.totalTokens,
        modelContextWindow,
      });
      return after;
    } catch (error) {
      this._autoCompactFailed = true;
      this._recordTrace("transcript_compaction_failed", {
        reason: error instanceof Error ? error.message : String(error),
        tokenEstimate,
        modelContextWindow,
      });
      return assembled;
    }
  }

  private _assembleRequest(
    agentPrompt: string,
    promptContextItems: PromptContextItem[],
    turnContext: TurnContext,
    transcriptMessages = this._session.messages,
  ) {
    return renderModelRequest({
      agentPrompt,
      promptContextItems,
      turnContext,
      transcriptMessages,
    });
  }

  private async _generateCompactionSummary({
    compactedEntries,
    compactedInputEstimateTokens,
    sourceMaterial,
  }: {
    compactedEntries: SessionMessage[];
    compactedInputEstimateTokens: number;
    sourceMaterial?: string;
  }) {
    const request = buildCompactionSummaryRequest({
      model: this._agent.model.name,
      modelOptions: this._agent.model.options,
      compactedInputEstimateTokens,
      sourceMaterial: sourceMaterial ?? serializeCompactionSourceMaterial(compactedEntries),
      signal: this._abortController.signal,
    });
    let latest: AssistantMessage | null = null;
    for await (const snapshot of this._agent.model.streamRendered(request)) {
      latest = snapshot;
    }
    const text = latest?.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    if (!text) {
      throw new Error("Compaction summary response did not contain text");
    }
    return text;
  }

  private _deriveProgress(snapshot: AssistantMessage): TurnRunEvent {
    const toolUses = snapshot.content.filter(
      (content): content is ToolUseContent => content.type === "tool_use",
    );
    if (toolUses.length === 0) {
      return { type: "progress", turnId: this._turnId, subtype: "thinking" };
    }
    const last = toolUses[toolUses.length - 1]!;
    return { type: "progress", turnId: this._turnId, subtype: "tool", name: last.name, input: last.input };
  }

  private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
    return message.content.filter((content): content is ToolUseContent => content.type === "tool_use");
  }

  private async _act(toolUses: ToolUseContent[]) {
    const signal = this._abortController.signal;
    const pending = toolUses.map(async (toolUse, index) => {
      this._events.push({ type: "tool_started", turnId: this._turnId, toolUseId: toolUse.id, name: toolUse.name });
      const startedAt = new Date().toISOString();
      this._recordTrace("tool_started", {
        name: toolUse.name,
        input: toolUse.input,
        startedAt,
      }, { toolUseId: toolUse.id });
      try {
        const tool = this._context.tools?.find((candidate) => candidate.name === toolUse.name);
        if (!tool) throw new Error(`Tool ${toolUse.name} not found`);
        const beforeResult = await this._beforeToolUse(toolUse);
        if (beforeResult.skip) {
          return { index, startedAt, toolUseId: toolUse.id, toolName: toolUse.name, result: beforeResult.result };
        }
        const result = await tool.invoke(toolUse.input, signal);
        await this._afterToolUse(toolUse, result);
        return { index, startedAt, toolUseId: toolUse.id, toolName: toolUse.name, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { index, startedAt, toolUseId: toolUse.id, toolName: toolUse.name, result: `Error: ${message}` };
      }
    });

    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    const remaining = new Set(pending.map((_, i) => i));
    while (remaining.size > 0) {
      const candidates = [...remaining].map((i) => pending[i]);
      const resolved = (await Promise.race([...candidates, abortPromise]))!;
      remaining.delete(resolved.index);

      const toolMessage: ToolMessage = {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: resolved.toolUseId,
            content: formatToolResultForMessage({ toolName: resolved.toolName, result: resolved.result }),
          },
        ],
      };
      const messageId = this._appendMessage(toolMessage);
      const resultText = typeof resolved.result === "string" ? resolved.result : undefined;
      const ok = !resultText?.startsWith("Error:");
      this._recordTrace("tool_finished", {
        toolResultMessageId: messageId,
        ok,
        startedAt: resolved.startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - Date.parse(resolved.startedAt)),
        error: ok ? undefined : resultText,
      }, { toolUseId: resolved.toolUseId, messageId });
      this._events.push({ type: "message", turnId: this._turnId, messageId });
      this._events.push({
        type: "tool_finished",
        turnId: this._turnId,
        toolUseId: resolved.toolUseId,
        messageId,
      });
    }
  }

  private _appendMessage(message: NonSystemMessage) {
    return this._session.appendMessageToTurn(this._turnId, message);
  }

  private get _context() {
    if (!this._agentContext) {
      throw new Error("Agent context is not initialized");
    }
    return this._agentContext;
  }

  private _getTurnContext() {
    if (!this._turnContext) {
      throw new Error("Turn context is not initialized");
    }
    return this._turnContext;
  }

  private _getPromptContextSnapshot() {
    if (!this._promptContextSnapshot) {
      throw new Error("Prompt context snapshot is not initialized");
    }
    return this._promptContextSnapshot;
  }

  private _recordTrace<TType extends string, TData>(
    type: TType,
    data: TData,
    ids: { requestId?: string; messageId?: string; toolUseId?: string } = {},
  ) {
    this._session.recordTraceEvent({
      type,
      turnId: this._turnId,
      runId: this._runId,
      requestId: ids.requestId,
      messageId: ids.messageId,
      toolUseId: ids.toolUseId,
      data,
    });
  }

  private _durationMs() {
    return Date.now() - this._startedAtMs;
  }

  private async _beforeModel(modelContext: ModelContext) {
    for (const middleware of this._agent.middlewares) {
      if (!middleware.beforeModel) continue;
      const result = await middleware.beforeModel({ modelContext, agentContext: this._context });
      if (result) {
        Object.assign(modelContext, result);
      }
    }
  }

  private async _afterModel(message: AssistantMessage) {
    for (const middleware of this._agent.middlewares) {
      if (!middleware.afterModel) continue;
      const result = await middleware.afterModel({ agentContext: this._context, message });
      if (result) {
        Object.assign(message, result);
      }
    }
  }

  private async _beforeAgentRun() {
    for (const middleware of this._agent.middlewares) {
      if (!middleware.beforeAgentRun) continue;
      const result = await middleware.beforeAgentRun({ agentContext: this._context });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }

  private async _afterAgentRun() {
    for (const middleware of this._agent.middlewares) {
      if (!middleware.afterAgentRun) continue;
      const result = await middleware.afterAgentRun({ agentContext: this._context });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }

  private async _beforeAgentStep(step: number) {
    for (const middleware of this._agent.middlewares) {
      if (!middleware.beforeAgentStep) continue;
      const result = await middleware.beforeAgentStep({ agentContext: this._context, step });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }

  private async _afterAgentStep(step: number) {
    for (const middleware of this._agent.middlewares) {
      if (!middleware.afterAgentStep) continue;
      const result = await middleware.afterAgentStep({ agentContext: this._context, step });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }

  private async _beforeToolUse(toolUse: ToolUseContent): Promise<{ skip: boolean; result?: unknown }> {
    for (const middleware of this._agent.middlewares) {
      if (!middleware.beforeToolUse) continue;
      const result = await middleware.beforeToolUse({ agentContext: this._context, toolUse });
      if (result && typeof result === "object" && "__skip" in result) {
        return { skip: true, result: result.result };
      }
      if (result) {
        Object.assign(this._context, result);
      }
    }
    return { skip: false };
  }

  private async _afterToolUse(toolUse: ToolUseContent, toolResult: unknown) {
    for (const middleware of this._agent.middlewares) {
      if (!middleware.afterToolUse) continue;
      const result = await middleware.afterToolUse({ agentContext: this._context, toolUse, toolResult });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }
}

function renderToolSchemas(tools: Tool[]): RenderedToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toolParametersToJsonSchema(tool.parameters),
  }));
}

function abortReason(reason: unknown) {
  if (reason instanceof Error) {
    return reason.message;
  }
  return reason ? String(reason) : "Turn interrupted";
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly _items: T[] = [];
  private readonly _waiters: PromiseWithResolvers<IteratorResult<T>>["resolve"][] = [];
  private _closed = false;

  push(item: T) {
    const waiter = this._waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this._items.push(item);
  }

  close() {
    this._closed = true;
    while (this._waiters.length > 0) {
      this._waiters.shift()!({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const next = await this._next();
      if (next.done) return;
      yield next.value;
    }
  }

  private _next(): Promise<IteratorResult<T>> {
    const item = this._items.shift();
    if (item) {
      return Promise.resolve({ value: item, done: false });
    }
    if (this._closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }
}
