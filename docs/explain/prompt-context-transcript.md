# Prompt / Context / Transcript 分层

本文说明 Helixent 当前如何把 agent prompt、会话上下文和 transcript 组装成 provider request。

核心结论：源码里最终发给 provider 的 `messages` 不直接等于 `Session.messages`。它会先由 `TurnRun` 组装 `ModelContext`，再由 `Model` 拼成 provider request。

补充结论：`Session.contextBlocks` 是当前实现里的粗粒度承载物。目标模型应把它演进成 typed prompt context items。用户目录里的全局 `AGENTS.md` 和项目里的 `AGENTS.md` 都是 instruction context，不是 agent identity；它们应该分别保留来源和作用域，最后在 prompt assembly 阶段再按规则合并渲染。

日期这类信息不属于 instruction context。`currentDate` / `timezone` / `cwd` 这类执行时事实应属于 `TurnContext`，可以被渲染进 provider request，但不进入 `Session.messages`，也不和 `AGENTS.md` 这类 typed prompt context items 混在一起。

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
│  │ 全局 AGENTS.md / 项目 AGENTS.md / 项目规则 / 用户偏好    │  │
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
| `Session.contextBlocks` | `Session` | 否 | 当前实现中的会话级背景资料，模型可见但不是普通对话 |
| typed prompt context items | future `Session` / trace record | 否 | 目标模型：保留 instruction context 的 kind、source path、scope、precedence、cache stability |
| `TurnContext` | future `TurnRun` / trace record | 否 | 每次 turn execution 的执行时事实快照，例如 current date、timezone、cwd、model |
| `Session.messages` | `Session` | 是 | 真实发生过的对话和工具结果 |
| `Model` | `foundation/models` | 否 | 把 prompt、context blocks、messages 按顺序拼成 provider messages |

## Instruction context

`AGENTS.md` 这类文件的语义不是“这个 agent 是谁”，而是“用户或项目给这个 agent 的约束和背景”。因此它们不应该进入 `Agent.prompt`，也不应该进入 `Session.messages`。

目标上应保留 typed items：

```ts
type PromptContextItem =
  | {
      kind: "global_user_instructions";
      sourcePath: string;
      content: string;
      cacheStable: true;
    }
  | {
      kind: "project_instructions";
      sourcePath: string;
      content: string;
      cacheStable: true;
    }
  | {
      kind: "local_project_instructions";
      sourcePath: string;
      content: string;
      cacheStable: true;
      overrideOf?: string;
    };
```

全局用户指令和项目指令是同一类 instruction context，但不是同一个 item。加载时保留边界，渲染时再合并：

```text
PromptContextItem[]
  global_user_instructions  ~/.helixent/AGENTS.md
  project_instructions      <repo>/AGENTS.md
  local_project_instructions <repo>/AGENTS.override.md

        │
        ▼

provider-visible contextual instructions
```

这样做的收益是：resume、trace、debug 和 prompt cache 都能知道模型看到了哪些来源的指令，而不是只看到一段已经拼平的文本。

局部私有覆盖也应该是一等 typed item，而不是普通字符串拼在最后。例如：

```text
~/.helixent/AGENTS.md
  默认使用 pnpm。

<repo>/AGENTS.md
  本项目使用 bun。

<repo>/packages/legacy/AGENTS.md
  legacy 包使用 npm。

<repo>/AGENTS.override.md
  不要自动跑 e2e。
```

推荐规则：

```text
global_user_instructions
project_instructions, root -> cwd
local_project_instructions, root -> cwd
explicit override items, only for their declared scope
```

默认语义是 additive：后面的、更具体的指令可以补充或收紧前面的规则。真正的替代必须显式，例如 `AGENTS.override.md` 只替代同目录的 checked-in `AGENTS.md`，不能静默抹掉全局用户指令、父目录项目指令或子目录项目指令。

参考项目里有相近但不完全相同的做法：Codex 从 repo root 到 cwd 拼接 `AGENTS.md`，并且同目录里 `AGENTS.override.md` 优先于 `AGENTS.md`；ClaudeCode 的 `CLAUDE.md` 体系按 Managed、User、Project、Local 加载，后加载的优先级更高；Hermes 对 `.hermes.md`、`AGENTS.md`、`CLAUDE.md`、`.cursorrules` 使用 first-found priority。Helixent 的折中是保留这些优先级信息为 typed items，而不是加载时直接压平成一段文本。

