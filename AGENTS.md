## Helixent

Helixent is a small library for building **ReAct-style** agent loops on the **Bun** stack.

This project is organized into **four layers**, plus a separate `community` area for third-party integrations, and CLI/TUI and skills support.

## Architecture (4 layers)

### 1) `foundation`

Core primitives that everything else builds on:

- **Models**: the `Model` abstraction and provider-facing contracts.
- **Messages**: a single transcript type that flows end-to-end through the system.
- **Tools**: tool definitions and execution plumbing (the "actions" an agent can invoke).

Files:
- `src/foundation/models/*`
- `src/foundation/messages/*`
- `src/foundation/tools/*`

Design intent:

- Keep these types stable and reusable.
- Prefer adding new backends by extending `ModelProvider`.
- Keep `Message` as the conversation transcript type; keep durable non-transcript context in `contextBlocks`.

### 2) `agent`

A reusable **ReAct-style agent loop**:

- Maintains state over a conversation transcript.
- Chooses between "think / act / observe" style steps.
- Orchestrates tool calls and feeds observations back into the next reasoning step.

Files:
- `src/agent/agent.ts`
- `src/agent/agent-middleware.ts`
- `src/agent/session.ts`
- `src/agent/agent-runner.ts`
- `src/agent/turn-run.ts`
- `src/agent/skills/*` (skill system middleware)
- `src/agent/todos/*` (todo system middleware/tool)

This layer should depend only on `foundation`, and remain generic (not coding-specific).

Current execution model:

- `Session` owns durable transcript entries, turn state, and `contextBlocks`.
- `AgentRunner` is stateless orchestration: it starts a `TurnRun` for a session turn.
- `TurnRun` is one execution attempt: model stream, tool calls, middleware hooks, and turn completion/interruption.

### 3) `coding`

A layer for coding-specific agents and tools.

- **Leading Agent**: `src/coding/agents/lead-agent.ts`
- **Tools**: `src/coding/tools/*`, including `bash`, `read_file`, `write_file`, `str_replace`, `list_files`, `glob_search`, `grep_search`, `apply_patch`, `file_info`, `mkdir`, `move_path`, `ask_user_question`
- **Injected agent tools**: `todo_write` comes from `src/agent/todos/*`.

### 4) `cli`

CLI layer for interactive agent usage:

- `src/cli/tui/*` - Terminal UI components built with Ink
- `src/cli/tui/hooks/*` - React hooks for the agent loop
- `src/cli/tui/themes/*` - TUI theming

## `community` (in-repo integrations)

In-repo integrations live under `src/community/*`.

- Treat these as optional adapters over `foundation` interfaces.
- Avoid coupling `foundation`/`agent` to integrations.

Current integrations:

- `src/community/openai`: `OpenAIModelProvider` backed by the `openai` SDK, using Chat Completions with function tools.
- `src/community/anthropic`: `AnthropicModelProvider` backed by `@anthropic-ai/sdk`, using Messages with tool use.

## Skills

Skill system for enhancing agent capabilities:

- Skills are loaded from configured skill directories, including project `skills/`, project `.agents/skills/`, `HELIXENT_HOME/skills`, `~/.agents/skills`, and `~/.helixent/skills`.
- Each skill is a self-contained module with a `SKILL.md` definition
- Skill middleware: `src/agent/skills/skill-reader.ts`, `src/agent/skills/skills-middleware.ts`

Current project skills:
- `coding-plan`
- `deep-research-plan`

## Stack

