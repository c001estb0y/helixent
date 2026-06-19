# Trace Record Types

本文说明 Helixent 的 always-on trace 里三种最核心的 record：

```text
turn_context_snapshot
prompt_context_snapshot
model_request
```

它们都属于 `TraceStore`，不是 `Session.messages`，也不是 transcript。区别是：

```text
turn_context_snapshot   = 这次 run 的执行环境事实
prompt_context_snapshot = 这次 run 冻结使用的指令上下文
model_request           = 某一次模型请求最终渲染出的 message list
```

## 场景

假设用户在 Helixent 工程里发起一个 turn：

```text
user: 帮我实现日期功能
```

当时运行环境是：

```text
currentDate = 2026-06-11
timezone    = Asia/Shanghai
cwd         = E:\Github\helixent\helixent
model       = gpt-5
```

同时这次 run 读取到了两份 instruction context：

```text
C:\Users\minusjiang\.helixent\AGENTS.md
E:\Github\helixent\helixent\AGENTS.md
```

## `turn_context_snapshot`

`turn_context_snapshot` 回答：

```text
这次 run 的执行环境是什么？
```

例子：

```json
{
  "type": "turn_context_snapshot",
  "sessionId": "session-001",
  "turnId": "turn-001",
  "runId": "run-001",
  "turnContext": {
    "currentDate": "2026-06-11",
    "timezone": "Asia/Shanghai",
    "cwd": "E:\\Github\\helixent\\helixent",
    "model": "gpt-5"
  }
}
```

这条 record 不是用户消息。它表示这次 run 开始时，`TurnRun` 捕获到的运行时事实。

典型 debug 问题：

```text
模型当时以为今天是哪天？
当时工作目录是哪个？
当时用的是哪个 model？
```

## `prompt_context_snapshot`

`prompt_context_snapshot` 回答：

```text
这次 run 用了哪些指令上下文？来源、优先级、内容和 hash 是什么？
```

例子：

```json
{
  "type": "prompt_context_snapshot",
  "sessionId": "session-001",
  "turnId": "turn-001",
  "runId": "run-001",
  "sourceSetHash": "sha256:ctx-all-123",
  "items": [
    {
      "id": "ctx-global-agents",
      "kind": "global_user_instructions",
      "scope": "user",
      "sourcePath": "C:\\Users\\minusjiang\\.helixent\\AGENTS.md",
      "precedence": 10,
      "contentHash": "sha256:aaa111",
      "content": "Always answer in Chinese."
    },
    {
      "id": "ctx-project-agents",
      "kind": "project_instructions",
      "scope": "project",
      "sourcePath": "E:\\Github\\helixent\\helixent\\AGENTS.md",
      "precedence": 20,
      "contentHash": "sha256:bbb222",
      "content": "Use Bun. Run bun run check before finishing."
    }
  ]
}
```

这条 record 保存的是 frozen snapshot。即使之后 `AGENTS.md` 被修改，旧 run 的 trace 仍然能还原当时模型看到的指令内容。

典型 debug 问题：

```text
这次 run 用的是哪个 AGENTS.md？
当时项目规则是改前还是改后？
global 指令和 project 指令谁排在前面？
```

## `model_request`

`model_request` 回答：

```text
某一次请求真正喂给模型的 provider-neutral messages 长什么样？
```

例子：

```json
{
  "type": "model_request",
  "sessionId": "session-001",
  "turnId": "turn-001",
  "runId": "run-001",
  "requestId": "request-001",
  "stepIndex": 0,
  "renderedMessages": [
    {
      "role": "system",
      "content": "You are Helixent, a ReAct-style coding agent.",
      "source": "agent_prompt"
    },
    {
      "role": "user",
      "content": "<instructions>\nAlways answer in Chinese.\n\nUse Bun. Run bun run check before finishing.\n</instructions>",
      "source": "prompt_context",
      "sourceItemIds": ["ctx-global-agents", "ctx-project-agents"]
    },
    {
      "role": "user",
      "content": "<turn_context>\nCurrent date: 2026-06-11\nTimezone: Asia/Shanghai\nWorking directory: E:\\Github\\helixent\\helixent\nModel: gpt-5\n</turn_context>",
      "source": "turn_context"
    },
    {
      "role": "user",
      "content": "帮我实现日期功能",
      "source": "transcript",
      "messageId": "message-001"
    }
  ]
}
```

这条 record 保存的是 prompt assembly 之后、provider adapter lowering 之前的 provider-neutral message list。

典型 debug 问题：

```text
TurnContext 被放在哪个 role 里？
instruction context 和真实用户输入的顺序对不对？
哪些 rendered message 来自 transcript？
哪些 rendered message 只是上下文注入？
```

## 三者关系

一次 `TurnRun` 共享一份 `turn_context_snapshot` 和一份 `prompt_context_snapshot`：

```text
run-001
  turn_context_snapshot
  prompt_context_snapshot
  model_request request-001 stepIndex=0
  model_request request-002 stepIndex=1
```

`model_request` 是 request 级 record。ReAct loop 每多走一步，transcript 里可能多出 assistant/tool_result 消息，所以每次模型请求都要保存自己的 `renderedMessages`。

## 和 Transcript 的区别

Transcript 只保存真实发生的对话消息：

```text
user: 帮我实现日期功能
assistant: 我先看看代码
tool: read_file result
assistant: 已完成
```

Trace 保存执行证据：

```text
turn_context_snapshot
prompt_context_snapshot
model_request
model_response
tool_started
tool_finished
```

所以：

```text
TurnContext 模型可见，但不是 transcript。
PromptContext 模型可见，但不是 transcript。
model_request 是请求快照，也不是 transcript。
```

## 一句话

```text
turn_context_snapshot 解释运行环境。
prompt_context_snapshot 解释上下文来源和内容。
model_request 证明模型请求最终长什么样。
```