## Turn context

`TurnContext` 是一次 turn execution 的 prompt-visible execution facts snapshot。它和 instruction context 的区别是：instruction context 来自用户或项目的指令源，通常相对稳定；turn context 来自本次执行环境，通常更 volatile。

典型字段：

```ts
interface TurnContext {
  currentDate: string;
  timezone: string;
  cwd: string;
  model: string;
}
```

默认放 date-only、timezone、cwd 和 model：

```ts
interface TurnContext {
  currentDate: string; // "2026-06-11"
  timezone: string;    // "Asia/Shanghai"
  cwd: string;          // "E:\\Github\\helixent\\helixent"
  model: string;        // "gpt-5"
}
```

不默认放精确 timestamp：

```ts
// not default
currentDateTime: "2026-06-11T15:42:03+08:00"
```

原因是多数任务只需要“今天是哪天”。分钟/秒级时间会让 volatile prompt segment 不断变化，降低 prompt cache 命中，也容易让模型关注无关的精确时间。需要精确时间时，可以以后加显式 opt-in 字段，或者提供一个工具让模型按需查询。

参考项目也支持这个取舍：ClaudeCode 注入的是 `Today's date is ...` 这种 date-only；Hermes 的 system prompt 注释明确说使用 date-only 而不是 minute precision，以免破坏 prompt cache；Codex 的 turn context 思路支持记录执行环境快照，但 Helixent 这里默认先保持日期粒度。

timezone 的来源先保持简单：

```text
Phase 1:
  timezone = runtime system local timezone

Not yet:
  user config timezone
  session timezone
  per-turn timezone override
```

也就是说，如果机器时区是 `Asia/Shanghai`，`TurnContext` 就记录：

```ts
{
  currentDate: "2026-06-11",
  timezone: "Asia/Shanghai",
  cwd: "E:\\Github\\helixent\\helixent",
  model: "gpt-5"
}
```

这个值仍然要进 `TurnContext` snapshot 和 trace，因为 debug/replay 需要知道当时按哪个日期边界算“今天”。以后如果 Helixent 需要远程 worker 或跨时区用户，再引入一个小的 clock/environment provider；Phase 1 不把 override policy 塞进 `Session`。

Phase 1 不把 sandbox 放进 `TurnContext`：

```ts
// not in TurnContext for Phase 1
sandbox: "danger-full-access"
```

sandbox/permission state 如果需要模型可见，应该走单独的权限/工具指令上下文，而不是混在日期和运行环境快照里。这样 `TurnContext` 先保持小而清楚：今天、时区、cwd、model。

Phase 1 的 `TurnContext` 字段都默认渲染给模型看，但放在 volatile block，不进 transcript：

```text
<turn_context>
Current date: 2026-06-11
Timezone: Asia/Shanghai
Working directory: E:\Github\helixent\helixent
Model: gpt-5
</turn_context>
```

`cwd` 对相对路径和文件工具理解有用；`model` 对模型理解当前能力边界有用。它们都可能随 run 改变，所以不应该进入 stable prefix；它们也不是用户说过的话，所以不进入 `Session.messages`。

采样责任放在 `AgentRunner` / `TurnRun`，Phase 1 不公开 `TurnContextProvider` 或 `turnContextOverride`：

```ts
runner.startTurn({
  session,
  agent,
  turnId,
});
```

内部采样：

```text
currentDate / timezone
  from system clock

cwd
  from runner/session runtime cwd

model
  from agent.model
```

也就是说，普通调用方不需要也不能手动塞一个 `TurnContext`。测试如果需要固定日期，可以测更小的纯函数；但 API 先不为测试或高级场景增加 override 形状。

`currentDate` 应属于 `TurnContext`，而不是 `PromptContextItem`：

```text
stable prefix:
  Agent.prompt
  global_user_instructions
  project_instructions

volatile turn context:
  currentDate
  timezone
  cwd
  model

transcript:
  Session.messages
```

这样 prompt cache 可以围绕稳定 prefix 工作，同时 trace/debug 仍然能精确知道每个 turn 的模型请求看到了哪一天、哪个时区和哪个运行环境。

