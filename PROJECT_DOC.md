# Helixent 项目文档

> **Helixent** — 一个基于 TypeScript + Bun 构建的 ReAct 风格智能编码代理框架

---

## 目录

- [项目概述](#项目概述)
- [技术栈](#技术栈)
- [架构设计](#架构设计)
- [目录结构](#目录结构)
- [核心模块详解](#核心模块详解)
- [中间件系统](#中间件系统)
- [工具系统](#工具系统)
- [技能系统](#技能系统)
- [权限与审批系统](#权限与审批系统)
- [API 参考](#api-参考)
- [快速上手](#快速上手)
- [构建与测试](#构建与测试)
- [依赖说明](#依赖说明)
- [设计模式与亮点](#设计模式与亮点)

---

## 项目概述

Helixent 是一个功能完整的**自主编码代理框架**，采用 ReAct（Reasoning + Acting）循环模式，让 LLM 能够理解需求、推理问题、执行工具（如 bash、文件操作）并迭代解决编程任务。

### 核心特性

| 特性 | 说明 |
|------|------|
| **ReAct 循环** | Think → Act → Observe 循环，直到任务完成或达到最大步数 |
| **模型无关** | 统一 `Model` 接口，支持 OpenAI、Anthropic 及兼容端点，可随时切换 |
| **流式输出** | `AsyncGenerator<AssistantMessage>` 实时生成快照，边思考边输出 |
| **并行工具执行** | 同一轮推理中的多个工具调用并行执行，结果按完成顺序返回 |
| **中间件架构** | 8 个生命周期钩子，灵活扩展代理行为 |
| **技能系统** | 支持从多个目录发现和加载 Agent Skills |
| **Todo 管理** | 内置结构化任务追踪，自动提醒 |
| **人机协作** | 敏感操作需人工审批，支持审批持久化 |
| **交互式 TUI** | 基于 Ink + React 的终端界面，支持流式渲染和命令补全 |

### 项目统计

| 指标 | 数值 |
|------|------|
| TypeScript 代码量 | ~6,300 行 |
| 内置工具数 | 11 个 |
| 中间件钩子数 | 8 个 |
| 测试文件数 | ~10 个 |
| npm 版本 | v1.3.1 |

---

## 技术栈

| 技术 | 用途 |
|------|------|
| **Bun** | 运行时环境，原生支持 TypeScript、高性能 I/O |
| **TypeScript (strict)** | 开发语言，严格模式全开 |
| **Zod v4** | Schema 验证、类型推断、JSON Schema 生成 |
| **React 19 + Ink 6** | 终端 UI 框架 |
| **Commander** | CLI 参数解析与路由 |
| **OpenAI SDK** | OpenAI API 客户端 |
| **Anthropic SDK** | Anthropic (Claude) API 客户端 |
| **YAML** | 配置文件解析 |

---

## 架构设计

Helixent 采用**分层架构**，依赖方向严格自上而下：

```
┌─────────────────────────────────────────────────┐
│              Layer 5: CLI / TUI                  │
│        (交互界面、命令管理、设置)                   │
├─────────────────────────────────────────────────┤
│   Layer 4: Community         Layer 3: Coding     │
│   (OpenAI/Anthropic 适配)    (编码代理 + 工具)     │
├─────────────────────────────────────────────────┤
│              Layer 2: Agent Loop                 │
│        (ReAct 循环、中间件、事件)                   │
├─────────────────────────────────────────────────┤
│              Layer 1: Foundation                 │
│        (消息、模型、工具 -- 零外部依赖)              │
└─────────────────────────────────────────────────┘
```

**依赖规则：**
- Foundation 不依赖任何上层
- Agent 仅依赖 Foundation
- Coding 依赖 Foundation（不依赖 Agent 内部实现）
- Community 为可选适配器，仅依赖 Foundation
- CLI 依赖所有层

---

## 目录结构

```
helixent/
├── index.ts                    # 入口文件
├── package.json                # 包配置 (v1.3.1)
├── tsconfig.json               # TypeScript 配置（strict, bundler 模式）
├── eslint.config.js            # ESLint 规则
├── bun.lock                    # Bun 锁文件
├── CLAUDE.md                   # 架构文档（给 AI 代理阅读）
├── AGENTS.md                   # 项目指导文件
├── README.md / README.zh.md    # 英文/中文说明
│
├── docs/
│   ├── bun.md                  # Bun 运行时指南
│   ├── code-convention.md      # 代码规范（102 条规则）
│   └── foundation.md           # 基础层文档
│
└── src/
    ├── foundation/             # Layer 1: 核心原语
    │   ├── messages/           #   消息类型系统
    │   │   └── types/          #   content.ts, message.ts, role.ts
    │   ├── models/             #   模型抽象
    │   │   ├── model.ts        #   Model 类
    │   │   ├── model-provider.ts   ModelProvider 接口
    │   │   └── model-context.ts    ModelContext 接口
    │   └── tools/              #   工具定义
    │       ├── function-tool.ts    FunctionTool 接口 + defineTool()
    │       └── structured-tool-result.ts
    │
    ├── agent/                  # Layer 2: ReAct 代理循环
    │   ├── agent.ts            #   Agent 核心类（362 行）
    │   ├── agent-event.ts      #   事件类型
    │   ├── agent-middleware.ts  #   中间件接口（8 个钩子）
    │   ├── tool-result-*.ts    #   工具结果处理
    │   ├── skills/             #   技能中间件
    │   ├── todos/              #   Todo 系统
    │   └── __tests__/          #   单元测试
    │
    ├── coding/                 # Layer 3: 编码代理
    │   ├── agents/
    │   │   └── lead-agent.ts   #   createCodingAgent()
    │   ├── tools/              #   11 个编码工具
    │   │   ├── bash.ts
    │   │   ├── read-file.ts
    │   │   ├── write-file.ts
    │   │   ├── str-replace.ts
    │   │   ├── apply-patch.ts
    │   │   ├── list-files.ts
    │   │   ├── glob-search.ts
    │   │   ├── grep-search.ts
    │   │   ├── file-info.ts
    │   │   ├── mkdir.ts
    │   │   └── move-path.ts
    │   └── permissions/        #   权限审批系统
    │
    ├── community/              # Layer 4: 社区适配器
    │   ├── openai/             #   OpenAI 适配（~310 行）
    │   └── anthropic/          #   Anthropic 适配（~300 行）
    │
    └── cli/                    # Layer 5: CLI / TUI
        ├── bootstrap/          #   启动与完整性检查
        ├── commands/           #   CLI 命令
        ├── config/             #   配置 schema
        ├── settings/           #   ~/.helixent/config.yaml 管理
        └── tui/                #   终端 UI
            ├── app.tsx
            ├── command-registry.ts
            ├── hooks/
            └── components/
```

---

## 核心模块详解

### Layer 1: Foundation（基础层）

#### 消息系统

采用**辨别联合类型**（Discriminated Unions）：

```typescript
type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage

// 五种内容类型
interface TextContent      { type: "text"; text: string }
interface ImageURLContent  { type: "image_url"; image_url: { url: string } }
interface ThinkingContent  { type: "thinking"; thinking: string }
interface ToolUseContent<T>{ type: "tool_use"; id: string; name: string; input: T }
interface ToolResultContent{ type: "tool_result"; tool_use_id: string; content: string }
```

#### 模型抽象

```typescript
interface ModelProvider {
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>
  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>
}

class Model {
  constructor(name: string, provider: ModelProvider, options?: Record<string, unknown>)
  invoke(context: ModelContext): Promise<AssistantMessage>
  stream(context: ModelContext): AsyncGenerator<AssistantMessage>
}
```

#### 工具定义

```typescript
interface FunctionTool<P extends ZodSchema, R> {
  name: string
  description: string
  parameters: P             // Zod Schema
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>
}

function defineTool<P, R>({ name, description, parameters, invoke }): FunctionTool<P, R>
```

---

### Layer 2: Agent Loop（代理循环层）

#### Agent 核心类

```typescript
class Agent {
  constructor(options: {
    model: Model
    prompt: string
    tools?: Tool[]
    middlewares?: AgentMiddleware[]
    maxSteps?: number
  })

  async *stream(message: UserMessage): AsyncGenerator<AgentEvent>
  abort(): void
}
```

**执行流程：**

```
用户消息 → beforeAgentRun()
         ↓
    ┌─── 循环 (step 1..maxSteps) ────┐
    │  beforeAgentStep()              │
    │  _think() → 调用模型，流式输出   │
    │  afterModel()                   │
    │  有 tool_use？                   │
    │   ├─ 否 → afterAgentRun() → 结束│
    │   └─ 是 → _act() 并行执行工具   │
    │  afterAgentStep()               │
    └─────── 继续下一步 ──────────────┘
```

#### 事件类型

```typescript
type AgentEvent =
  | { type: "message"; message: AssistantMessage | ToolMessage }
  | { type: "progress"; subtype: "thinking" | "tool" }
```

---

### Layer 3: Coding Agent（编码代理层）

```typescript
async function createCodingAgent(options: {
  model: Model
  cwd?: string
  skillsDirs?: string[]
  askUser?: (toolUse) => Promise<ApprovalDecision>
}): Promise<Agent>
```

#### 内置工具

| 工具名 | 功能 | 需审批 |
|--------|------|--------|
| `bash` | 执行 Shell 命令 | ✅ |
| `read_file` | 读取文件（支持行范围） | ❌ |
| `write_file` | 创建/覆盖文件 | ✅ |
| `str_replace` | 精确字符串替换 | ✅ |
| `apply_patch` | 应用 unified diff 补丁 | ✅ |
| `list_files` | 列出目录内容 | ❌ |
| `glob_search` | Glob 模式文件搜索 | ❌ |
| `grep_search` | 正则内容搜索（ripgrep） | ❌ |
| `file_info` | 获取文件元数据 | ❌ |
| `mkdir` | 创建目录 | ❌ |
| `move_path` | 移动/重命名 | ❌ |

---

### Layer 4: Community Providers

#### OpenAI

```typescript
class OpenAIModelProvider implements ModelProvider {
  constructor({ baseURL?: string, apiKey?: string })
}
```

#### Anthropic

```typescript
class AnthropicModelProvider implements ModelProvider {
  constructor({ baseURL?: string, apiKey?: string })
}
```

- System prompt 独立提取传递
- Thinking 模式自动设置 `budget_tokens`

---

### Layer 5: CLI / TUI

配置文件：`~/.helixent/config.yaml`

```bash
helixent                        # 启动交互式 TUI
helixent config model add       # 添加模型
helixent config model list      # 列出模型
helixent config model remove    # 删除模型
helixent config model set-default  # 设置默认
```

---

## 中间件系统

8 个生命周期钩子，按数组顺序顺序执行：

| 钩子 | 触发时机 | 能力 |
|------|---------|------|
| `beforeAgentRun` | 首步前 | 注入上下文 |
| `afterAgentRun` | 代理停止时 | 清理、总结 |
| `beforeAgentStep` | 每步开始 | 修改上下文 |
| `afterAgentStep` | 每步结束 | 记录、提醒 |
| `beforeModel` | 模型调用前 | 修改 prompt |
| `afterModel` | 模型响应后 | 后处理 |
| `beforeToolUse` | 工具执行前 | 审批、跳过 |
| `afterToolUse` | 工具完成后 | 记录结果 |

---

## 工具系统

### 自定义工具示例

```typescript
import { defineTool } from "helixent/foundation"
import { z } from "zod"

const myTool = defineTool({
  name: "my_tool",
  description: "A custom tool",
  parameters: z.object({ input: z.string() }),
  invoke: async ({ input }) => {
    return { ok: true, summary: `Done: ${input}`, data: { result: input } }
  },
})
```

### 工具结果策略

每个工具有独立的结果格式化策略，控制返回给模型的信息量：

```typescript
read_file:  { preferSummaryOnly: false, includeData: true, maxStringLength: 12000 }
list_files: { preferSummaryOnly: true,  includeData: false, maxStringLength: 1000 }
```

---

## 技能系统

### 发现路径

1. `~/.agents/skills/`
2. `~/.helixent/skills/`
3. `.agents/skills/`（项目级）
4. `.helixent/skills/`（项目级）

### 技能格式

```markdown
---
name: my-skill
description: Description
---
# Skill instructions...
```

---

## 权限与审批系统

需审批工具：`bash`、`write_file`、`str_replace`、`apply_patch`

通过 `beforeToolUse` 中间件钩子拦截，未批准时返回 `{ __skip: true, result }`。

---

## API 参考

```typescript
// Foundation
import { Model, ModelProvider } from "helixent/foundation"
import { Message, AssistantMessage } from "helixent/foundation"
import { FunctionTool, defineTool } from "helixent/foundation"

// Agent
import { Agent, AgentEvent, AgentMiddleware } from "helixent/agent"

// Coding
import { createCodingAgent } from "helixent/coding"

// Providers
import { OpenAIModelProvider } from "helixent/community/openai"
import { AnthropicModelProvider } from "helixent/community/anthropic"
```

---

## 快速上手

### 安装

```bash
npm install -g helixent
```

### 作为库使用

```typescript
import { createCodingAgent } from "helixent/coding"
import { OpenAIModelProvider } from "helixent/community/openai"
import { Model } from "helixent/foundation"

const provider = new OpenAIModelProvider({
  baseURL: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
})

const model = new Model("gpt-4o", provider, { max_tokens: 16384 })
const agent = await createCodingAgent({ model })

for await (const event of agent.stream({
  role: "user",
  content: [{ type: "text", text: "Create a hello world server" }],
})) {
  if (event.type === "message") {
    for (const c of event.message.content) {
      if (c.type === "text") console.info(c.text)
      if (c.type === "tool_use") console.info("🔧", c.name)
    }
  }
}
```

---

## 构建与测试

```bash
bun run dev          # 开发模式
bun run check        # 完整质量检查（tsc + eslint + test）
bun run build:bin    # 构建原生可执行文件
bun run build:js     # 构建 JS（支持 tree-shaking）
bun test             # 运行测试
```

---

## 依赖说明

### 生产依赖

| 包名 | 用途 |
|------|------|
| `@anthropic-ai/sdk` | Anthropic API |
| `openai` | OpenAI API |
| `commander` | CLI 解析 |
| `ink` + `react` | 终端 UI |
| `zod` | Schema 验证 |
| `yaml` | YAML 解析 |
| `gray-matter` | Frontmatter 提取 |

---

## 设计模式与亮点

1. **辨别联合类型** — 全框架 `role`/`type` 辨别符，类型安全窄化
2. **中间件组合优于继承** — Agent 通过可插拔中间件扩展，无继承层次
3. **流式快照模式** — 每次 yield 是完整消息，非差量补丁
4. **并行工具调度** — Promise.race 模式，结果按完成顺序发出
5. **Abort 信号全链路传递** — 单次 abort() 取消整个执行链
6. **Zod Schema 一体化** — 类型推断 + 运行时验证 + JSON Schema 生成
7. **工具结果策略** — 按工具名定制返回信息量，控制 token 消耗
8. **Todo 软提醒** — 超 10 步未使用时温和提醒

---

*文档生成日期：2026-05-06*
