# Transcript Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist all conversation messages to JSONL and support resuming sessions via `--resume`.

**Architecture:** Middleware writes messages incrementally to `~/.helixent/projects/<sanitized-cwd>/<session-id>.jsonl`. CLI reads the file on `--resume` and injects messages into `createCodingAgent`. Zero changes to Agent core.

**Tech Stack:** TypeScript, Bun fs APIs, Commander CLI, existing AgentMiddleware interface.

---

### Task 1: transcript-storage.ts (file utilities)

**Files:**
- Create: `src/agent/transcript/transcript-storage.ts`
- Test: `src/agent/transcript/__tests__/transcript-storage.test.ts`

- [ ] **Step 1: Write failing tests for storage utilities**

```typescript
// src/agent/transcript/__tests__/transcript-storage.test.ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { sanitizeCwd, getProjectDir, appendEntry, loadTranscript } from "../transcript-storage";

describe("sanitizeCwd", () => {
  it("replaces path separators and colons with dashes", () => {
    expect(sanitizeCwd("E:\\Github\\helixent")).toBe("E-Github-helixent");
    expect(sanitizeCwd("/home/user/project")).toBe("-home-user-project");
  });
});

describe("getProjectDir", () => {
  it("returns path under ~/.helixent/projects/ with sanitized cwd", () => {
    const dir = getProjectDir("/home/user/myproject");
    expect(dir).toContain(".helixent");
    expect(dir).toContain("projects");
    expect(dir).toContain("-home-user-myproject");
  });
});

describe("appendEntry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("appends a JSONL line to the file", () => {
    const filePath = join(tmpDir, "test.jsonl");
    const message = { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] };
    appendEntry(filePath, message);

    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe("user");
    expect(parsed.message).toEqual(message);
    expect(parsed.timestamp).toBeDefined();
  });

  it("appends multiple entries on separate lines", () => {
    const filePath = join(tmpDir, "test.jsonl");
    const msg1 = { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] };
    const msg2 = { role: "assistant" as const, content: [{ type: "text" as const, text: "hello" }] };
    appendEntry(filePath, msg1);
    appendEntry(filePath, msg2);

    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});

describe("loadTranscript", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("reads JSONL and returns messages array", () => {
    const filePath = join(tmpDir, "session.jsonl");
    const msg = { role: "user" as const, content: [{ type: "text" as const, text: "test" }] };
    appendEntry(filePath, msg);

    const messages = loadTranscript(filePath);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
  });

  it("returns empty array for non-existent file", () => {
    const messages = loadTranscript(join(tmpDir, "nope.jsonl"));
    expect(messages).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/agent/transcript/__tests__/transcript-storage.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement transcript-storage.ts**

```typescript
// src/agent/transcript/transcript-storage.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

import type { NonSystemMessage } from "@/foundation";

/**
 * Replace path separators and colons with dashes for safe directory names.
 */
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, "-");
}

/**
 * Get the project-specific transcript directory.
 */
export function getProjectDir(cwd: string): string {
  return join(homedir(), ".helixent", "projects", sanitizeCwd(cwd));
}

/**
 * Get the path to the most recent session file for a project directory.
 * Returns null if no sessions exist.
 */
export function getLatestSessionPath(cwd: string): string | null {
  const projectDir = getProjectDir(cwd);
  if (!existsSync(projectDir)) return null;

  const { readdirSync, statSync } = require("fs");
  const files = (readdirSync(projectDir) as string[])
    .filter((f: string) => f.endsWith(".jsonl"))
    .map((f: string) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
    .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);

  return files.length > 0 ? join(projectDir, files[0]!.name) : null;
}

/**
 * Append a message entry to the transcript file.
 */