更明确地说，prompt assembly 应该按 cache-aware 顺序渲染：

```text
1. stable agent/system identity and tool behavior contract
2. stable instruction context
   - global_user_instructions
   - project_instructions
   - local/private project instructions, if supported
3. volatile TurnContext
   - currentDate
   - timezone
   - cwd
   - model
4. transcript messages
```

这个顺序是 prompt assembly strategy，不是 transcript 语义。日期每天变化时，应该只影响 volatile suffix；`Agent.prompt` 和 instruction context 形成的 stable prefix 仍然可以参与 prompt cache。trace 里的 rendered snapshot 也应该保留这些 cache-relevant boundaries，至少能看出哪些 rendered messages 或 content parts 来自 stable agent prompt、stable instruction context、volatile `TurnContext` 或 transcript。

采样时机：

```text
Session created
  no date sampling

session.createTurn(...)
  records turn and initial user input

runner.startTurn(...)
  captures TurnContext snapshot
  freezes it for this TurnRun
  all ReAct steps in this TurnRun reuse it

session.continueTurn(...)
  records steer input on the same Turn

runner.startTurn(...) for the continuation
  captures a new TurnContext snapshot
```

因此同一个 `TurnRun` 内不会因为跨午夜而看到两个日期；但一个被 interrupt 后隔天继续的 turn，会在 continuation run 中看到新的日期。这个更新不需要写一条新的 user message，也不污染 transcript。

持久化边界不是“运行时 vs 持久化”这么简单，因为 `Session` 自己也可以持久化。更准确的切分是物理 event log vs 语义 projection：

```text
Session event log / physical storage
  append-only JSONL events

Transcript projection
  message_appended events for user / assistant / tool

Session-state projection
  turns
  transcript messages
  latest effective instruction context

Trace projection
  recorded TurnContext snapshot
  model request metadata
  events, timings, tool metadata
```

这里的“不属于 Session 核心状态”同时指核心内存模型和会话持久模型。`Session` 不需要拥有 `TurnContext` 来恢复 conversation state；恢复一个 live session 时应该重新采样当前执行环境。`TurnRun` 可以在内存中持有 snapshot，trace/run record 应持久化 snapshot 以支持 debug/replay。

这些 projection 通过同一个 event log 和公共 ID 关联，而不是物理上拆成互相引用的两个文件：

```text
Session event log:
  eventId
  sessionId
  turnId
  messageId
  runId
  requestId

Session-state projection:
  PromptContextItem[] as current effective instruction state

Trace projection:
  promptContextSnapshotId
  turnContextSnapshotId
  toolUseId?
  typed PromptContextItem[] as used context snapshot
  rendered prompt context as provider-visible snapshot
```

因此 trace 可以解释某个 turn 的一次具体执行，但 trace 不是 transcript；session 可以恢复 conversation，trace 可以复盘 execution。它们可以来自同一个物理 JSONL。

Trace projection 默认应该 always-on，但默认只存轻量 trace record：

```text
always-on trace:
  TurnContext snapshot
  full PromptContext typed snapshot content
  PromptContext source metadata / item hashes / aggregate hash
  full rendered provider-neutral messages for each model request
  requestId / runId / turnId / stepIndex
  timing / usage / error metadata

verbose trace:
  providerRawRequest
  full tool input/output, if not already transcript
  streaming chunks
  low-level adapter events
```

所以“不进 transcript”不是“不落盘”。例如：

```text
Session event log / transcript projection:
  user: 帮我改一下
  assistant: 我来看看
  tool: read_file result

Session event log / trace projection:
  currentDate: 2026-06-11
  timezone: Asia/Shanghai
  cwd: E:\Github\helixent\helixent
  model: gpt-5
  renderedMessages: [...]
```

这样第二天 debug 时可以回答：

```text
那个 run 里模型看到的日期是什么？
当时 cwd 是哪个？
用的是哪个 model？
AGENTS.md 是改前还是改后？
```

这些问题不应该依赖用户提前打开 debug mode。verbose trace 可以控制体积和敏感性；always-on trace 负责保住关键证据。

Phase 1 的物理持久化按 session 聚合成一条 event JSONL：

```text
~/.helixent/projects/<projectKey>/
  events/<sessionId>.jsonl
```

一个 session event log 里可以有 transcript、session-state 和 trace records，也可以有多个 run：

