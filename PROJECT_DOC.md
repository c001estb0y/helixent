# Helixent 项目文档

> **Helixent** - 一个基于 TypeScript + Bun 的 ReAct 风格编码代理框架。

最后更新：2026-06-09

---

## 项目概览

Helixent 把 LLM、工具调用、会话状态、权限审批和终端 UI 组合成一个可运行的编码代理。它的核心不是单个“会聊天的类”，而是一组边界清晰的对象：

- `Session` 保存会话事实：turn、transcript、context blocks。
- `Turn` 表示一次任务边界：可运行、可中断、可继续。
- `Agent` 是不可变能力配置：模型、prompt、工具、中间件。
- `AgentRunner` 启动一次 turn。
- `TurnRun` 持有本次运行时状态：abort、events、done、runtime context。

---

## 技术栈

| 类别 | 技术 |
| --- | --- |
| Runtime / 包管理 | Bun |
| 语言 | TypeScript strict + ESM |
| Schema | Zod |
| CLI | Commander |
| TUI | React 19 + Ink |
| Provider SDK | OpenAI SDK, Anthropic SDK |
| 配置 | YAML |
| 测试 | Bun test |

---

## 架构设计

Helixent 采用分层架构，依赖方向严格自上而下：

```text
┌─────────────────────────────────────────────────┐
│              Layer 5: CLI / TUI                 │
│        交互界面、命令管理、设置、输入路由          │
├───────────────────────┬─────────────────────────┤
│ Layer 4: Community    │ Layer 3: Coding          │
│ OpenAI / Anthropic    │ 编码 Agent + 工具 + 审批  │
├───────────────────────┴─────────────────────────┤
│              Layer 2: Agent                      │
│   Session / Turn / Runner / Middleware / Skills  │
├─────────────────────────────────────────────────┤
│              Layer 1: Foundation                 │
│        消息、模型、工具 - 稳定核心抽象             │
└─────────────────────────────────────────────────┘
```

依赖规则：

| 层 | 可以依赖 | 不应该依赖 |
| --- | --- | --- |
| `foundation` | 无 | 任何上层 |
| `agent` | `foundation` | `coding`、`cli`、`community` |
| `coding` | `agent`、`foundation` | `cli` |
| `community` | `foundation` | `agent`、`coding`、`cli` |
| `cli` | 所有下层 | 无 |

---

## ADR 0001 后的核心模型

旧设计里，`Agent` 同时拥有 prompt、messages、streaming、abort、tools 和 middleware。现在这些职责被拆开：

```text
┌─────────────────────────────────────────────────┐
│ Session                                         │
│ - turns                                         │
│ - transcript messages                           │
│ - context blocks, e.g. AGENTS.md                │
│ - one active turn in Phase 1                    │
└───────────────────────┬─────────────────────────┘
                        │ owns
                        ▼
┌─────────────────────────────────────────────────┐
│ Turn                                            │
│ - status: created/running/interrupted/...       │
│ - inputMessageIds                               │
│ - messageStartIndex / messageEndIndex           │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ Agent                                           │
│ - id, name                                      │
│ - model, prompt                                 │
│ - tools, middlewares, maxSteps                  │
│ - no transcript, no abort controller            │
└───────────────────────┬─────────────────────────┘
                        │ supplied to
                        ▼
┌─────────────────────────────────────────────────┐
│ AgentRunner                                     │
│ - stateless                                     │
│ - startTurn({ session, agent, turnId })         │
└───────────────────────┬─────────────────────────┘
                        │ creates
                        ▼
┌─────────────────────────────────────────────────┐
│ TurnRun                                         │
│ - AbortController                               │
│ - events: observation stream                    │
│ - done: completion promise                      │
│ - runtime AgentContext                          │
└─────────────────────────────────────────────────┘
```

状态机：

```text
created ──▶ running ──▶ completed
              │  │
              │  ├────▶ failed
              │  └────▶ cancelled
              ▼
          interrupted ─▶ running
              │  │
              │  ├────▶ failed
              │  └────▶ cancelled
```

关键原则：

- `AGENTS.md` 属于 `Session.contextBlocks`，不再伪装成普通 user message。
- `requestedSkillName` 属于 turn options，不属于 `Agent` 状态。
- middleware 可以改 runtime/model context，但不能直接写 transcript。
- interrupted turn 可以继续；terminal turn 不可继续。
- 如果中断留下未配对 `tool_use`，继续前会补 synthetic `tool_result`。

