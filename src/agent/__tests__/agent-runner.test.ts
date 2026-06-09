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
import { Session } from "../session";

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
      contextBlocks: [{ id: "context-1", source: "AGENTS.md", content: "Follow project rules." }],
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

function deferred<T>() {
  let resolve!: PromiseWithResolvers<T>["resolve"];
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
