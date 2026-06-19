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

  test("installs a compact summary and preserved tail as the active transcript", () => {
    const eventLog = new MemorySessionEventLog();
    const session = new Session({ id: "session-1", eventLog });
    const turn = session.createTurn({ agentId: "agent-1", input: "old request" });
    session.markTurnRunning(turn.id);
    session.appendMessageToTurn(turn.id, {
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
    });
    const latestUserId = session.appendMessageToTurn(turn.id, {
      role: "user",
      content: [{ type: "text", text: "latest request" }],
    });
    const assistantId = session.appendMessageToTurn(turn.id, {
      role: "assistant",
      content: [{ type: "text", text: "working on it" }],
    });
    const preservedTail = [session.getMessage(latestUserId)!, session.getMessage(assistantId)!];

    const summaryMessage = session.installCompactedTranscript({
      summaryText: "This is background context from transcript compaction, not a new user request.",
      compactedMessageIds: ["message-1", "message-2"],
      preservedTailEntries: preservedTail,
      tokenEstimate: { beforeTokens: 900, afterTokens: 500, triggerTokens: 850, targetTokens: 550 },
      modelContextWindow: { model: "deepseek-v4-flash", contextWindowTokens: 1_000_000 },
      reason: "auto-pre-request",
      turnId: turn.id,
    });

    expect(summaryMessage).toEqual(expect.objectContaining({
      id: "message-5",
      metadata: { synthetic: true, source: "compact" },
    }));
    expect(session.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "This is background context from transcript compaction, not a new user request." }],
      },
      preservedTail[0]!.message,
      preservedTail[1]!.message,
    ]);
    expect(session.transcript.map((entry) => entry.id)).toEqual(["message-5", latestUserId, assistantId]);

    const event = eventLog.events.at(-1);
    expect(event).toEqual(expect.objectContaining({
      type: "transcript_compacted",
      criticality: "session",
      turnId: turn.id,
      data: expect.objectContaining({
        compactedMessageIds: ["message-1", "message-2"],
        preservedTailMessageIds: [latestUserId, assistantId],
        replacementMessageIds: ["message-5", latestUserId, assistantId],
        reason: "auto-pre-request",
      }),
    }));
  });
});