```text
session-001
  turn-001 run-001
  turn-001 run-002   # interrupted 后 continuation
  turn-002 run-003
```

JSONL record 用 `type` 和 ID 区分 projection / 粒度：

每行使用 stable envelope，外层字段负责路由、排序和恢复，`data` 放事件自己的 payload：

```ts
interface SessionEventEnvelope<TType extends string, TData> {
  eventId: string;
  type: TType;
  sessionId: string;
  timestamp: string;
  criticality: "session" | "trace";
  turnId?: string;
  runId?: string;
  requestId?: string;
  messageId?: string;
  data: TData;
}
```

```jsonl
{"eventId":"evt-1","type":"message_appended","sessionId":"s1","timestamp":"2026-06-11T07:00:00.000Z","criticality":"session","turnId":"t1","messageId":"m1","data":{"message":{"role":"user","content":"帮我改一下"}}}
{"eventId":"evt-2","type":"turn_run_started","sessionId":"s1","timestamp":"2026-06-11T07:00:01.000Z","criticality":"trace","turnId":"t1","runId":"r1","data":{}}
{"eventId":"evt-3","type":"turn_context_snapshot","sessionId":"s1","timestamp":"2026-06-11T07:00:01.000Z","criticality":"trace","turnId":"t1","runId":"r1","data":{"turnContext":{"currentDate":"2026-06-11","timezone":"Asia/Shanghai","cwd":"E:\\Github\\helixent\\helixent","model":"gpt-5"}}}
{"eventId":"evt-4","type":"model_request","sessionId":"s1","timestamp":"2026-06-11T07:00:02.000Z","criticality":"trace","turnId":"t1","runId":"r1","requestId":"req1","data":{"stepIndex":0,"renderedMessages":[]}}
{"eventId":"evt-5","type":"turn_run_completed","sessionId":"s1","timestamp":"2026-06-11T07:00:03.000Z","criticality":"trace","turnId":"t1","runId":"r1","data":{}}
```

envelope 的作用是让 reader 在 `data` schema 坏掉时仍然能知道这行属于哪个 projection，以及是否影响 resume：

```text
criticality = "session"
  data 坏了 -> resume fail / require repair

criticality = "trace"
  data 坏了 -> resume can continue, mark trace incomplete
```

如果整行都不是合法 JSON，就连 envelope 都不可信，读取器应该保守处理。

这样查一个 session 的历史最方便；同一个 turn 的 continuation run 也自然排在同一条时间线里。更重要的是，它避免了 trace record 引用一个还没写进另一个 session 文件的 `messageId`。以后如果 event log 变得很大，可以在不改 record schema 的前提下再做 sharding。

统一 event log 不代表所有 record 对 resume 一样重要。恢复时按 projection 区分 criticality：

```text
session-state critical:
  message_appended
  turn_created
  turn_status_changed
  latest prompt_context_set

trace-only non-critical for resume:
  turn_context_snapshot
  prompt_context_snapshot
  model_request
  model_response metadata
  tool_started / tool_finished timing
```

策略：

```text
session-state record 损坏:
  resume fail / require repair

trace-only record 损坏:
  resume can continue
  mark trace projection as incomplete
```

例如 `model_request` 的 `renderedMessages` JSON 坏了，debug 时看不到那次完整请求，这是 trace incomplete；但只要 `message_appended` 和 turn 状态还完整，session 仍然能继续。反过来，如果 `message_appended` 坏了，transcript 无法可信恢复，就不能假装正常 resume。

Phase 1 的 session event JSONL 里，trace projection 的最小 record 集合：

```text
turn_run_started
turn_context_snapshot
prompt_context_snapshot
model_request
model_response
tool_started
tool_finished
turn_run_completed
turn_run_failed
```

例子：

```text
turn-001 / run-001
  turn_run_started
  turn_context_snapshot
  prompt_context_snapshot
  model_request request-001
  model_response request-001
  tool_started read_file
  tool_finished read_file
  model_request request-002
  model_response request-002
  turn_run_completed
```

各 record 的最小职责：

