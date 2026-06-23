# Transcript Compaction Implementation

本文解释 Helixent 现在这版 compact 是怎么实现的。先看一个很小的例子，再拆到代码结构。

## 一个例子

假设一次会话已经很长：

```text
user: 帮我设计 compact
assistant: 先确认边界...
assistant tool_use: read_file(...)
tool_result: 很长的文件内容...
user: 继续
assistant: 我会按 ADR 开发...
```

当下一次模型请求快超过模型上下文窗口时，Helixent 不会压缩所有东西。它只压缩 transcript 里较旧的部分，并保留最近一段完整的 tail：

```text
compact 前 active transcript:
  old user
  old assistant
  old tool_use
  old tool_result
  latest user
  latest assistant

compact 后 active transcript:
  synthetic user summary
  latest user
  latest assistant
```

这里的 `synthetic user summary` 不是用户新发的请求，而是 Helixent 生成的一条背景摘要消息。它会明确写：

```text
This is background context from transcript compaction, not a new user request.
```

这样下一轮模型看到的是：

```text
agent prompt
prompt context
turn context
synthetic compact summary
preserved tail
```

后续 assistant 和 tool message 会继续追加到 compact 后的新 transcript 上，而不是追加到 compact 前的老 transcript 上。

## 哪些内容会 compact

Helixent 把一次模型请求拆成两类：

```text
不可压缩:
  agent prompt
  prompt context
  turn context
  tool schemas

可压缩:
  transcript history
```

不可压缩的内容仍然会参与 token 估算，因为它们真实占用上下文窗口。但 compact 真正改写的只有 transcript。

这点很重要。比如 tool schema 会让请求变大，所以它会影响是否触发 compact；但 tool schema 本身不会被摘要，也不会进入 compact summary 请求。compact summary 请求是无工具请求。

## 入口在哪里

入口在 `TurnRun`，不是 `Agent` 配置。

相关文件：

- `src/agent/turn-run.ts`
- `src/agent/compaction/index.ts`
- `src/agent/session.ts`
- `src/agent/__tests__/compaction.test.ts`
- `src/agent/__tests__/agent-runner.test.ts`
- `src/agent/__tests__/session.test.ts`

核心调用链是：

```text
TurnRun._think()
  -> _assembleRequestAfterOptionalCompaction()
      -> render current request
      -> estimate tokens
      -> maybe generate summary
      -> install compacted transcript
      -> render request again
  -> model.streamRendered(...)
```

也就是说，compact 发生在模型请求发送前。模型真正收到请求之前，Helixent 会先检查是否需要 compact。

## 第一步：解析模型上下文窗口

实现函数：

```ts
resolveKnownModelContextWindow(model)
```

位置：

```text
src/agent/compaction/index.ts
```

当前只认精确模型名：

```text
deepseek-v4-pro      -> 1,000,000 tokens
deepseek-v4-flash    -> 1,000,000 tokens
deepseek-chat        -> 1,000,000 tokens
deepseek-reasoner    -> 1,000,000 tokens
```

模型名会先 `trim().toLowerCase()`，但不会做模糊匹配。

例如：

```text
DeepSeek-V4-Flash          会识别
deepseek-v4-flash-custom   不会识别
my-deepseek-proxy          不会识别
```

如果模型不在已知表里，自动 compact 直接关闭。这比猜一个上下文窗口安全。

## 第二步：估算当前完整请求 token

实现函数：

```ts
estimateRenderedRequestTokens({ messages, tools })
```

它估算的是完整 rendered request，不只是 transcript：

```text
agent prompt
prompt context
turn context
transcript messages
tool schemas
```

公式很简单：

```text
textTokens = ceil(serializedChars / 3)
imageTokens = imageCount * 2000
totalTokens = textTokens + imageTokens
```

图片的 URL payload 不直接计入大段文本。估算前会把图片块简化成：

```ts
{
  type: "image_url",
  image_url: {
    detail: content.image_url.detail
  }
}
```

这样不会因为本地 file URL 或 base64-like 内容把估算冲歪，同时每张图统一按 2000 tokens 计。

## 第三步：判断是否触发 compact

在 `TurnRun._assembleRequestAfterOptionalCompaction()` 里：

```text
triggerTokens = floor(contextWindowTokens * 0.85)
targetTokens = floor(contextWindowTokens * 0.55)
```

以 DeepSeek V4 的 1,000,000 token 窗口为例：

```text
触发线: 850,000 tokens
目标线: 550,000 tokens
```

如果当前完整请求估算小于 850,000 tokens，就不 compact。

如果达到 850,000 tokens，Helixent 会尝试把 compact 后的新请求控制到 550,000 tokens 内。这里的目标线不是只看 tail，而是最后会重新估算：

```text
agent prompt + prompt context + turn context + summary + tail + tool schemas
```

