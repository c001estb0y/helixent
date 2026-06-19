# Prompt Context Trace Example

本文只讲一个具体例子：一次 agent run 中，`PromptContextItem` 如何从 instruction files 进入 provider request，又如何被 `TraceStore` 保存为可调试的快照。

## 场景

假设用户在 Helixent 工程里发起一个 turn：

```text
user: 帮我实现 Session/Turn
```

这次 run 有两份 instruction source：

```text
C:/Users/minusjiang/.codex/AGENTS.md
E:/Github/helixent/helixent/AGENTS.md
```

它们都应该让模型看见，但它们都不是：

```text
不是 Agent.prompt
不是 Session.messages
不是用户这轮真正输入的 user message
```

它们是 instruction context，应先表示为 typed `PromptContextItem`。

## Typed Items

加载后，Session 当前有效的 prompt context 可以是：

```ts
const promptContextItems = [
  {
    id: "ctx-global-agents",
    kind: "global_user_instructions",
    scope: "user",
    sourcePath: "C:/Users/minusjiang/.codex/AGENTS.md",
    content: "Always answer in Chinese. Prefer concise explanations.",
    contentHash: "sha256:aaa111",
    precedence: 10,
    cacheStable: true,
  },
  {
    id: "ctx-project-agents",
    kind: "project_instructions",
    scope: "project",
    sourcePath: "E:/Github/helixent/helixent/AGENTS.md",
    content: "Helixent is a Bun TypeScript ReAct agent library. Keep foundation generic.",
    contentHash: "sha256:bbb222",
    precedence: 20,
    cacheStable: true,
  },
];
```

这份 typed 数据回答的是来源问题：

```text
这段上下文从哪里来？
它是全局用户指令，还是项目指令？
优先级是什么？
内容 hash 是多少？
它是否稳定到可以参与 prompt cache？
```

如果只保存最后拼出来的一段文本，这些问题就很难回答。

## Rendered Messages

provider 不会直接收到 `PromptContextItem[]`。在 prompt assembly 阶段，Helixent 会把 typed items 渲染成 provider-visible messages。

例如一次 OpenAI Chat Completions 风格的渲染结果可能是：

```ts
const renderedMessages = [
  {
    index: 0,
    role: "system",
    sourceItemIds: [],
    content: "You are a ReAct-style coding agent...",
  },
  {
    index: 1,
    role: "user",
    sourceItemIds: ["ctx-global-agents", "ctx-project-agents"],
    content: `<instruction_context>
<global_user_instructions source="C:/Users/minusjiang/.codex/AGENTS.md">
Always answer in Chinese. Prefer concise explanations.
</global_user_instructions>

<project_instructions source="E:/Github/helixent/helixent/AGENTS.md">
Helixent is a Bun TypeScript ReAct agent library. Keep foundation generic.
</project_instructions>
</instruction_context>`,
  },
  {
    index: 2,
    role: "user",
    sourceItemIds: [],
    content: "帮我实现 Session/Turn",
  },
];
```

这份 rendered 数据回答的是模型输入问题：

```text
模型当时到底看到了哪些 messages？
instruction context 被渲染成了哪个 role？
global AGENTS.md 和 project AGENTS.md 的顺序是否正确？
某个 provider message 是由哪些 typed items 生成的？
```

注意：`index: 2` 才是真实用户输入。`index: 1` 虽然 role 可能也是 `user`，但它是 prompt context 渲染产物，不是 transcript 里的用户消息。

## Trace Record

`TraceStore` 保存的是一次 run 的执行证据，不是 Session 当前状态的引用。

推荐记录：

```ts
const traceRecord = {
  runId: "run-001",
  sessionId: "session-20260611-001",
  turnId: "turn-001",
  promptContextSnapshot: {
    typedItems: promptContextItems,
    rendered: renderedMessages,
    providerRawRequest: {
      model: "gpt-4.1",
      messages: renderedMessages.map(({ role, content }) => ({ role, content })),
      tools: ["read_file", "apply_patch"],
    },
  },
};
```

这里同时保存三层：

```text
typedItems:
  完整 typed content + source/hash/scope/precedence/cacheStable

rendered:
  provider-visible message list + sourceItemIds

providerRawRequest:
  adapter 处理后的最终请求形态，可选但很适合 debug provider 差异
```

## 为什么不能只存一种

只存 `sourcePath + contentHash`：

```json
{
  "sourcePath": "E:/Github/helixent/helixent/AGENTS.md",
  "contentHash": "sha256:bbb222"
}
```

问题是 replay/debug 会依赖当前文件系统。文件如果被改了、删了、移动了，就还原不了当时模型看到的内容。

只存 rendered text：

```json
{
  "content": "<instruction_context>...</instruction_context>"
}
```

问题是看得到模型输入，但丢了 source-aware 信息。你不知道这段内容来自全局规则还是项目规则，也不知道 precedence、scope、cacheStable。

只存一个拼接大字符串：

```json
{
  "prompt": "system...\n\ninstruction_context...\n\nuser..."
}
```

问题是 provider message 边界丢了。debug 时无法判断：

```text
哪个部分是 system？
哪个部分是 contextual user？
哪个部分是真实 user turn input？
adapter 有没有改 role？
cache-control 应该挂在哪个 message 上？
```

## 文件修改后的例子

假设 `run-001` 发生在 2026-06-11，当时项目 `AGENTS.md` 是：

```text
contentHash = sha256:bbb222
content = "Helixent is a Bun TypeScript ReAct agent library. Keep foundation generic."
```

2026-06-12，用户改了项目 `AGENTS.md`：

```text
contentHash = sha256:ddd444
content = "Helixent is a Bun TypeScript agent framework. Prefer explicit Session/Turn APIs."
```

此时：

```text
SessionStore:
  可以更新到 sha256:ddd444，供下一次 live run 使用。

TraceStore for run-001:
  必须仍然保留 sha256:bbb222 和当时 rendered messages。
```

否则 debug `run-001` 时，就会拿 6 月 12 日的新规则解释 6 月 11 日模型的行为。

## 一句话

```text
PromptContextItem 解释“上下文从哪里来、是什么”。
Rendered snapshot 证明“模型当时实际看到了什么”。
TraceStore 应该两者都存。
```