---

## 运行流程

```text
用户输入
  │
  ▼
Session.createTurn(...)
  │  记录初始 user message
  ▼
AgentRunner.startTurn(...)
  │
  ▼
TurnRun
  │
  ├─ beforeAgentRun
  │
  ├─ step 1..maxSteps
  │    │
  │    ├─ beforeAgentStep
  │    ├─ beforeModel
  │    ├─ model.stream(...)
  │    ├─ afterModel
  │    ├─ append assistant message to Session
  │    │
  │    ├─ no tool_use ──▶ afterAgentRun ──▶ completed
  │    │
  │    └─ has tool_use
  │         ├─ run tools in parallel
  │         ├─ append each tool_result as it finishes
  │         └─ afterAgentStep
  │
  └─ done
```

TUI 路由：

| 状态 | 输入 | 行为 |
| --- | --- | --- |
| idle | submit | 创建新 turn 并运行 |
| running | submit | 暂存为下一 turn 输入 |
| running | Esc / Ctrl-C | interrupt 当前 `TurnRun` |
| interrupted | submit | 作为 steer input 继续同一 turn |
| any | `/clear` | 新建 Session，保留 context blocks |

---

## 目录结构

```text
helixent/
├─ index.ts                     # CLI 入口，导入 src/cli
├─ src/
│  ├─ foundation/               # 基础抽象
│  │  ├─ messages/              # Message / content / role 类型
│  │  ├─ models/                # Model / ModelProvider / ModelContext
│  │  └─ tools/                 # defineTool / structured tool result
│  │
│  ├─ agent/                    # 通用 agent 层
│  │  ├─ agent.ts               # Agent 能力配置对象
│  │  ├─ session.ts             # Session / Turn / SessionMessage
│  │  ├─ agent-runner.ts        # 无状态 runner
│  │  ├─ turn-run.ts            # ReAct runtime loop
│  │  ├─ agent-event.ts         # TurnRunEvent
│  │  ├─ agent-middleware.ts    # 生命周期 hook
│  │  ├─ skills/                # skill 发现与注入
│  │  ├─ todos/                 # todo_write 工具与 reminder
│  │  └─ tool-result-*.ts       # 工具结果策略与格式化
│  │
│  ├─ coding/                   # 编码场景层
│  │  ├─ agents/lead-agent.ts   # createCodingAgent / createCodingSession
│  │  ├─ tools/                 # bash/read/write/search/patch 等工具
│  │  └─ permissions/           # 审批与 allow list
│  │
│  ├─ community/                # Provider 适配
│  │  ├─ openai/
│  │  └─ anthropic/
│  │
│  └─ cli/                      # 应用层
│     ├─ bootstrap/             # first run / integrity
│     ├─ commands/              # commander 命令
│     ├─ config/                # 模型配置 schema
│     ├─ settings/              # settings 加载与写入
│     └─ tui/                   # Ink UI
│
├─ skills/                      # 项目内置 skills
├─ docs/                        # ADR、规范、设计文档
├─ scripts/                     # 手动验证脚本
├─ .github/workflows/           # CI
└─ .githooks/                   # 本地 hooks
```

---

## 核心模块速查

### Foundation

| 模块 | 作用 |
| --- | --- |
| `messages` | 定义 system/user/assistant/tool 消息和 content union |
| `models` | `Model` 包装 provider，并组装 prompt/context/messages/tools |
| `tools` | `defineTool`、Zod 参数 schema、结构化工具结果 |

### Agent

| 文件 | 作用 |
| --- | --- |
| `agent.ts` | 不可变 agent 配置 |
| `session.ts` | 持久会话状态、turn 状态机、synthetic repair |
| `agent-runner.ts` | 校验 turn 与 agent，创建 `TurnRun` |
| `turn-run.ts` | 模型流、工具并行、事件、abort、middleware 调度 |
| `agent-middleware.ts` | 8 个生命周期 hook |
| `skills/` | 发现 `SKILL.md` 并在 prompt 中注入技能列表 |
| `todos/` | 内置 `todo_write` 和 reminder |

### Coding

