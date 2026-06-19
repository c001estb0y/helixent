import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { Agent, AgentRunner } from "@/agent";
import {
  Model,
  type AssistantMessage,
  type Message,
  type ModelProvider,
  type ModelProviderInvokeParams,
} from "@/foundation";

import { createCodingSession } from "../lead-agent";

const tempDirs: string[] = [];

describe("createCodingSession", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("refreshes instruction context before a turn and prefers AGENTS.override.md in the same directory", async () => {
    const cwd = await tempProjectDir();
    await writeFile(join(cwd, "AGENTS.md"), "Follow checked-in rules.");
    const session = await createCodingSession({ cwd });
    const initialHash = session.promptContext.sourceSetHash;

    await writeFile(join(cwd, "AGENTS.override.md"), "Follow private local rules.");
    const provider = new CapturingProvider({
      role: "assistant",
      content: [{ type: "text", text: "Done" }],
    });
    const agent = new Agent({
      id: "agent-1",
      model: new Model("fake-model", provider),
      prompt: "You are helpful.",
    });
    const turn = session.createTurn({ agentId: agent.id, input: "Use the latest rules." });

    const run = new AgentRunner().startTurn({ session, agent, turnId: turn.id });

    await run.done;
    expect(session.promptContext.sourceSetHash).not.toBe(initialHash);
    expect(session.promptContext.items).toEqual([
      expect.objectContaining({
        kind: "local_project_instructions",
        scope: "local_project",
        sourcePath: join(cwd, "AGENTS.override.md"),
        overrideOf: join(cwd, "AGENTS.md"),
        content: "Follow private local rules.",
      }),
    ]);
    expect(renderedText(provider.calls[0]!.messages[1]!)).toBe(
      `Context from ${join(cwd, "AGENTS.override.md")}:\n\nFollow private local rules.`,
    );
  });

  test("orders project instructions from root to cwd and scopes overrides to one directory", async () => {
    const root = await tempProjectDir();
    const child = join(root, "packages", "app");
    await mkdir(join(root, ".git"));
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Follow root rules.");
    await writeFile(join(child, "AGENTS.md"), "Follow checked-in child rules.");
    await writeFile(join(child, "AGENTS.override.md"), "Follow private child rules.");

    const session = await createCodingSession({ cwd: child });

    expect(session.promptContext.items).toEqual([
      expect.objectContaining({
        kind: "project_instructions",
        sourcePath: join(root, "AGENTS.md"),
        precedence: 0,
        content: "Follow root rules.",
      }),
      expect.objectContaining({
        kind: "local_project_instructions",
        sourcePath: join(child, "AGENTS.override.md"),
        precedence: 1,
        overrideOf: join(child, "AGENTS.md"),
        content: "Follow private child rules.",
      }),
    ]);
  });

  test("loads global user instructions before project instructions", async () => {
    const helixentHome = await tempProjectDir();
    const root = await tempProjectDir();
    await mkdir(join(root, ".git"));
    await writeFile(join(helixentHome, "AGENTS.md"), "Follow global rules.");
    await writeFile(join(root, "AGENTS.md"), "Follow project rules.");

    const session = await createCodingSession({ cwd: root, helixentHome });

    expect(session.promptContext.items).toEqual([
      expect.objectContaining({
        kind: "global_user_instructions",
        scope: "user",
        sourcePath: join(helixentHome, "AGENTS.md"),
        precedence: 0,
        content: "Follow global rules.",
      }),
      expect.objectContaining({
        kind: "project_instructions",
        scope: "project",
        sourcePath: join(root, "AGENTS.md"),
        precedence: 1,
        content: "Follow project rules.",
      }),
    ]);
  });

  test("uses a JSONL event log under HELIXENT_HOME projects by default", async () => {
    const helixentHome = await tempProjectDir();
    const cwd = await tempProjectDir();
    const session = await createCodingSession({ cwd, helixentHome, id: "session-test" });

    session.createTurn({ agentId: "agent-1", input: "Persist me" });

    const matches = new Bun.Glob("projects/**/events/session-test.jsonl").scan({ cwd: helixentHome });
    const files = [];
    for await (const file of matches) {
      files.push(file);
    }
    expect(files).toHaveLength(1);
    expect(await Bun.file(join(helixentHome, files[0]!)).text()).toContain("message_appended");
  });
});

class CapturingProvider implements ModelProvider {
  readonly calls: ModelProviderInvokeParams[] = [];
  private readonly _message: AssistantMessage;

  constructor(message: AssistantMessage) {
    this._message = message;
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.calls.push(params);
    return this._message;
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.calls.push(params);
    yield this._message;
  }
}

async function tempProjectDir() {
  const dir = await mkdtemp(join(tmpdir(), "helixent-coding-session-"));
  tempDirs.push(dir);
  return dir;
}

function renderedText(message: Message) {
  const content = message.content[0];
  if (content?.type !== "text") {
    throw new Error("Expected text content");
  }
  return content.text;
}
