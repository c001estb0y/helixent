import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  defineTool,
  Model,
  type AssistantMessage,
  type ModelProvider,
  type ModelProviderInvokeParams,
} from "@/foundation";

import { Agent } from "../agent";
import { AgentRunner } from "../agent-runner";
import { defineEffectivePromptContext, definePromptContextItem } from "../prompt-context";
import { Session } from "../session";
import { MemorySessionEventLog } from "../session-event-log";

describe("AgentRunner", () => {
  test("runs a session turn and records assistant output without consuming events", async () => {
    const provider = new CapturingProvider([
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ]);
    const agent = new Agent({
      id: "agent-1",
      model: new Model("fake-model", provider),
      prompt: "You are helpful.",
    });
    const session = new Session({
      id: "session-1",
      promptContext: testPromptContext(),
    });
    const turn = session.createTurn({
      agentId: agent.id,
      input: "Implement the ADR",
      options: { requestedSkillName: "tdd" },
    });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });

    await run.done;
    const events = [];
    for await (const event of run.events) {
      events.push(event);
    }

    expect(session.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Implement the ADR" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ]);
    expect(session.getTurn(turn.id)).toEqual(expect.objectContaining({
      status: "completed",
      messageStartIndex: 0,
      messageEndIndex: 2,
    }));
    expect(events).toEqual([
      { type: "turn_started", turnId: turn.id },
      { type: "message", turnId: turn.id, messageId: "message-2" },
      { type: "turn_completed", turnId: turn.id },
    ]);
    expect(provider.calls[0]?.messages).toEqual([
      { role: "system", content: [{ type: "text", text: "You are helpful." }] },
      {
        role: "user",
        content: [{ type: "text", text: "Context from AGENTS.md:\n\nFollow project rules." }],
      },
      {
        role: "user",
        content: [{ type: "text", text: expectedTurnContextText("fake-model") }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Implement the ADR" }],
      },
    ]);
  });

  test("runs tool calls in parallel and records tool results as each finishes", async () => {
    const firstToolStarted = deferred<void>();
    const secondToolStarted = deferred<void>();
    const firstToolResult = deferred<string>();
    const secondToolResult = deferred<string>();

    const firstTool = defineTool({
      name: "first_tool",
      description: "First tool",
      parameters: z.object({}),
      invoke: async () => {
        firstToolStarted.resolve();
        return await firstToolResult.promise;
      },
    });
    const secondTool = defineTool({
      name: "second_tool",
      description: "Second tool",
      parameters: z.object({}),
      invoke: async () => {
        secondToolStarted.resolve();
        return await secondToolResult.promise;
      },
    });
    const provider = new SequenceProvider([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-use-1", name: "first_tool", input: {} },
          { type: "tool_use", id: "tool-use-2", name: "second_tool", input: {} },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "All done" }],
      },
    ]);
    const agent = new Agent({
      id: "agent-1",
      model: new Model("fake-model", provider),
      prompt: "Use tools.",
      tools: [firstTool, secondTool],
    });
    const session = new Session({ id: "session-1" });
    const turn = session.createTurn({ agentId: agent.id, input: "Run tools" });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });
    await Promise.all([firstToolStarted.promise, secondToolStarted.promise]);

    secondToolResult.resolve("second finished");
    firstToolResult.resolve("first finished");
    await run.done;

    const toolMessages = session.messages.filter((message) => message.role === "tool");
    expect(toolMessages.map((message) => message.content[0]?.tool_use_id)).toEqual(["tool-use-2", "tool-use-1"]);
    expect(toolMessages.map((message) => JSON.parse(message.content[0]!.content).summary)).toEqual([
      "second finished",
      "first finished",
    ]);
    expect(session.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "All done" }],
    });
  });

  test("writes run-scoped trace records without duplicating assistant or tool message content", async () => {
    const provider = new SequenceProvider([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-use-1", name: "echo_tool", input: { value: "hello" } }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "All done" }],
        finishReason: "stop",
      },
    ]);
    const tool = defineTool({
      name: "echo_tool",
      description: "Echo tool",
      parameters: z.object({ value: z.string() }),
      invoke: async ({ value }) => `echoed ${value}`,
    });
    const agent = new Agent({
      id: "agent-1",
      model: new Model("fake-model", provider),
      prompt: "Use tools.",
      tools: [tool],
    });
    const eventLog = new MemorySessionEventLog();
    const session = new Session({
      id: "session-1",
      promptContext: testPromptContext(),
      eventLog,
    });
    const turn = session.createTurn({ agentId: agent.id, input: "Run echo" });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });

    await run.done;
    const traceEvents = eventLog.events.filter((event) => event.criticality === "trace");

    expect(traceEvents.map((event) => event.type)).toEqual([
      "turn_run_started",
      "turn_context_snapshot",
      "prompt_context_snapshot",
      "model_request",
      "model_response",
      "tool_started",
      "tool_finished",
      "model_request",
      "model_response",
      "turn_run_completed",
    ]);
    expect(traceEvents.find((event) => event.type === "prompt_context_snapshot")?.data).toEqual({
      promptContext: expect.objectContaining({
        sourceSetHash: expect.stringMatching(/^sha256:/),
        items: [expect.objectContaining({ sourcePath: "AGENTS.md", contentHash: expect.stringMatching(/^sha256:/) })],
      }),
    });
    const modelRequest = traceEvents.find((event) => event.type === "model_request")!;
    expect(modelRequest.requestId).toBe("request-1");
    expect(modelRequest.data).toEqual({
      stepIndex: 0,
      renderedMessages: expect.arrayContaining([
        expect.objectContaining({ source: "prompt_context", sourceItemIds: ["context-1"] }),
        expect.objectContaining({ source: "turn_context", cacheSegment: "volatile" }),
      ]),
    });
    const modelResponses = traceEvents.filter((event) => event.type === "model_response");
    expect(modelResponses[0]?.data).toEqual({
      assistantMessageId: "message-2",
      usage: undefined,
      finishReason: undefined,
      durationMs: expect.any(Number),
    });
    expect(modelResponses[1]?.data).toEqual({
      assistantMessageId: "message-4",
      usage: undefined,
      finishReason: "stop",
      durationMs: expect.any(Number),
    });
    const modelResponse = modelResponses[0]!;
    expect(JSON.stringify(modelResponse.data)).not.toContain("tool-use-1");
    const toolFinished = traceEvents.find((event) => event.type === "tool_finished")!;
    expect(toolFinished.data).toEqual({
      toolResultMessageId: "message-3",
      ok: true,
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      durationMs: expect.any(Number),
      error: undefined,
    });
    expect(JSON.stringify(toolFinished.data)).not.toContain("echoed hello");
    expect(traceEvents.find((event) => event.type === "turn_run_completed")?.data).toEqual({
      durationMs: expect.any(Number),
    });
  });

  test("writes a trace close record when a run is interrupted", async () => {
    const providerContinue = deferred<void>();
    const provider = new BlockingProvider(providerContinue.promise);
    const agent = new Agent({
      id: "agent-1",
      model: new Model("fake-model", provider),
      prompt: "Wait.",
    });
    const eventLog = new MemorySessionEventLog();
    const session = new Session({ id: "session-1", eventLog });
    const turn = session.createTurn({ agentId: agent.id, input: "Wait" });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });
    await provider.started.promise;
    run.interrupt();
    providerContinue.resolve();
    await run.done;

    const traceEvents = eventLog.events.filter((event) => event.criticality === "trace");
    expect(traceEvents.map((event) => event.type)).toEqual([
      "turn_run_started",
      "turn_context_snapshot",
      "prompt_context_snapshot",
      "model_request",
      "turn_run_interrupted",
    ]);
    expect(traceEvents.at(-1)?.data).toEqual({
      reason: "Turn interrupted",
      durationMs: expect.any(Number),
    });
  });

  test("writes a trace close record when a run fails", async () => {
    const agent = new Agent({
      id: "agent-1",
      model: new Model("fake-model", new EmptyProvider()),
      prompt: "Fail.",
    });
    const eventLog = new MemorySessionEventLog();
    const session = new Session({ id: "session-1", eventLog });
    const turn = session.createTurn({ agentId: agent.id, input: "Fail" });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });

    await expect(run.done).rejects.toThrow("Model stream ended without producing a message");
    const traceEvents = eventLog.events.filter((event) => event.criticality === "trace");
    expect(traceEvents.map((event) => event.type)).toEqual([
      "turn_run_started",
      "turn_context_snapshot",
      "prompt_context_snapshot",
      "model_request",
      "turn_run_failed",
    ]);
    expect(traceEvents.at(-1)?.data).toEqual({
      error: "Model stream ended without producing a message",
      durationMs: expect.any(Number),
    });
  });

  test("auto-compacts the active transcript before a model request when the known model context budget is high", async () => {
    const provider = new SequenceProvider([
      {
        role: "assistant",
        content: [{ type: "text", text: "Primary Request and Intent\nOld work summarized." }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Continuing after compact" }],
      },
    ]);
    const tool = defineTool({
      name: "echo_tool",
      description: "Echo tool",
      parameters: z.object({ value: z.string() }),
      invoke: async ({ value }) => value,
    });
    const agent = new Agent({
      id: "agent-1",
      model: new Model("deepseek-v4-flash", provider),
      prompt: "Use tools.",
      tools: [tool],
    });
    const eventLog = new MemorySessionEventLog();
    const session = new Session({ id: "session-1", eventLog });
    const oldTurn = session.createTurn({ agentId: agent.id, input: "old request " + "x".repeat(2_600_000) });
    session.markTurnRunning(oldTurn.id);
    session.appendMessageToTurn(oldTurn.id, {
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
    });
    session.completeTurn(oldTurn.id);
    const turn = session.createTurn({ agentId: agent.id, input: "latest request" });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });

    await run.done;

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.tools).toBeUndefined();
    expect(provider.calls[0]?.options?.max_tokens).toBe(20_000);
    expect(provider.calls[0]?.messages).toHaveLength(1);
    expect(provider.calls[0]?.messages[0]?.role).toBe("user");
    expect(provider.calls[1]?.tools).toEqual([tool]);
    expect(provider.calls[1]?.messages.map((message) => message.role)).toEqual(["system", "user", "user", "user"]);
    expect(provider.calls[1]?.messages.at(-2)).toEqual({
      role: "user",
      content: [{
        type: "text",
        text: expect.stringContaining("This is background context from transcript compaction"),
      }],
    });
    expect(provider.calls[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "latest request" }],
    });
    expect(session.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Continuing after compact" }],
    });
    const compactedEvent = eventLog.events.find((event) => event.type === "transcript_compacted");
    expect(compactedEvent?.data).toEqual(expect.objectContaining({
      tokenEstimate: expect.objectContaining({
        beforeTokens: expect.any(Number),
        afterTokens: expect.any(Number),
        triggerTokens: 850_000,
        targetTokens: 550_000,
      }),
      replacementTranscript: expect.arrayContaining([
        expect.objectContaining({
          metadata: { synthetic: true, source: "compact" },
        }),
      ]),
      compactionSourceMaterial: expect.stringContaining("[MESSAGE message-1 role=user]"),
    }));
  });

  test("does not auto-compact unknown model names even when the request is large", async () => {
    const provider = new SequenceProvider([
      {
        role: "assistant",
        content: [{ type: "text", text: "Done without compact" }],
      },
    ]);
    const agent = new Agent({
      id: "agent-1",
      model: new Model("deepseek-v4-flash-custom", provider),
      prompt: "Use tools.",
    });
    const eventLog = new MemorySessionEventLog();
    const session = new Session({ id: "session-1", eventLog });
    const oldTurn = session.createTurn({ agentId: agent.id, input: "old request " + "x".repeat(2_600_000) });
    session.markTurnRunning(oldTurn.id);
    session.completeTurn(oldTurn.id);
    const turn = session.createTurn({ agentId: agent.id, input: "latest request" });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });

    await run.done;

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.messages.at(-2)).toEqual({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("old request") }],
    });
    expect(eventLog.events.some((event) => event.type === "transcript_compacted")).toBe(false);
    expect(eventLog.events.some((event) => event.type === "transcript_compaction_failed")).toBe(false);
  });

  test("aborts compaction when the generated summary keeps the replacement request over target", async () => {
    const provider = new SequenceProvider([
      {
        role: "assistant",
        content: [{ type: "text", text: "Primary Request and Intent\n" + "s".repeat(1_700_000) }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Continuing without compact" }],
      },
    ]);
    const agent = new Agent({
      id: "agent-1",
      model: new Model("deepseek-v4-flash", provider),
      prompt: "Use tools.",
    });
    const eventLog = new MemorySessionEventLog();
    const session = new Session({ id: "session-1", eventLog });
    const oldTurn = session.createTurn({ agentId: agent.id, input: "old request " + "x".repeat(2_600_000) });
    session.markTurnRunning(oldTurn.id);
    session.completeTurn(oldTurn.id);
    const turn = session.createTurn({ agentId: agent.id, input: "latest request" });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });

    await run.done;

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.tools).toBeUndefined();
    expect(eventLog.events.some((event) => event.type === "transcript_compacted")).toBe(false);
    expect(eventLog.events.find((event) => event.type === "transcript_compaction_failed")?.data).toEqual(expect.objectContaining({
      reason: "compacted_transcript_exceeds_target_budget",
      afterTokens: expect.any(Number),
      targetTokens: 550_000,
    }));
    expect(session.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("old request") }],
    });
    expect(session.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Continuing without compact" }],
    });
  });

  test("does not retry auto-compaction in the same turn after summary generation fails", async () => {
    const provider = new FailingCompactionProvider();
    const tool = defineTool({
      name: "echo_tool",
      description: "Echo tool",
      parameters: z.object({ value: z.string() }),
      invoke: async ({ value }) => value,
    });
    const agent = new Agent({
      id: "agent-1",
      model: new Model("deepseek-v4-flash", provider),
      prompt: "Use tools.",
      tools: [tool],
    });
    const eventLog = new MemorySessionEventLog();
    const session = new Session({ id: "session-1", eventLog });
    const oldTurn = session.createTurn({ agentId: agent.id, input: "old request " + "x".repeat(2_600_000) });
    session.markTurnRunning(oldTurn.id);
    session.completeTurn(oldTurn.id);
    const turn = session.createTurn({ agentId: agent.id, input: "latest request" });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });

    await run.done;

    expect(provider.calls.map((call) => call.tools?.length ?? 0)).toEqual([0, 1, 1]);
    expect(eventLog.events.filter((event) => event.type === "transcript_compaction_failed")).toHaveLength(1);
    expect(eventLog.events.some((event) => event.type === "transcript_compacted")).toBe(false);
    expect(session.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("old request") }],
    });
    expect(session.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Done after failed compact" }],
    });
  });
});