| record | 保存什么 |
| --- | --- |
| `turn_context_snapshot` | `currentDate`、`timezone`、`cwd`、`model` |
| `prompt_context_snapshot` | full typed items、source metadata、item hashes、aggregate hash |
| `model_request` | full provider-neutral `renderedMessages`、`requestId`、`runId`、`turnId`、`stepIndex` |
| `model_response` | 模型响应元数据，并关联追加到 transcript 的 assistant `messageId`，不重复保存 assistant message 全文 |
| `tool_started` / `tool_finished` | tool 执行证据，关联 `toolUseId` / tool result `messageId`，不重复保存 tool result 全文 |
| `turn_run_completed` / `turn_run_failed` | 关闭这次 run 的时间线 |

不要把 streaming chunk、middleware hook event、adapter raw event、完整 provider-specific payload 放进默认 record 集合。那些属于 verbose trace 或以后扩展。

去重规则：

```text
Session-state projection:
  保存 user / assistant / tool message 全文

Trace projection:
  保存 model_response metadata
  用 messageId 引用 event log 里的 assistant message
```

例如：

```jsonl
{"type":"model_response","sessionId":"s1","turnId":"t1","runId":"r1","requestId":"req1","assistantMessageId":"message-2","finishReason":"tool_calls","usage":{"inputTokens":100,"outputTokens":20}}
```

如果以后需要保存“不进入 transcript 的 raw provider response”，那属于 verbose trace，不属于 always-on `model_response`。

tool result 也一样去重：

```text
Session-state projection:
  保存 tool result message 全文

Trace projection:
  保存 tool timing / status / error
  用 toolResultMessageId 引用 event log 里的 tool message
```

成功：

```jsonl
{"type":"tool_started","sessionId":"s1","turnId":"t1","runId":"r1","toolUseId":"call_1","name":"read_file","startedAt":"2026-06-11T07:00:00.000Z"}
{"type":"tool_finished","sessionId":"s1","turnId":"t1","runId":"r1","toolUseId":"call_1","status":"ok","toolResultMessageId":"message-3","durationMs":42}
```

失败且没有 transcript tool result message 时，trace 必须保留 error 摘要：

```jsonl
{"type":"tool_finished","sessionId":"s1","turnId":"t1","runId":"r1","toolUseId":"call_1","status":"error","error":"ENOENT: file not found","durationMs":42}
```

`PromptContext` snapshot 默认存全文：

```ts
{
  kind: "project_instructions",
  sourcePath: "E:\\Github\\helixent\\helixent\\AGENTS.md",
  contentHash: "sha256:aaa111",
  content: "use bun\nrun bun run check before finish",
  scope: "project",
  precedence: 20
}
```

不要只存：

```ts
{
  sourcePath: "E:\\Github\\helixent\\helixent\\AGENTS.md",
  contentHash: "sha256:aaa111"
}
```

只存 path + hash 能证明“当时的文件和现在不同”，但不能直接还原模型当时看到的旧内容。既然 always-on trace 已经要保存 rendered messages，typed snapshot 也应该保存全文，这样 replay/debug 不依赖当前文件系统。Phase 1 先不考虑截断和敏感内容策略；以后如果需要，再作为 trace retention/redaction 策略单独设计。

`renderedMessages` 默认也存全文：

```ts
[
  { role: "system", content: "You are Helixent..." },
  {
    role: "user",
    content: "<instructions>use bun...</instructions>",
    sourceItemIds: ["ctx-project-agents"]
  },
  {
    role: "user",
    content: "<turn_context>Current date: 2026-06-11...</turn_context>",
    source: "turn_context"
  },
  { role: "user", content: "帮我改一下", source: "transcript" }
]
```

这样 trace 能解释 provider-neutral request 的 role、顺序、wrapper 和内容边界。只存 rendered hash 会丢掉“Helixent prompt assembly 到底产出了什么”这个最关键证据。`providerRawRequest` 仍然可以是 optional/verbose，因为它是 adapter lowering 之后的 provider-specific payload，可能更重，也可能只是重复 provider-neutral messages 加上一些 SDK 字段。

为了让 `model_request` trace 能保存真实的 provider-neutral `renderedMessages`，prompt assembly 本身应该是一等边界，而不是藏在 `Model` 的私有方法里。

当前代码大致是：

```text
TurnRun._think()
  creates ModelContext
  calls agent.model.stream(modelContext)

Model._buildModelProviderParams()
  system: prompt
  user: contextBlocks
  transcript: messages
```