| 模块 | 作用 |
| --- | --- |
| `agents/lead-agent.ts` | 组装编码 agent；创建带 `AGENTS.md` context 的 session |
| `tools/` | 编码工具：shell、文件、搜索、patch、提问 |
| `permissions/` | 对敏感工具做 TUI 审批和持久化 allow |

内置编码工具：

| 工具 | 用途 | 默认需审批 |
| --- | --- | --- |
| `bash` | 执行 shell 命令 | 是 |
| `write_file` | 写文件 | 是 |
| `str_replace` | 字符串替换 | 是 |
| `apply_patch` | 应用 patch | 是 |
| `read_file` | 读文件 | 否 |
| `list_files` | 列目录 | 否 |
| `glob_search` | 文件 glob 搜索 | 否 |
| `grep_search` | 内容搜索 | 否 |
| `file_info` | 文件元信息 | 否 |
| `mkdir` | 创建目录 | 否 |
| `move_path` | 移动路径 | 否 |
| `ask_user_question` | 向用户提问 | 否 |

### Community

| Provider | 文件 | 说明 |
| --- | --- | --- |
| OpenAI | `src/community/openai` | Chat Completions + function tools |
| Anthropic | `src/community/anthropic` | Messages API + tool_use/tool_result |

### CLI / TUI

| 模块 | 作用 |
| --- | --- |
| `src/cli/index.tsx` | 选择模型 provider，创建 agent/session，渲染 TUI |
| `tui/app.tsx` | 顶层 Ink 布局 |
| `tui/hooks/use-agent-loop.ts` | Session + AgentRunner 的 UI 驱动 |
| `tui/components/` | 输入框、历史消息、审批、todo 面板 |
| `settings/` | allow list 等本地设置 |
| `config/` | 模型配置 schema |

---

## 中间件系统

```text
beforeAgentRun
  └─ beforeAgentStep
      └─ beforeModel
          └─ model.stream
      └─ afterModel
      └─ beforeToolUse / afterToolUse
  └─ afterAgentStep
afterAgentRun
```

| Hook | 典型用途 |
| --- | --- |
| `beforeAgentRun` | 加载 skills、初始化 runtime context |
| `beforeAgentStep` | step 级提示或统计 |
| `beforeModel` | 注入技能、todo reminder、provider shaping |
| `afterModel` | 修改 assistant message |
| `beforeToolUse` | 权限审批、跳过工具 |
| `afterToolUse` | 记录工具结果、更新状态 |
| `afterAgentStep` | step 后处理 |
| `afterAgentRun` | 正常结束清理 |

---

## Skills

技能目录中每个子目录放一个 `SKILL.md`：

```text
skills/
├─ coding-plan/
│  └─ SKILL.md
└─ deep-research-plan/
   └─ SKILL.md
```

格式：

```markdown
---
name: coding-plan
description: Plan coding work before implementation.
---

# Skill content
```

CLI 会把这些目录加入 `skillsDirs`：

- `<cwd>/skills`
- `<cwd>/.agents/skills`
- `$HELIXENT_HOME/skills`
- `~/.agents/skills`
- `~/.helixent/skills`

---

## 配置与命令

交互入口：

```bash
bun run dev
```

模型管理：

```bash
helixent config model add
helixent config model list
helixent config model remove
helixent config model set-default
```

常用工程命令：

```bash
bun install
bun run check        # tsc + eslint + bun test
bun run check:types  # 仅类型检查
bun run lint
bun run build:js
bun run build:bin
bun test
```

---

## 测试布局

```text
src/agent/__tests__/
src/foundation/__tests__/
src/cli/**/__tests__/
src/coding/**/__tests__/
src/community/**/__tests__/
```

重点测试行为：

- Session/Turn 状态机
- interrupt/continue 与 synthetic `tool_result`
- runner 事件与 `done`
- 同一 assistant step 内工具并行执行
- provider message/tool 转换
- 编码工具的成功路径和结构化错误

---

## 当前边界

已落地：

- Session / Turn 一等模型
- Agent 配置对象化
- AgentRunner / TurnRun
- TUI 迁移到 Session + Runner
- `AGENTS.md` 进入 `Session.contextBlocks`
- requested skill 进入 turn options
- 并行工具执行保留

暂不做：

- compaction
- resume
- JSONL transcript persistence
- 一个 session 内多个 active turn
- first-class `Step`
- `Session.contextBlocks` 持久化