class CapturingProvider implements ModelProvider {
  readonly calls: ModelProviderInvokeParams[] = [];
  private readonly _messages: AssistantMessage[];

  constructor(messages: AssistantMessage[]) {
    this._messages = messages;
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.calls.push(params);
    return this._messages.at(-1)!;
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.calls.push(params);
    for (const message of this._messages) {
      yield message;
    }
  }
}

class SequenceProvider implements ModelProvider {
  readonly calls: ModelProviderInvokeParams[] = [];
  private _index = 0;
  private readonly _messages: AssistantMessage[];

  constructor(messages: AssistantMessage[]) {
    this._messages = messages;
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.calls.push(params);
    return this._messages[this._index++] ?? this._messages.at(-1)!;
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.calls.push(params);
    yield this._messages[this._index++] ?? this._messages.at(-1)!;
  }
}

class BlockingProvider implements ModelProvider {
  readonly started = deferred<void>();
  private readonly _resume: Promise<void>;

  constructor(resume: Promise<void>) {
    this._resume = resume;
  }

  async invoke(): Promise<AssistantMessage> {
    this.started.resolve();
    await this._resume;
    return { role: "assistant", content: [{ type: "text", text: "Done" }] };
  }

  async *stream(): AsyncGenerator<AssistantMessage> {
    this.started.resolve();
    await this._resume;
    yield { role: "assistant", content: [{ type: "text", text: "Done" }] };
  }
}