export function appendEntry(filePath: string, message: NonSystemMessage): void {
  const entry = {
    type: message.role,
    timestamp: new Date().toISOString(),
    message,
  };
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  appendFileSync(filePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

/**
 * Load all messages from a transcript file.
 */
export function loadTranscript(filePath: string): NonSystemMessage[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).message as NonSystemMessage);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/agent/transcript/__tests__/transcript-storage.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/transcript/transcript-storage.ts src/agent/transcript/__tests__/transcript-storage.test.ts
git commit -m "feat(transcript): add storage utilities for JSONL read/write"
```

---

### Task 2: transcript-middleware.ts

**Files:**
- Create: `src/agent/transcript/transcript-middleware.ts`
- Test: `src/agent/transcript/__tests__/transcript-middleware.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/agent/transcript/__tests__/transcript-middleware.test.ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { createTranscriptMiddleware } from "../transcript-middleware";

describe("createTranscriptMiddleware", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-mw-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it("writes existing messages on beforeAgentRun", async () => {
    const mw = createTranscriptMiddleware({ cwd: tmpDir, projectDir: tmpDir });
    const agentContext = {
      prompt: "test",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
    };

    await mw.beforeAgentRun!({ agentContext: agentContext as any });

    // Find the created JSONL file
    const { readdirSync } = require("fs");
    const files = (readdirSync(tmpDir) as string[]).filter((f: string) => f.endsWith(".jsonl"));
    expect(files).toHaveLength(1);

    const content = readFileSync(join(tmpDir, files[0]!), "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe("user");
  });

  it("incrementally writes new messages on afterAgentStep", async () => {
    const mw = createTranscriptMiddleware({ cwd: tmpDir, projectDir: tmpDir });
    const agentContext = {
      prompt: "test",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
    };

    await mw.beforeAgentRun!({ agentContext: agentContext as any });

    // Simulate agent adding messages
    agentContext.messages.push(
      { role: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
    );
    await mw.afterAgentStep!({ agentContext: agentContext as any, step: 1 });

    const { readdirSync } = require("fs");
    const files = (readdirSync(tmpDir) as string[]).filter((f: string) => f.endsWith(".jsonl"));
    const lines = readFileSync(join(tmpDir, files[0]!), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2); // user + assistant
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/agent/transcript/__tests__/transcript-middleware.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement transcript-middleware.ts**

```typescript
// src/agent/transcript/transcript-middleware.ts
import { randomUUID } from "crypto";
import { join } from "path";

import type { AgentMiddleware } from "../agent-middleware";
import { appendEntry, getProjectDir } from "./transcript-storage";

/**
 * Creates a middleware that persists all messages to a JSONL transcript file.
 */
export function createTranscriptMiddleware(options: {
  cwd: string;
  projectDir?: string; // override for testing
}): AgentMiddleware {
  let transcriptPath: string;
  let lastWrittenIndex = 0;

  return {
    beforeAgentRun: async ({ agentContext }) => {
      const sessionId = randomUUID();
      const dir = options.projectDir ?? getProjectDir(options.cwd);
      transcriptPath = join(dir, `${sessionId}.jsonl`);

      // Write any pre-existing messages (e.g. AGENTS.md content, resume messages)
      for (const msg of agentContext.messages) {
        appendEntry(transcriptPath, msg);
      }
      lastWrittenIndex = agentContext.messages.length;
      return null;
    },

    afterAgentStep: async ({ agentContext }) => {
      const newMessages = agentContext.messages.slice(lastWrittenIndex);
      for (const msg of newMessages) {
        appendEntry(transcriptPath, msg);
      }
      lastWrittenIndex = agentContext.messages.length;
      return null;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/agent/transcript/__tests__/transcript-middleware.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/transcript/transcript-middleware.ts src/agent/transcript/__tests__/transcript-middleware.test.ts
git commit -m "feat(transcript): add middleware for incremental JSONL recording"
```

---

### Task 3: index.ts + register in lead-agent

**Files:**
- Create: `src/agent/transcript/index.ts`
- Modify: `src/coding/agents/lead-agent.ts`

- [ ] **Step 1: Create barrel export**

```typescript
// src/agent/transcript/index.ts
export { createTranscriptMiddleware } from "./transcript-middleware";
export { loadTranscript, getLatestSessionPath, getProjectDir } from "./transcript-storage";
```

- [ ] **Step 2: Register middleware in lead-agent.ts**

Add import at top:

```typescript
import { createTranscriptMiddleware } from "@/agent/transcript";
```

Add to the `middlewares` array (after line 66):

```typescript
const middlewares = [
  createSkillsMiddleware(skillsDirs),
  todoMiddleware,
  createTranscriptMiddleware({ cwd }),  // <-- add this line
];
```

- [ ] **Step 3: Run existing tests to ensure no regression**

Run: `bun test`
Expected: All existing tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent/transcript/index.ts src/coding/agents/lead-agent.ts
git commit -m "feat(transcript): register transcript middleware in coding agent"
```

---

### Task 4: --resume CLI option

**Files:**
- Modify: `src/cli/index.tsx`

- [ ] **Step 1: Add --resume option and resume logic**

Add import at top of `src/cli/index.tsx`:

```typescript
import { getLatestSessionPath, getProjectDir, loadTranscript } from "@/agent/transcript";
import { join } from "path";
```

After line 25 (`program.version(...)`), add:

```typescript
program.option("--resume [sessionId]", "Resume a previous session");
```

After line 32 (`await program.parseAsync(process.argv)`) — replace the `if (args.length > 0)` block's condition to also handle `--resume` falling through to the main flow. The simplest approach: parse options before the branch:

Replace lines 29-33 with:

```typescript
program.parse(process.argv);
const opts = program.opts<{ resume?: string | true }>();
const positionalArgs = program.args;

if (positionalArgs.length > 0 && !opts.resume) {
  await program.parseAsync(process.argv);
} else {
```

Then, before `createCodingAgent` (around line 74), add resume message loading:

```typescript
  // Load resume messages if --resume was passed
  let resumeMessages: NonSystemMessage[] = [];
  if (opts.resume) {
    const cwd = process.cwd();
    if (typeof opts.resume === "string") {
      // Specific session ID
      const sessionPath = join(getProjectDir(cwd), `${opts.resume}.jsonl`);
      resumeMessages = loadTranscript(sessionPath);
    } else {
      // Latest session
      const latestPath = getLatestSessionPath(cwd);
      if (latestPath) {
        resumeMessages = loadTranscript(latestPath);
      }
    }
    if (resumeMessages.length > 0) {
      console.info(`Resuming session with ${resumeMessages.length} messages.`);
    } else {
      console.info("No previous session found. Starting fresh.");
    }
  }
```

Then pass `resumeMessages` to `createCodingAgent` by adding a `messages` parameter (the function already accepts initial messages via its internal logic — we'll prepend resume messages):

After `const agent = await createCodingAgent({...})`, add:

```typescript
  // Inject resume messages into agent
  if (resumeMessages.length > 0) {
    for (const msg of resumeMessages) {
      agent.messages.push(msg);
    }
  }
```

- [ ] **Step 2: Test manually**

```bash
bun run dev
# Have a short conversation, then Ctrl+C
bun run dev -- --resume
# Should see "Resuming session with N messages" and agent has context
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/index.tsx
git commit -m "feat(cli): add --resume option for session restoration"
```

---

### Task 5: Final integration test

**Files:** None new — manual verification

- [ ] **Step 1: Full flow test**

```bash
cd /tmp/test-project
bun run --cwd /e/Github/helixent/helixent dev
# Type: "what is 2+2?"
# Wait for response, then Ctrl+C
ls ~/.helixent/projects/
# Should see a directory with a .jsonl file
cat ~/.helixent/projects/*/*.jsonl
# Should see user + assistant messages as JSONL lines
```

- [ ] **Step 2: Resume test**

```bash
bun run --cwd /e/Github/helixent/helixent dev -- --resume
# Should print "Resuming session with N messages"
# Type: "what did I just ask you?"
# Agent should know the previous context
```

- [ ] **Step 3: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(transcript): integration fixes"
```

---

## File Summary

| File | Action | Lines |
|------|--------|-------|
| `src/agent/transcript/transcript-storage.ts` | Create | ~55 |
| `src/agent/transcript/transcript-middleware.ts` | Create | ~35 |
| `src/agent/transcript/index.ts` | Create | ~3 |
| `src/agent/transcript/__tests__/transcript-storage.test.ts` | Create | ~70 |
| `src/agent/transcript/__tests__/transcript-middleware.test.ts` | Create | ~55 |
| `src/coding/agents/lead-agent.ts` | Modify | +2 |
| `src/cli/index.tsx` | Modify | +25 |

**Total:** ~220 lines new, ~27 lines modified
