# Context Compaction and Ambiguous References

这篇文档记录一个具体问题：

```text
用户说：2.3继续完成
原始语境：继续第 2 项和第 3 项
compact 后误读：继续 2.3 小节
```

问题不是模型突然不认识中文，而是 compact 改写了上下文结构。原始上下文里可能已经有一条 assistant 消息把 `2.3` 澄清成“第 2 项和第 3 项”；compact 后如果这条澄清没有被原文保留，也没有被 summary 明确写进去，后续模型只能重新猜。`2.3` 同时像“2 和 3”也像“小节 2.3”，于是误读发生。

## 具体例子

compact 前：

```text
User: 2.3继续完成
Assistant: 明白，你是说继续第 2 项和第 3 项，不是 2.3 小节。
```

compact 后如果只保留了最近 user message：

```text
User: 2.3继续完成
Summary: ... 没明确写“2.3=第2项和第3项”
```

此时模型看到的核心证据仍然是原始歧义文本 `2.3继续完成`。而“正确解释它是第 2 项和第 3 项”的 assistant 原文没被保留，summary 又没写清楚，于是模型就可能重新解释成“2.3 小节”。

## 一句话结论

Codex 有一些“tail-ish retention”，但没有可靠的“preserved tail”。

也就是说，Codex 可能会保留最近一部分用户消息或 retained messages，但这不等于稳定保留“最近几条完整 user / assistant / tool 对话”。如果关键消歧信息只存在于 assistant 的确认里，它仍然可能在 compact 后丢失。

更稳的 compact 结果应该是：

```text
summary + resolvedReferences + preservedTail
```

其中：

- `summary` 保存任务整体状态。
- `resolvedReferences` 结构化记录短引用的真实含义。
- `preservedTail` 原文保留最近一段完整对话，尤其是用户纠错、assistant 澄清和当前执行计划。

## Codex 的 Tail-ish Retention

Codex 的 compact 可以按实现分成三条路径，但语义上仍然是一类：用模型生成 compacted history / summary，再替换旧 history。

| 路径 | 源码名 | 保留什么 | 不保证什么 |
| --- | --- | --- | --- |
| Local compact | `Responses` | 最近的 user messages，最多约 20k token，然后加 summary | 不保留最近 assistant/tool 原文 |
| Remote compact v1 | `ResponsesCompact` | 服务端返回 compacted transcript，本地再过滤 | 不保证最近 assistant 原文完整保留 |
| Remote compact v2 | `ResponsesCompactionV2` | 从后往前保留 retained messages，预算约 64k token；实际主要是 user/hook/compaction | tool output 不留；assistant 原文不靠这个机制保留 |

相关源码：

- `codex-rs/core/src/compact.rs`
  - `collect_user_messages()` 只收集真实用户消息。
  - `build_compacted_history_with_limit()` 从最近 user messages 往前选，预算 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`。
- `codex-rs/core/src/compact_remote.rs`
  - `should_keep_compacted_history_item()` 会丢掉 `FunctionCallOutput`、`ToolSearchOutput`、`CustomToolCallOutput` 等工具结果。
- `codex-rs/core/src/compact_remote_v2.rs`
  - `RETAINED_MESSAGE_TOKEN_BUDGET = 64_000`。
  - `is_retained_for_remote_compaction_v2()` 第一层只筛 `user` / `developer` / `system` message。

所以，“有 retained messages”不等于“有 Claude Code 那种 `messagesToKeep`”，也不等于“保留最近 N 条完整消息”。Codex 更像是保留一部分模型认为可组成 compacted history 的材料，而不是给应用层一个明确的 tail 保证。

## 为什么 2.3 仍然会出错

`2.3` 的正确含义不在字面上，而在上下文的解释关系里：

```text
用户原句：2.3继续完成
assistant 澄清：这是第 2 项和第 3 项，不是 2.3 小节
```

如果 compact 只留下用户原句，没有留下 assistant 澄清，也没有把澄清写进 summary，那么压缩后的上下文只剩：

```text
用户要求继续 2.3
```

这句话本身是歧义的。模型后续把它理解成“小节 2.3”，不是随机错误，而是 compact 丢掉了解释权。

要避免这个问题，summary 里必须显式写：

```text
"2.3继续完成" 在当时语境中指继续第 2 项和第 3 项，不是 2.3 小节。
```

或者把它结构化记录为：

```json
{
  "raw": "2.3继续完成",
  "meaning": "继续第 2 项和第 3 项，不是 2.3 小节",
  "evidenceMessageIds": ["..."]
}
```

## Claude Code 的对照

Claude Code 里要区分两种口径：

| 类别 | 机制 | 说明 |
| --- | --- | --- |
| 外部稳定可用 | Manual Full Compact | 用户 `/compact`，传统 summary-replace |
| 外部稳定可用 | Auto Compact | token 接近上限时自动 compact，外部版通常 fallback 到 full compact |
| 外部稳定可用 | Partial Compact | TUI Rewind 的 `Summarize from here`，会产生 `messagesToKeep` |
| 内部/gated | Session Memory Compact | 依赖内部 gate 和 session memory summary |
| 内部/gated | Cached Microcompact / `cache_edits` | 服务端缓存视图删除，外部不稳定可用 |
| 内部/gated | Time-based Microcompact | idle 后清理旧 tool_result，默认 disabled / gate 控制 |
| 内部/gated | API Context Management | thinking 清理部分可用，tool clearing 明确偏内部 |
| 内部/gated | Reactive Compact | prompt-too-long/media-too-large 后恢复型 compact，偏内部 |

`messagesToKeep` 不是“永远保留最近 N 条消息”。它是某些 compact 结果上的一个原文保留段。它的价值在于：如果那段原文刚好包含“`2.3` 已经被解释成第 2 项和第 3 项”的 assistant 澄清，模型就不用重新猜。

但它仍不是绝对保证。只要关键澄清不在 `messagesToKeep` 里，仍然需要 summary 或 `resolvedReferences` 保存解析结果。

## 对 Helixent 的建议

Helixent 不要只做最朴素的 summary-replace。建议 compact 输出至少包含三块：

```ts
type CompactResult = {
  summary: string;
  resolvedReferences: ResolvedReference[];
  preservedTail: Message[];
};

type ResolvedReference = {
  raw: string;
  meaning: string;
  evidenceMessageIds: string[];
};
```

对 `2.3` 这个案例，compact 结果应该保留：

```json
{
  "raw": "2.3继续完成",
  "meaning": "继续第 2 项和第 3 项，不是 2.3 小节",
  "evidenceMessageIds": ["user-message-id", "assistant-clarification-id"]
}
```

保留优先级建议：

1. 最近一轮用户意图和 assistant 澄清。
2. 用户纠错、澄清、否定。
3. 编号引用、代词引用、简称的解析结果。
4. 未完成 todo 和当前执行计划。
5. `tool_use` / `tool_result` 配对完整性。

一句话：**compact 不只是压 token，它还要保存解释权。** 对短引用来说，保存“它当时被解释成什么”比保存原始字面更重要。
