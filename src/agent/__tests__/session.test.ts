import { describe, expect, test } from "bun:test";

import { Session } from "../session";
import { MemorySessionEventLog } from "../session-event-log";

describe("Session", () => {
  test("creates a turn and records the initial user input inside the session transcript", () => {
    const eventLog = new MemorySessionEventLog();
    const session = new Session({ id: "session-1", eventLog });

    const turn = session.createTurn({
      agentId: "agent-1",
      input: "Implement the ADR",
    });

    expect(turn).toEqual(expect.objectContaining({
      id: "turn-1",
      agentId: "agent-1",
      status: "created",
      inputMessageIds: ["message-1"],
      messageStartIndex: 0,
    }));
    expect(turn.messageEndIndex).toBeUndefined();
    expect(session.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Implement the ADR" }],
      },
    ]);
    expect(session.getMessage("message-1")).toMatchObject({
      id: "message-1",
      metadata: { turnInputKind: "initial" },
    });
    expect(eventLog.events.map((event) => event.type)).toEqual([
      "prompt_context_set",
      "turn_created",
      "message_appended",
    ]);
    expect(eventLog.events.at(-1)).toEqual(expect.objectContaining({
      criticality: "session",
      turnId: "turn-1",
      messageId: "message-1",
      data: {
        message: {
          role: "user",
          content: [{ type: "text", text: "Implement the ADR" }],
        },
        metadata: { turnInputKind: "initial" },
      },
    }));
  });

  test("continues an interrupted turn by appending steer input to the same turn", () => {
    const session = new Session({ id: "session-1" });
    const turn = session.createTurn({ agentId: "agent-1", input: "Initial task" });

    session.markTurnRunning(turn.id);
    session.appendMessageToTurn(turn.id, {
      role: "assistant",
      content: [{ type: "text", text: "Partial answer" }],
    });
    session.interruptTurn(turn.id);

    const continuedTurn = session.continueTurn(turn.id, "Steer the answer");

    expect(continuedTurn).toEqual(expect.objectContaining({
      id: turn.id,
      status: "interrupted",
      inputMessageIds: ["message-1", "message-3"],
      messageStartIndex: 0,
    }));
    expect(continuedTurn.messageEndIndex).toBeUndefined();
    expect(session.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Initial task" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Steer the answer" }],
      },
    ]);
    expect(session.getMessage("message-3")).toMatchObject({
      metadata: { turnInputKind: "steer" },
    });
  });

  test("repairs dangling tool uses with synthetic tool results before steer input", () => {
    const session = new Session({ id: "session-1" });
    const turn = session.createTurn({ agentId: "agent-1", input: "Use a tool" });

    session.markTurnRunning(turn.id);
    session.appendMessageToTurn(turn.id, {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-use-1",
          name: "slow_tool",
          input: {},
        },
      ],
    });
    session.interruptTurn(turn.id);

    session.continueTurn(turn.id, "Try a different path");

    expect(session.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "Use a tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-use-1",
            name: "slow_tool",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-use-1",
            content: "Tool call interrupted before completion.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Try a different path" }],
      },
    ]);
    expect(session.getMessage("message-3")).toMatchObject({
      metadata: { synthetic: true, source: "session", reason: "interrupt" },
    });
    expect(session.getMessage("message-4")).toMatchObject({
      metadata: { turnInputKind: "steer" },
    });
  });
});
