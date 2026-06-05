# LLM Space — 设计规格

> 一个用于**事后 debug / 迭代 Helixent agent transcript** 的本地 Web 工具。

本文档由一次设计 grill 沉淀而来，记录已确认的决策、被否决的方案及其理由，作为 v1 实现的依据。

---

## 1. 定位

- **纯自用 / 团队内**的本地 Web 工具。**不做产品**：不鉴权、不多租户、不沙箱、不适配任意模型栈。
- 服务对象：调 Helixent 跑出来的 agent，定位问题、迭代 prompt 与行为。
- 一旦自用顺手再考虑产品化（加法），但 v1 不为此预留任何额外抽象。

## 2. 核心心智

**真实工具执行归 Helixent；Space 是一个"人 / 历史记录扮演所有工具"的确定性 ReAct 沙盘。**

典型工作流：

1. 在 **Helixent** 正常跑 agent，工具真实执行，产出一份 transcript（`Message[]`，已含真实 `tool_result`）。
2. 出问题时，把这份 transcript **导入 Space**（经共享目录，见 §7）。
3. 在 Space 里**复盘 / 迭代**：改 system prompt、改某条 `tool_result`、任意点分叉重跑、手写消息强制路径。
4. transcript 里录好的工具返回即天然 mock；模型走岔后产生的新工具调用，退化为手填。

> 结论：Space **永不真实执行工具**。要真跑就回 Helixent 跑。

## 3. 架构（关键：不使用 Helixent 的 `Agent`）

复用 Helixent 中"难重写、值得复用"的三样，其余自写：

| 复用 Helixent | Space 自己写 |
|---|---|
| `Model` + OpenAI/Anthropic `ModelProvider`（发消息、流式、跨厂商 tool-call 归一化） | 极薄 ReAct loop（自己掌控 `messages` 数组） |
| `Message` 类型（transcript 存读零转换） | `resolveToolResult(toolUse)` |
| 工具声明转 schema：`tool.parameters.toJSONSchema()` | `Bun.serve` HTTP/WS 服务 + React 前端 |

**为什么不用 `Agent`**：`Agent` 的价值在 `_act` 里真实执行工具 + 审批 / skills / todos 等中间件。既然所有工具结果都来自历史或手填，这些全不需要。Helixent 的 OpenAI provider 发工具给模型时也**只用 `name`/`description`/`parameters`，从不调用 `invoke`**（见 `src/community/openai/utils.ts` 的 `convertToOpenAITools`），所以工具只需"声明"，无需"实现"。

### 3.1 ReAct loop

```text
循环:
  assistant = await model.stream({ prompt, messages, tools })   // 流式推前端，追加到 messages
  toolUses = assistant 内容里的 tool_use
  若无 toolUse → 停，等下一条 user 消息
  对每个 toolUse:
      result = await resolveToolResult(toolUse)
      追加 tool_result 消息
  继续

resolveToolResult(toolUse):
  按 (name + 入参 JSON) 在导入 transcript 的已录返回里查找
    命中 → UI 提示「有历史返回，[用它] / [改]」
    未命中 → 等用户在 UI 手填
```

- 按 `tool_use.id` 匹配在重跑场景会失效（重跑产生新 id），故按 **name + 入参** 匹配。

## 4. thread 文件格式（自包含，workspace 里的 `.json`）

每个 `.json` 是一个完整可复现单元，内嵌跑这条所需的一切：

```json
{
  "model": { "name": "deepseek-v4-flash", "options": { "temperature": 1, "max_tokens": 2048 } },
  "prompt": "<identity>...</identity>",
  "tools": [
    { "name": "web_search", "description": "...", "parameters": { /* JSON schema */ } }
  ],
  "maxSteps": 50,
  "messages": [ /* Helixent Message[] 原样 */ ],
  "recordedResults": [
    { "name": "web_search", "input": { "query": "..." }, "result": "..." }
  ]
}
```