class EmptyProvider implements ModelProvider {
  async invoke(): Promise<AssistantMessage> {
    throw new Error("Model stream ended without producing a message");
  }

  stream(): AsyncGenerator<AssistantMessage> {
    return emptyAssistantMessages();
  }
}

class FailingCompactionProvider implements ModelProvider {
  readonly calls: ModelProviderInvokeParams[] = [];
  private _mainCalls = 0;

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.calls.push(params);
    return this._nextMessage(params);
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.calls.push(params);
    yield this._nextMessage(params);
  }

  private _nextMessage(params: ModelProviderInvokeParams): AssistantMessage {
    if (!params.tools) {
      throw new Error("summary failed");
    }
    this._mainCalls++;
    if (this._mainCalls === 1) {
      return {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-use-1", name: "echo_tool", input: { value: "ok" } }],
      };
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: "Done after failed compact" }],
    };
  }
}

function deferred<T>() {
  let resolve!: PromiseWithResolvers<T>["resolve"];
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function expectedTurnContextText(model: string) {
  return [
    "Turn context:",
    "",
    `Current date: ${currentDate()}`,
    `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `Working directory: ${process.cwd()}`,
    `Model: ${model}`,
  ].join("\n");
}

function currentDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function testPromptContext() {
  return defineEffectivePromptContext([
    definePromptContextItem({
      id: "context-1",
      kind: "project_instructions",
      sourcePath: "AGENTS.md",
      scope: "project",
      precedence: 0,
      content: "Follow project rules.",
    }),
  ]);
}

function emptyAssistantMessages(): AsyncGenerator<AssistantMessage> {
  return {
    async next() {
      return { done: true, value: undefined as never };
    },
    async return(value?: unknown) {
      return { done: true, value: value as never };
    },
    async throw(error?: unknown) {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async [Symbol.asyncDispose]() {},
  };
}