这个形状太简单，问题是 `TurnRun` 在写 trace 时拿不到已经渲染好的 messages；但如果反过来让 `TurnRun` 自己拼 provider messages，又会让 agent runtime 偷走 model/foundation 层的职责。

目标形状：

```ts
interface PromptAssemblyInput {
  agentPrompt: string;
  promptContextItems: PromptContextItem[];
  turnContext: TurnContext;
  transcriptMessages: NonSystemMessage[];
}

interface RenderedModelRequest {
  messages: RenderedPromptMessage[];
}

function renderModelRequest(input: PromptAssemblyInput): RenderedModelRequest;
```

职责分布：

```text
TurnRun:
  refresh effective prompt context
  freeze prompt context snapshot
  capture TurnContext
  call renderModelRequest(...)
  write model_request trace
  call Model

Prompt assembler:
  provider-neutral ordering
  wrappers
  source mappings
  cache segment metadata

Model:
  provider invocation

Provider adapter:
  provider-specific role mapping
  content part lowering
  tool schema placement
  cache-control annotations
  optional providerRawRequest evidence
```

因此选择 C：抽 provider-neutral prompt assembly 纯函数。它比“继续让 Model 私有渲染”更可追踪，比“让 TurnRun 自己拼 provider messages”更符合分层。

抽出 assembler 后，`Model` 的 public API 应该接收已经 rendered 的 provider-neutral request，旧的 semantic `model.stream(modelContext)` / `model.invoke(modelContext)` 直接删掉：

```ts
interface RenderedModelRequest {
  model: string;
  messages: Message[];
  tools?: Tool[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

model.streamRendered(request);
model.invokeRendered(request);
```

执行路径：

```text
TurnRun
  renderModelRequest(...)
  trace.write(model_request with renderedMessages)
  model.streamRendered(the same rendered request)
```

不要让 `TurnRun` 和 `Model` 各自 render 一遍。否则 trace 记录的是 A，provider 实际收到的是 B，这会把我们刚才设计的 always-on trace 变成不可靠证据。

同一个 `PromptContextItem` 概念在两边语义不同：

| projection | 语义 | 问题 |
| --- | --- | --- |
| session-state projection | 当前有效 instruction state | 下一次 live run 应该用什么上下文继续 |
| trace projection | 某次 run 实际使用的 context snapshot | 当时模型到底看到了什么 |

例如项目 `AGENTS.md` 在 6 月 10 日运行后被修改。session-state projection 可以更新到新内容；6 月 10 日的 trace projection 仍应保留旧内容或旧内容的快照引用，避免 debug 时拿今天的规则解释昨天的模型行为。

读取和冻结时机也按这条边界来：

```text
10:00 创建或恢复 session
  读取当前 AGENTS.md，形成 effective PromptContextItem[]

10:05 start TurnRun
  冻结 used PromptContextSnapshot

10:06 ReAct step #1 / model request #1
  使用同一个 snapshot

10:07 ReAct step #2 / model request #2
  仍使用同一个 snapshot，不重新读文件

10:30 用户修改 AGENTS.md
  不影响正在运行的 TurnRun

10:31 新 turn 或 interrupted-turn continuation
  可以 refresh effective PromptContextItem[]
  新 TurnRun 冻结新的 used PromptContextSnapshot
```

因此 Helixent 不需要在每个 model request 前读 `AGENTS.md`，也不应该把 session 创建时的 instruction context 永久固定到整个 session 生命周期。session-state projection 保存的是 live conversation 接下来会使用的 effective context；trace projection 保存的是某个 run 当时实际使用的 frozen snapshot。

session-state projection 只读取 latest effective context snapshot，不把完整变更历史当成 resume 状态：

```jsonl
{"type":"prompt_context_set","sessionId":"s1","sourceSetHash":"sha256:aaa","items":[...]}
{"type":"prompt_context_set","sessionId":"s1","sourceSetHash":"sha256:bbb","items":[...]}
```

恢复 live session 时，读最后一条 `prompt_context_set`：

```text
latest effective context = sha256:bbb
```

如果要问“为什么 run-001 用的是 aaa，run-002 用的是 bbb”，去 trace projection 查：

```text
Session-state projection:
  下一次 run 应该用什么

Trace projection:
  某次 run 当时实际用了什么
  context 什么时候变化
  old/new hash 和旧内容
```