如果 summary 太大，导致 compact 后仍超过目标线，本次 compact 会 abort，active transcript 不变。

## 第四步：选择 preserved tail

实现函数：

```ts
selectPreservedTail(entries, { targetTokens })
```

tail 的目标是保留最近一段仍然需要原文语义的对话，而不是只保留最后一个 user message。

基础策略：

```text
从最新 user message 开始，保留后面的连续 transcript 后缀。
```

例如：

```text
message-1 user: old request
message-2 assistant: old answer
message-3 user: please inspect src/a.ts
message-4 assistant: tool_use read_file
message-5 tool: tool_result
message-6 assistant: result explanation
```

tail 会是：

```text
message-3
message-4
message-5
message-6
```

这样 user、assistant、tool 的关联还在，不会只剩一句最新 user。

## 第五步：保护 tool_use / tool_result 对

有一种 tricky case：

```text
message-1 user: old request
message-2 assistant: tool_use bash
message-3 user: please continue after interruption
message-4 tool: tool_result for bash
message-5 assistant: command finished
```

如果只从最新 user `message-3` 开始 tail，就会保留 `tool_result`，但丢掉对应的 `tool_use`。

所以实现里有：

```ts
findSafeTailStartIndex(...)
expandStartIndexForToolPairs(...)
findToolUseIndex(...)
```

它会发现 tail 里有一个 `tool_result`，但对应的 assistant `tool_use` 在 tail 外，于是把 tail 起点向前扩展到 `message-2`。

最终 tail 是：

```text
message-2 assistant: tool_use bash
message-3 user: please continue after interruption
message-4 tool: tool_result for bash
message-5 assistant: command finished
```

compact 后的 replacement transcript 不应该出现孤立的 `tool_result`，也不应该出现没有结果的 `tool_use`。

## 第六步：tail 太大时只截断 tool_result

如果 preserved tail 自己就超过目标预算，Helixent 不会截断 user message，也不会截断 assistant text 或 `tool_use`。

唯一允许缩短的是：

```text
tool_result.content
```

实现函数：

```ts
fitTailToBudget(...)
collectToolResultRefs(...)
truncateToolResultContent(...)
```

截断顺序是先处理最大的 tool result。截断结果保留头尾，并插入显式 marker：

```text
[..., tool_result truncated during transcript compaction:
originalChars=123456,
keptHeadChars=6000,
keptTailChars=3000,
...]
```

如果所有可截断 tool result 都处理完后，tail 仍然超过预算，本次 compact abort，active transcript 不变。

## 第七步：把旧 transcript 序列化成 summary 原材料

summary 的原材料不是 provider-specific chat messages，而是一段 provider-neutral labeled text。

实现函数：

```ts
serializeCompactionSourceMaterial(entries)
```

它会把每条 transcript entry 写成：

```text
[MESSAGE message-1 role=user]
用户文本

[MESSAGE message-2 role=assistant]
assistant 文本
[TOOL_USE id=toolu_1 name=read_file]
{
  "path": "src/a.ts"
}

[MESSAGE message-3 role=tool]
[TOOL_RESULT tool_use_id=toolu_1]
文件内容
```

图片会变成占位文本：

```text
[image_url omitted during transcript compaction: detail=high, url=file:///tmp/a.png]
```

assistant 的 thinking block 不会进入 summary source material。第一版不试图保存 provider-exposed thinking。

## 第八步：生成九段式 summary

summary 请求由这个函数构造：

```ts
buildCompactionSummaryRequest(...)
```

它发送一条 user message，要求模型输出 Claude Code 风格的九段式 checkpoint：

```text
1. Primary Request and Intent
2. Key Technical Concepts
3. Files and Code Sections
4. Errors and Fixes
5. Problem Solving
6. All User Messages
7. Pending Tasks
8. Current Work
9. Optional Next Step
```

这个请求有几个关键限制：

```text
使用当前 agent 的主模型
不传 tools
不传 tool schemas
不允许通过工具继续执行
只总结 selected compacted entries
```

输出 token cap 是：

```text
min(20_000, max(4_000, compactedInputEstimateTokens * 0.10))
```

这个 cap 只作用于 summary 请求，不会改 agent 正常运行时的 `model.options`。

## 第九步：安装 replacement transcript

summary 生成成功后，`TurnRun` 不会立刻安装。它先临时构造一份 replacement transcript：

```text
synthetic summary user message
preserved tail entries
```

然后重新 assemble request 并估算 token：

```text
agent prompt
prompt context
turn context
replacement transcript
tool schemas
```

如果这个完整请求仍超过 55% target，本次 compact 失败，不安装。

如果通过预算检查，就调用：

```ts
Session.installCompactedTranscript(...)
```

