import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  JsonlSessionEventLog,
  MemorySessionEventLog,
  projectEventLogPath,
  projectSessionEvents,
  readSessionEventsJsonl,
  type SessionEventEnvelope,
} from "../session-event-log";

const tempDirs: string[] = [];

describe("session event logs", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("memory log stores cloned stable event envelopes", () => {
    const log = new MemorySessionEventLog();
    const event: SessionEventEnvelope<"turn_run_started", Record<string, never>> = {
      eventId: "event-1",
      type: "turn_run_started",
      sessionId: "session-1",
      timestamp: "2026-06-12T00:00:00.000Z",
      criticality: "trace",
      turnId: "turn-1",
      runId: "run-1",
      data: {},
    };

    log.write(event);

    event.runId = "mutated";
    expect(log.events).toEqual([
      expect.objectContaining({
        eventId: "event-1",
        type: "turn_run_started",
        criticality: "trace",
        runId: "run-1",
      }),
    ]);
  });

  test("JSONL writer and reader preserve valid envelopes and report invalid lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "helixent-event-log-"));
    tempDirs.push(dir);
    const path = join(dir, "events", "session-1.jsonl");
    const log = new JsonlSessionEventLog({ path });

    log.write({
      eventId: "event-1",
      type: "prompt_context_set",
      sessionId: "session-1",
      timestamp: "2026-06-12T00:00:00.000Z",
      criticality: "session",
      data: { promptContext: { sourceSetHash: "sha256:test", items: [] } },
    });
    await Bun.write(path, `${await Bun.file(path).text()}not-json\n`);

    const result = await readSessionEventsJsonl(path);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual(expect.objectContaining({
      type: "prompt_context_set",
      criticality: "session",
    }));
    expect(result.invalidLines).toEqual([
      expect.objectContaining({ line: 2, content: "not-json" }),
    ]);
  });

  test("projects session state and marks broken trace records incomplete without dropping session state", () => {
    const projection = projectSessionEvents([
      {
        eventId: "event-1",
        type: "prompt_context_set",
        sessionId: "session-1",
        timestamp: "2026-06-12T00:00:00.000Z",
        criticality: "session",
        data: { promptContext: { sourceSetHash: "sha256:test", items: [] } },
      },
      {
        eventId: "event-2",
        type: "turn_created",
        sessionId: "session-1",
        timestamp: "2026-06-12T00:00:01.000Z",
        criticality: "session",
        turnId: "turn-1",
        data: {
          turn: {
            id: "turn-1",
            agentId: "agent-1",
            status: "created",
            inputMessageIds: [],
            messageStartIndex: 0,
            createdAt: new Date("2026-06-12T00:00:01.000Z"),
          },
        },
      },
      {
        eventId: "event-3",
        type: "message_appended",
        sessionId: "session-1",
        timestamp: "2026-06-12T00:00:02.000Z",
        criticality: "session",
        turnId: "turn-1",
        messageId: "message-1",
        data: { message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
      },
      {
        eventId: "event-4",
        type: "model_request",
        sessionId: "session-1",
        timestamp: "2026-06-12T00:00:03.000Z",
        criticality: "trace",
        turnId: "turn-1",
        runId: "run-1",
        requestId: "request-1",
        data: {},
      },
    ]);

    expect(projection.traceIncomplete).toBe(false);
    expect(projection.promptContext?.sourceSetHash).toBe("sha256:test");
    expect(projection.messages).toEqual([
      { id: "message-1", message: { role: "user", content: [{ type: "text", text: "Hello" }] } },
    ]);
    expect(projection.traceEvents).toHaveLength(1);
  });

  test("builds ADR-shaped project event log paths", () => {
    expect(projectEventLogPath({
      helixentHome: "C:\\Users\\me\\.helixent",
      cwd: "E:\\Github\\helixent\\helixent",
      sessionId: "session-1",
    })).toContain("projects");
    expect(projectEventLogPath({
      helixentHome: "C:\\Users\\me\\.helixent",
      cwd: "E:\\Github\\helixent\\helixent",
      sessionId: "session-1",
    })).toContain("events");
  });
});