- `messages` **直接是 Helixent `Message[]`**，导入零转换、可原样塞回 loop。
- 工具声明内联为 JSON schema。喂 provider 时包一层 `{ toJSONSchema: () => parameters }` 即可，**不用 Zod**、`invoke` 留空函数（永不被调用）。
- `recordedResults` 是从导入 transcript 抽出的历史工具返回，供 `resolveToolResult` 匹配。

被否决：分离的「agent 定义文件 + transcript 文件」(B)、引用+覆盖的继承体系 (C)。自用阶段配置重复不是问题，等真的痛了再加。

## 5. 交互能力

- **任意点分叉重跑**（"从头重跑" = 分叉点 0，是其特例）：截断 `messages` 到分叉点 → 应用编辑 → 从该前缀继续 loop。
- **手动改写 / 插入 / 删除任意消息**，包括在 assistant 消息里塞结构化 `tool_use`，以强制构造上下文 / 路径。编辑器需支持往消息里加 `tool_use`，不止纯文本。
- 三栏布局：
  - 左：文件树（workspace + 共享 transcript 目录）。
  - 中：model + 采样参数 + tools + system prompt 编辑。
  - 右：transcript 与运行区；`tool_use` 结构化渲染、可填 mock、token / 耗时面板。

## 6. 服务端如何驱动

- **进程内 import**：Space 后端直接 `import` helixent 当依赖，构造 `Model` + provider，跑自写 loop，事件经 WebSocket 推前端。
- 不用子进程（无法暂停具体工具调用等手填）、不用内置 HTTP server 模式。

## 7. 交接：共享目录

- Helixent 端加一个 `afterAgentRun` 中间件（或 `/export` TUI 命令），运行结束把
  `{ model, prompt, tools(name/desc/schema), messages }` 写成 §4 的 schema，落到共享目录
  （如 `.helixent/transcripts/`）。
- Space 文件树**直接指向该目录**：每次真实运行自动作为一个 thread 出现，点开即调，**零粘贴**。
- **全程零改 Helixent 核心**：导出仅用公开 getter `agent.prompt` / `agent.tools` / `agent.messages` + `parameters.toJSONSchema()`。

被否决：手动粘贴 JSON (A，每次有摩擦)、CLI 手动导出 (C)、实时连接运行中的 Helixent (D，对事后 debug 过度设计)。

## 8. 实现默认（未逐项确认，可调整）

- 模型配置**复用 `~/.helixent/config.yaml`**，已配模型直接可选。
- 栈：后端 `Bun.serve`（HTTP + WS，import helixent）；前端 Vite + React + TypeScript；prompt / JSON 编辑用 CodeMirror；流式走 WS 实时渲染。

## 9. v1 范围

**做**：
- 共享目录读取 + thread 文件读写。
- 自写 ReAct loop + `resolveToolResult`（历史匹配 / 手填）。
- 三栏 UI、流式渲染、tool_use 结构化展示。
- 任意点分叉重跑、手动改写 / 插入消息。

**不做（v1 明确排除）**：
- 真实工具执行、MCP 客户端、`web_search` 等真实现（真实执行归 Helixent）。
- 工具注册表、skills、审批、todos 中间件。
- 鉴权 / 多租户 / 沙箱。
- 批量评测 / 回归（promptfoo 那套）——列为后续里程碑。

## 10. 待定 / 后续

- 分叉重跑时历史返回的匹配粒度（精确 name+args vs 模糊）细化。
- 是否需要「每条消息单独显示耗时 / 费用」——可在服务端 wrap stream 计时实现，不改核心。
- 工具声明在 UI 内的编辑 / 新增体验。
- 后续里程碑：批量评测 / 跨模型对比；引用 + 覆盖的 thread 复用。

---

## 附：参考的同类开源项目

- **Latitude**（`latitude-dev/latitude-llm`）— agent + prompt playground，最接近的交互范式。
- **promptfoo**（`promptfoo/promptfoo`）— 场景即文件、多模型、本地运行，文件化范式参考。
- **Langfuse**（`langfuse/langfuse`）— playground + prompt 管理 + trace 可视化。