这避免把 session resume projection 做成 audit log。Session-state projection 负责继续对话；trace projection 负责复盘执行。它们可以来自同一个 `events/<sessionId>.jsonl`。

refresh 策略采用自动 hash 检查：

```text
new TurnRun starts
  discover instruction sources
  compare source set + mtime/hash with current effective context

if unchanged:
  reuse effective PromptContextItem[]

if changed:
  reload typed PromptContextItem[]
  update session-state projection effective context
  record trace/UI diff

then:
  freeze used PromptContextSnapshot for this TurnRun
```

hash 粒度采用两层：每个 source item 一个 hash，整个 effective context 一个 aggregate hash。

```ts
interface PromptContextItem {
  kind: "global_user_instructions" | "project_instructions" | "local_project_instructions";
  sourcePath: string;
  scope: "user" | "project" | "local_project";
  precedence: number;
  content: string;
  contentHash: string;
  contentLength: number;
}

interface EffectivePromptContext {
  sourceSetHash: string;
  items: PromptContextItem[];
}
```

例子：

```text
<repo>/AGENTS.md
  contentHash = aaa

<repo>/packages/api/AGENTS.md
  contentHash = bbb

EffectivePromptContext
  sourceSetHash = hash([
    "<repo>/AGENTS.md", "aaa",
    "<repo>/packages/api/AGENTS.md", "bbb"
  ])
```

如果后来只有 nested 文件变化：

```text
<repo>/AGENTS.md
  aaa -> aaa

<repo>/packages/api/AGENTS.md
  bbb -> ccc

sourceSetHash
  old -> new
```

trace/UI 可以显示具体 diff：

```text
Turn #2 instruction diff:
  unchanged: <repo>/AGENTS.md aaa
  changed:   <repo>/packages/api/AGENTS.md bbb -> ccc
```

不要只 hash 最终拼接后的大字符串。拼接 hash 能发现“整体变了”，但不知道哪个文件变了，也丢掉了 source-aware debug、局部 reload 和 prompt cache segment 语义。rendered request 可以另外有 rendered hash；它回答的是“发给 provider 的请求是否相同”，不是“哪些 instruction source 变了”。

例子：

```text
10:00 Turn #1
  AGENTS.md hash = aaa
  model sees "用 bun test 验证"

10:30 用户修改 AGENTS.md
  hash becomes bbb

10:31 Turn #2 starts
  automatic refresh detects aaa -> bbb
  Session effective context updates
  Turn #2 snapshot freezes new content
  model sees "用 bun run check 验证"
```

这个策略不是每个 model request 前都扫文件。它只发生在新的 `TurnRun` 前，包括普通新 turn 和 interrupted-turn continuation。参考项目里，Codex 的 `TurnContext` 更接近“每 turn 有 snapshot”；ClaudeCode 有 memoized `getUserContext()` 和 cache clear/debug snapshot；Hermes 为 prompt cache 更偏 session-stable。Helixent 选择的是中间路线：下一次 run 自动生效，但一个 run 内保持冻结。

如果 refresh 发现 instruction 文件变了，默认也不需要把“规则变了”作为模型可见提示塞进 prompt：

```text
Turn #1 snapshot:
  AGENTS.md = "用 bun test 验证"

Turn #2 refresh:
  AGENTS.md = "用 bun run check 验证"

Turn #2 model request:
  只渲染当前 AGENTS.md
  不额外加入 "AGENTS.md changed since last run"

Trace/UI:
  记录 old hash -> new hash
  记录 Turn #1 和 Turn #2 使用了不同 snapshot
```

这对应默认策略 C：变化进入 trace/UI，不进入 transcript，也不额外进入模型上下文。模型真正需要的是当前规则；debug/replay 需要的是规则何时变了。只有在某个具体工作流确实需要模型理解“规则刚刚变化”，middleware 才可以显式注入一段 runtime notice；这仍然是 `ModelContext patch`，不是 `Session.messages`。

trace projection 应同时保存 typed snapshot 和 rendered snapshot：