- **Runtime / package manager**: [Bun](https://bun.com)
- **Language**: TypeScript (strict, `moduleResolution: "bundler"`)
- **Dependencies**: provider SDKs (`openai`, `@anthropic-ai/sdk`), tool/config schemas (`zod`, `yaml`, `gray-matter`), CLI/TUI (`commander`, `ink`, `react`, Ink helpers).

## Imports

- **Internal**: `@/*` maps to `./src/*` via `tsconfig` `paths`

## Conventions

- Keep comments minimal and intent-focused.
- Avoid drive-by refactors outside the task at hand.
- Provider options: providers merge `Model.options` into provider calls. OpenAI defaults include `temperature: 0`; Anthropic normalizes thinking budget when thinking is enabled.
- Agent loop: when an assistant message contains tool calls, tools are invoked in parallel and appended as `tool_result` messages before continuing.

## Reference Agent Projects

When the user asks to reference or compare with other Agent projects, look under `E:\Github\HermesAgent`.

Relevant local projects:

- `E:\Github\HermesAgent\codex`
- `E:\Github\HermesAgent\claudecode`
- `E:\Github\HermesAgent\hermes`

Prefer reading these local sources before guessing behavior from memory.

## Commands

```bash
bun install
bun run dev
bun run check
bun run check:types
bun run lint
bun run lint:fix
bun run build:js
bun run build:bin
bun test
```

Model credentials are configured through the CLI config/settings flow rather than the root `index.ts`; `index.ts` only boots the CLI.

## Testing

Tests use Bun’s built-in runner: **`bun test`**.

**Discovery (default):** Bun walks the tree from the current working directory and runs files whose names match `*.test.*`, `*_test.*`, `*.spec.*`, or `*_spec.*` (with extensions `js`, `jsx`, `ts`, or `tsx`). It skips `node_modules` and hidden directories (names starting with `.`). Optional `[test]` settings in `bunfig.toml` can narrow the scan (e.g. `root`, `pathIgnorePatterns`); see [Bun test discovery](https://bun.sh/docs/test/discovery).

**Where to put tests:** Prefer **co-located** unit tests next to the code under test—e.g. `src/.../__tests__/foo.test.ts` or `foo.test.ts` beside `foo.ts`—so modules and tests stay easy to navigate together. A top-level `tests/` tree is fine for integration-style suites, large fixtures, or anything you want physically separate from `src/`. Bun does not require a specific folder name; naming patterns matter more than layout.

**What must be tested:** **Not everything.** Unit tests are encouraged for pure logic, non-trivial algorithms, and regressions, but they are **not** a blanket requirement for every change. Thin glue, obvious pass-throughs, or exploratory edits may ship without new tests when the cost outweighs the benefit—use judgment and add tests when behavior is easy to break or hard to verify by hand.

## Notes: tool use rendering (CLI vs TUI)

There are two parallel renderers for `tool_use` content:

- `src/cli/tui/message-text.ts` (`toolUseText`) produces **ANSI-colored plain text**
- `src/cli/tui/components/message-history.tsx` (`ToolUseContentItem`) produces **Ink components**

These share a largely identical mapping from `tool_use.name` to a short summary (e.g. `bash` shows `description + command`, file tools show `description + path`, search tools show `path :: pattern`, `apply_patch` shows `unified diff patch`). However, they are intentionally not directly reused because:

- `todo_write` in the TUI depends on `todoSnapshots` and renders richer state (current/next todo + counts), while the plain-text renderer is intentionally minimal.
- The presentation layers differ (ANSI strings include symbols/spacing; TUI colors and `⏺` marker are rendered outside the tool summary component).

If you want to de-duplicate in the future, prefer extracting a **shared structured summary** helper (e.g. `{ title: string; detail?: string }`) and have each renderer format it for its own output, keeping `todo_write` special-cased in the TUI.

## Code Convention

Load the [Code Convention](./docs/code-convention.md) for more details.

## Quality gate

Run `bun run check` as the main gate (`tsc --noEmit`, ESLint, and `bun test`). Use `bun run check:types` for type-check-only validation. The pre-commit hook (`.githooks/pre-commit`, install with `bun run hooks:install`) and GitHub Actions (`.github/workflows/check.yml`) both run this same command. Use `bun test` alone when iterating on tests (see **Testing**).
