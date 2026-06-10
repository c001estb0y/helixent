# Prompt / Context / Transcript 分层

本文说明 Helixent 当前如何把 agent prompt、会话上下文和 transcript 组装成 provider request。

核心结论：源码里最终发给 provider 的 `messages` 不直接等于 `Session.messages`。它会先由 `TurnRun` 组装 `ModelContext`，再由 `Model` 拼成 provider request。

## 构建流程

```text
┌──────────────────────────────────────────────────────────────┐
│ Agent                                                        │
│                                                              │
│  Agent.prompt                                                │
│  - 身份                                                       │
│  - 工具规则                                                   │
│  - 行为契约                                                   │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
                    ┌──────────────────────┐
                    │ TurnRun._think()     │
                    │ 创建 ModelContext    │
                    └──────────┬───────────┘
                               │
                               │ beforeModel middleware
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Runtime ModelContext                                         │
│                                                              │
│  prompt = Agent.prompt + middleware prompt patches           │
│  contextBlocks = Session.contextBlocks                       │
│  messages = Session.messages                                 │
│  tools = Agent.tools                                         │
│  signal = TurnRun AbortSignal                                │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Model._buildModelProviderParams()                            │
│                                                              │
│  1. prompt                                                   │
│     -> system message                                        │
│                                                              │
│  2. contextBlocks                                            │
│     -> contextual user messages                              │
│                                                              │
│  3. messages                                                 │
│     -> transcript messages                                   │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────┐
│ Provider Messages                                            │
│                                                              │
│  [0] system: Agent.prompt + runtime patches                  │
│                                                              │
│  [1..n] user: Context from AGENTS.md / other context blocks   │
│                                                              │
│  [n..] transcript:                                           │
│       user input                                             │
│       assistant output                                       │
│       tool_result                                            │
│       steer input                                            │
│       ...                                                    │
└──────────────────────────────────────────────────────────────┘
```

## Session 内部结构

`Session` 是当前会话的内存状态来源。它同时保存 `contextBlocks`、`_messages` 和 `turns`，但这三者语义不同。

```text
┌──────────────────────────────────────────────────────────────┐
│ Session                                                      │
│                                                              │
│  contextBlocks                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ AGENTS.md / 项目规则 / 用户偏好                         │  │
│  │ 模型可见，但不是普通对话消息                             │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  _messages: SessionMessage[]                                 │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ message-1: user      初始输入                           │  │
│  │ message-2: assistant 模型回复                           │  │
│  │ message-3: tool      工具结果                           │  │
│  │ message-4: user      steer 输入                         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  turns                                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ turn-1                                                 │  │
│  │ - inputMessageIds: [message-1, message-4]              │  │
│  │ - messageStartIndex: 0                                 │  │
│  │ - messageEndIndex: 4                                   │  │
│  │ - status: completed / interrupted / failed ...         │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 各层职责

| 层 | 保存在哪里 | 是否 transcript | 职责 |
| --- | --- | --- | --- |
| `Agent.prompt` | `Agent` | 否 | 定义这个 agent 是谁、怎么工作 |
| middleware patch | runtime `ModelContext` | 否 | 本次请求临时加料，例如 skills、todo reminder |
| `Session.contextBlocks` | `Session` | 否 | 会话级背景资料，模型可见但不是普通对话 |
| `Session.messages` | `Session` | 是 | 真实发生过的对话和工具结果 |
| `Model` | `foundation/models` | 否 | 把 prompt、context blocks、messages 按顺序拼成 provider messages |

## 源码落点

| 概念 | 文件 |
| --- | --- |
| `Session.contextBlocks` / `Session.messages` | `src/agent/session.ts` |
| 创建 `ModelContext` | `src/agent/turn-run.ts` |
| `beforeModel` runtime patch | `src/agent/agent-middleware.ts` |
| skills prompt patch | `src/agent/skills/skills-middleware.ts` |
| todo reminder patch | `src/agent/todos/todos.ts` |
| provider messages 构建 | `src/foundation/models/model.ts` |

## 速记

```text
Agent.prompt            = 这个 agent 是谁、怎么工作
middleware patch        = 本次请求临时加料，不写入 session
Session.contextBlocks   = 会话级背景资料，不是对话
Session.messages        = 真实发生过的 transcript
Model                   = 把上面这些按顺序拼成 provider messages
```