这个方法会把 `Session` 当前 active transcript 替换成：

```text
summaryEntry
...preservedTail
```

summary entry 的 metadata 是：

```ts
{
  synthetic: true,
  source: "compact"
}
```

这意味着 UI 或 debug 工具可以区分：

```text
用户真的说的话
compact 生成的背景摘要
```

## 事件日志记录了什么

成功 compact 会写一个 session-critical 事件：

```text
transcript_compacted
```

payload 包括：

```text
summaryMessage
compactedMessageIds
preservedTailMessageIds
replacementMessageIds
replacementTranscript
tokenEstimate
modelContextWindow
compactionSourceMaterial
reason
```

其中 `tokenEstimate` 包括：

```text
beforeTokens
afterTokens
triggerTokens
targetTokens
```

失败 compact 会写 trace 事件：

```text
transcript_compaction_failed
```

常见失败原因：

```text
summary failed
preserved_tail_exceeds_budget_after_tool_result_truncation
compacted_transcript_exceeds_target_budget
```

失败时 active transcript 不变，也不会安装类似 "summary unavailable" 的假 summary。

## 为什么同一个 TurnRun 失败后不重试

`TurnRun` 有一个状态：

```ts
private _autoCompactFailed = false;
```

如果当前 turn run 的 compact 尝试失败，它会设为 `true`。后续同一个 ReAct turn 里的模型 step 即使再次超过 85% 触发线，也不会再次尝试 compact。

原因是避免这种循环：

```text
step 1: compact 失败
step 1: 继续原请求
tool_result 追加后更大
step 2: 又 compact 失败
step 2: 继续原请求
...
```

新的 user turn 或 steer turn 会创建新的 `TurnRun`，所以未来仍可再试。

## 成功路径完整流程

一次成功 compact 大致是：

```text
1. TurnRun 准备发模型请求
2. renderModelRequest(...) 得到完整 rendered request
3. resolveKnownModelContextWindow(...) 找到上下文窗口
4. estimateRenderedRequestTokens(...) 估算 token
5. 达到 85% trigger
6. selectPreservedTail(...) 选择 tail
7. serializeCompactionSourceMaterial(...) 序列化旧 transcript
8. buildCompactionSummaryRequest(...) 构造无工具 summary 请求
9. model.streamRendered(summaryRequest) 生成 summary
10. 构造 summary + tail 的 replacement transcript
11. 重新估算 compact 后完整请求
12. 不超过 55% target
13. Session.installCompactedTranscript(...)
14. 记录 transcript_compacted
15. 用 compact 后 request 调主模型
```

## 失败路径完整流程

compact 失败时：

```text
1. 记录 transcript_compaction_failed trace
2. 设置 _autoCompactFailed = true
3. active transcript 不变
4. 本次模型请求继续使用原 assembled request
```

这保证 compact 不会因为摘要失败而丢历史。

## 测试覆盖

主要测试分三层。

`src/agent/__tests__/compaction.test.ts` 覆盖纯逻辑：

```text
已知/未知模型上下文窗口
token 估算，包含 tools 和 image
source material 序列化
preserved tail 选择
tool pair 边界扩展
tool_result 截断
summary request 构造
```

`src/agent/__tests__/session.test.ts` 覆盖 Session 状态变化：

```text
installCompactedTranscript 会安装 synthetic summary + preserved tail
transcript_compacted event 带 replacement transcript 和 source material
```

`src/agent/__tests__/agent-runner.test.ts` 覆盖集成行为：

```text
已知模型在大请求前自动 compact
summary 请求不带 tools
未知模型不 compact
summary 太大时 abort
summary 失败后同一 TurnRun 不重试
```

## 这一版的设计取舍

这版 compact 故意保持保守：

```text
不要求 provider countTokens
不让用户配置 DeepSeek V4 上下文窗口
不引入单独 compact model
不压缩 prompt context / turn context / tool schemas
不做 provider prompt-too-long 后的 reactive compact
不在 tool 执行中途 compact
```

它优先保证：

```text
不会因为 compact 失败丢 transcript
不会切断 tool_use/tool_result
不会只保留 user message 造成语义漂移
compact 后 Session.messages 和模型实际看到的 transcript 对齐
```

## 读代码的推荐顺序

如果从学习角度读代码，可以按这个顺序：

1. `src/agent/__tests__/compaction.test.ts`
2. `src/agent/compaction/index.ts`
3. `src/agent/__tests__/session.test.ts`
4. `src/agent/session.ts` 的 `installCompactedTranscript`
5. `src/agent/__tests__/agent-runner.test.ts`
6. `src/agent/turn-run.ts` 的 `_assembleRequestAfterOptionalCompaction`

先读测试会更容易。测试展示的是 Helixent 希望保证的外部行为；实现只是让这些行为成立的内部路径。