```ts
interface PromptContextTraceSnapshot {
  typedItems: Array<{
    kind: "global_user_instructions" | "project_instructions";
    sourcePath: string;
    content: string;
    contentHash: string;
    scope: "user" | "project";
    precedence: number;
    cacheStable: boolean;
  }>;
  rendered: Array<{
    role: "system" | "developer" | "user";
    content: string;
    index: number;
    sourceItemIds: string[];
  }>;
  providerRawRequest?: unknown;
}
```

两者回答的问题不同：

| 快照 | 回答的问题 |
| --- | --- |
| typed snapshot | 这些 context 从哪里来、是什么 kind、是否 cache-stable、按什么 precedence 排序 |
| rendered snapshot | provider request 里最终长什么样，包装、顺序、role 是否正确 |

rendered snapshot 应保存 provider request 级别的 message list，而不是一个拼接后的大字符串。这里的默认 rendered snapshot 指 Helixent prompt assembly 之后、provider adapter lowering 之前的 provider-neutral messages。最小字段是 `role`、`content`、`index`、`sourceItemIds`。

如果 provider adapter 会改写 role、包装、cache-control 标记、tool schema 位置或 content parts，可以再保存 `providerRawRequest`。这份 raw request 是 adapter 之后的真实 API payload evidence，用来 debug provider adapter；它不替代 provider-neutral rendered snapshot。

只存 `sourcePath + hash` 会让 replay 依赖当前文件系统；只存 rendered text 会丢掉 source-aware debug 和 prompt cache 语义；只存单个拼接字符串则会丢掉 provider request 的 message 边界。因此 trace 里应保留完整 typed content、hash/source 元数据，以及渲染后的 provider-visible message list。

记录粒度：

```text
TurnRunTraceRecord
  runId
  sessionId
  turnId
  promptContextSnapshotId
  turnContextSnapshotId

ModelRequestRecord #0
  runId
  requestId
  stepIndex: 0
  renderedMessages

ModelRequestRecord #1
  runId
  requestId
  stepIndex: 1
  renderedMessages

...
```

`PromptContextTraceSnapshot` 和 `TurnContext` snapshot 是 `TurnRun` 级共享事实。`renderedMessages` 是每次 model request 级事实，因为 ReAct loop 每一步都会把新的 assistant/tool_result transcript 拼进去。debug 某次模型响应时，应该看对应 `ModelRequestRecord.renderedMessages`，而不是只看 `TurnRun` 的共享 context。

## 源码落点

| 概念 | 文件 |
| --- | --- |
| `Session.contextBlocks` / `Session.messages` | `src/agent/session.ts` |
| 创建 `ModelContext` | `src/agent/turn-run.ts` |
| provider-neutral prompt assembly | future `src/foundation/models/prompt-assembly.ts` or equivalent |
| `beforeModel` runtime patch | `src/agent/agent-middleware.ts` |
| skills prompt patch | `src/agent/skills/skills-middleware.ts` |
| todo reminder patch | `src/agent/todos/todos.ts` |
| provider messages 构建 | `src/foundation/models/model.ts` |

## 速记

```text
Agent.prompt            = 这个 agent 是谁、怎么工作
middleware patch        = 本次请求临时加料，不写入 session
Session.contextBlocks   = 当前会话级背景资料承载物，不是对话
PromptContextItem       = contextBlocks 的目标形态，保留来源和类型
TurnContext             = TurnRun 级执行事实快照，例如日期、时区、cwd、model
Session.messages        = 真实发生过的 transcript
Model                   = 把上面这些按顺序拼成 provider messages
```

## Phase 1 scope

这个设计不按“只拼日期字符串”的最小补丁实现。Phase 1 应该作为完整上下文系统一期落地：

```text
1. session event envelope + session-level event log
2. provider-neutral prompt assembler
3. rendered Model API
4. TurnContext capture / render / trace
5. typed PromptContextItem
6. AGENTS.override.md
7. item hash + aggregate sourceSetHash
8. automatic pre-run prompt context refresh
```

推荐实施顺序：

```text
1. event envelope and event log writer/reader
2. prompt assembler and rendered Model API
3. TurnContext capture/render/trace
4. typed PromptContextItem + contextBlocks compatibility adapter
5. AGENTS.override.md + hash refresh
6. focused tests
```

不单独做两个物理持久化文件，也不先做一个只能塞日期的临时 `contextBlocks` 补丁。否则后面会再迁移一次 prompt/session/trace 边界。
