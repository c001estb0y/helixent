# Helixent Agent Loop & Resume 机制源码精读

> 本文从源码角度，逐行解读 Helixent 的 **Agent Loop（ReAct 循环）** 与 **Session Resume（会话恢复）** 实现，同时穿插讲解涉及的 TypeScript 语法要点。

---

## 目录

1. [全局架构一览](#1-全局架构一览)
2. [Foundation 层：类型基础](#2-foundation-层类型基础)
   - 2.1 Message 类型体系
   - 2.2 Content 类型体系
   - 2.3 Model / ModelProvider / ModelContext
   - 2.4 Tool 抽象
3. [Agent Loop 核心实现](#3-agent-loop-核心实现)
   - 3.1 AgentContext 与 AgentOptions
   - 3.2 Agent 类构造
   - 3.3 `stream()` — ReAct 主循环
   - 3.4 `_think()` — 调用 LLM
   - 3.5 `_act()` — 并行执行工具
   - 3.6 `_deriveProgress()` — 流式进度事件
4. [AgentEvent 事件体系](#4-agentevent-事件体系)
5. [中间件系统](#5-中间件系统)
   - 5.1 AgentMiddleware 接口
   - 5.2 8 个生命周期钩子
   - 5.3 beforeToolUse 的特殊返回值
6. [Session 持久化：Transcript](#6-session-持久化transcript)
   - 6.1 transcript-storage.ts — 存储层
   - 6.2 transcript-middleware.ts — 写入中间件
7. [Resume 功能完整流程](#7-resume-功能完整流程)
   - 7.1 use-agent-loop.ts — React Hook
   - 7.2 resume-prompt.tsx — TUI 选择界面
   - 7.3 Resume 的完整时序
8. [TypeScript 语法速查表](#8-typescript-语法速查表)

---

## 1. 全局架构一览

```
用户输入 "/resume"
  │
  ▼
┌───────────────────────────────────────────────────┐
│  CLI 层 (use-agent-loop.ts)                       │
│  ├─ 解析命令 → resolveBuiltinCommand("resume")    │
│  ├─ listSessions() → 获取历史会话列表              │
│  └─ setResumeRequest(sessions) → 弹出选择菜单     │
│     │                                              │
│     ▼                                              │
│  ResumePrompt (resume-prompt.tsx)                  │
│  ├─ 用户用 ↑↓ 选择、Enter 确认                     │
│  └─ onSelect(session)                              │
│     │                                              │
│     ▼                                              │
│  handleResumeSelect(session)                       │
│  ├─ agent.clearMessages()                          │
│  ├─ loadTranscript(session.path) → 恢复消息        │
│  └─ setMessages([summary, ...lastTurn])            │
└───────────────────────────────────────────────────┘
          │
          │ 用户继续输入新 prompt
          ▼
┌───────────────────────────────────────────────────┐
│  Agent 层 (agent.ts)                              │
│  ┌────────────────────────────────────────┐       │
│  │  agent.stream(userMessage)             │       │
│  │  for step = 1..maxSteps:               │       │
│  │    1. beforeAgentStep(step)            │       │
│  │    2. _think() → 调用 LLM 获得回复     │       │
│  │    3. 提取 tool_use 列表               │       │
│  │    4. 无工具调用 → 结束                 │       │
│  │    5. _act(toolUses) → 并行执行工具    │       │
│  │    6. afterAgentStep(step)             │       │
│  └────────────────────────────────────────┘       │
│                                                    │
│  中间件链: [skills, todo, transcript, approval]    │
└───────────────────────────────────────────────────┘
          │
          ▼
┌───────────────────────────────────────────────────┐
│  Foundation 层                                    │
│  ├─ Model.stream(context) → 调用 LLM Provider    │
│  ├─ Message 类型 → 对话记录                       │
│  └─ Tool 定义 → 工具执行                          │
└───────────────────────────────────────────────────┘
```

---

## 2. Foundation 层：类型基础

### 2.1 Message 类型体系

> 文件：`src/foundation/messages/types/message.ts`

```typescript
// ─── TokenUsage：Token 用量统计 ───
export interface TokenUsage {
  promptTokens: number;       // 输入 token 数
  completionTokens: number;   // 输出 token 数
  totalTokens: number;        // 总 token 数
}
```

**TS 语法：`interface`**
- `interface` 定义一个对象的"形状"（shape），只存在于编译期，运行时被擦除
- 字段默认都是 required（必填），加 `?` 变成 optional

```typescript
// ─── 四种角色的消息 ───

export interface SystemMessage {
  role: "system";                    // ← 字面量类型(literal type)，只能是 "system"
  content: SystemMessageContent;     // TextContent[]
}

export interface UserMessage {
  role: "user";
  content: UserMessageContent;       // (TextContent | ImageURLContent)[]
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantMessageContent;  // (TextContent | ThinkingContent | ToolUseContent)[]
  usage?: TokenUsage;                // ← 可选属性(optional property)
  streaming?: boolean;               // 流式传输中为 true，完成后删除
}

export interface ToolMessage {
  role: "tool";
  content: ToolMessageContent;       // ToolResultContent[]
}
```

**TS 语法：字面量类型（Literal Type）**
```typescript
role: "system"  // 这不是"值为 system 的 string"，而是"类型就是 'system' 这个字符串"
// 类似枚举，但更轻量。TypeScript 看到 role === "system" 时能自动收窄(narrow)类型
```

```typescript
// ─── 联合类型(Union Type)：将多种消息组合 ───

export type NonSystemMessage = UserMessage | AssistantMessage | ToolMessage;
// 含义：NonSystemMessage 可以是上述三种之一

export type Message = SystemMessage | NonSystemMessage;
// 含义：Message 可以是任何一种消息
```

**TS 语法：`type` vs `interface`**
- `type` 可以定义联合类型、交叉类型等复杂类型，`interface` 只能定义对象形状
- `type NonSystemMessage = A | B | C` — 联合类型，用 `|` 表示"或"
- `interface` 支持 declaration merging（多次声明自动合并），`type` 不支持

### 2.2 Content 类型体系

> 文件：`src/foundation/messages/types/content.ts`

```typescript
// ─── 文本内容 ───
export interface TextContent {
  type: "text";
  text: string;
}

// ─── 图片 URL（多模态输入）───
export interface ImageURLContent {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "high" | "low";   // ← 联合字面量类型
  };
}

// ─── 思维链（模型推理过程）───
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

// ─── 工具调用（assistant 发起）───
export interface ToolUseContent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: "tool_use";
  id: string;         // 唯一 ID，用于和 ToolResultContent 关联
  name: string;       // 工具名
  input: T;           // 工具参数（JSON 对象）
}

// ─── 工具结果（tool 角色返回）───
export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;   // 对应 ToolUseContent.id
  content: string;       // 工具执行结果（通常是 JSON 字符串）
}
```

**TS 语法：泛型约束 `<T extends ...>`**
```typescript
// ToolUseContent<T extends Record<string, unknown> = Record<string, unknown>>
// 拆解：
//   T                               — 类型参数(泛型)
//   extends Record<string, unknown>  — 约束：T 必须是 { [key: string]: unknown } 的子类型
//   = Record<string, unknown>        — 默认值：如果不传 T，就用这个
//
// Record<string, unknown> 是内置工具类型，等价于 { [key: string]: unknown }
// unknown 是安全版的 any — 你可以把任何值赋给 unknown，但使用前必须做类型检查
```

```typescript
// ─── 各角色可用的 content 类型 ───
export type SystemMessageContent    = TextContent[];
export type UserMessageContent      = (TextContent | ImageURLContent)[];
export type AssistantMessageContent = (TextContent | ThinkingContent | ToolUseContent)[];
export type ToolMessageContent      = ToolResultContent[];
```

**设计要点**：`type` 在 `content` 字段上作为 **判别式（discriminant）**，允许 TypeScript 通过 `content.type === "tool_use"` 自动收窄到 `ToolUseContent`。

### 2.3 Model / ModelProvider / ModelContext

> 文件：`src/foundation/models/`

```typescript
// ─── ModelContext：模型调用的上下文 ───
// 文件：model-context.ts
export interface ModelContext {
  prompt: string;                // system prompt
  messages: NonSystemMessage[];  // 对话历史
  tools?: Tool[];                // 可用工具
  signal?: AbortSignal;          // 取消信号
}
```

**TS 语法：`AbortSignal`**
- 这是 Web API 标准（Bun/Node 都内置）
- 配合 `AbortController` 使用，用于取消异步操作
- `signal.throwIfAborted()` — 如果已取消则抛出异常

```typescript
// ─── ModelProvider：LLM 提供者接口 ───
// 文件：model-provider.ts
export interface ModelProviderInvokeParams {
  model: string;
  messages: Message[];               // 注意：包含 SystemMessage（由 Model 层拼接）
  tools?: Tool[];
  options?: Record<string, unknown>; // 提供者特定选项
  signal?: AbortSignal;
}

export interface ModelProvider {
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>;

  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>;
  //                                         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // AsyncGenerator：异步生成器，可以用 for await...of 遍历
  // 每次 yield 产出一个越来越完整的 AssistantMessage 快照
}
```

**TS 语法：`AsyncGenerator<T>`**
```typescript
// AsyncGenerator 是 async function* 的返回类型
// 完整签名：AsyncGenerator<YieldType, ReturnType, NextType>
// 这里只用了 YieldType = AssistantMessage

// 使用方式：
for await (const snapshot of provider.stream(params)) {
  // snapshot: AssistantMessage — 每次拿到一个渐进式快照
}
```

```typescript
// ─── Model：模型封装类 ───
// 文件：model.ts
export class Model {
  constructor(
    readonly name: string,              // ← 参数属性(parameter property)简写
    readonly provider: ModelProvider,
    readonly options?: Record<string, unknown>,
  ) {}

  invoke(context: ModelContext) { ... }
  stream(context: ModelContext) { ... }

  private _buildModelProviderParams(context: ModelContext): ModelProviderInvokeParams {
    const messages: Message[] = [];
    if (context.prompt) {
      // 将 system prompt 包装成 SystemMessage，放在最前面
      messages.push({ role: "system", content: [{ type: "text", text: context.prompt }] });
    }
    messages.push(...context.messages);  // 拼接对话历史
    return { model: this.name, options: this.options, messages, tools: context.tools, signal: context.signal };
  }
}
```

**TS 语法：参数属性（Parameter Property）**
```typescript
// 传统写法：
class Foo {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

// 参数属性简写（加 readonly / public / private / protected 修饰符）：
class Foo {
  constructor(readonly name: string) {}
  // 编译器自动生成 this.name = name
}
```

### 2.4 Tool 抽象

工具由 `foundation/tools` 定义，每个 Tool 需要：
- `name: string` — 工具名
- `description: string` — 供 LLM 理解的描述
- `parameters: ZodSchema` — 用 Zod 定义参数 schema
- `invoke(input, signal?)` — 执行函数

---

## 3. Agent Loop 核心实现

> 文件：`src/agent/agent.ts`（362 行）

### 3.1 AgentContext 与 AgentOptions

```typescript
export interface AgentContext {
  prompt: string;                        // system prompt
  messages: NonSystemMessage[];          // 对话记录
  tools?: Tool[];                        // 可用工具
  skills?: SkillFrontmatter[];           // 可用技能
  requestedSkillName?: string | null;    // 用户指定的技能
}

export interface AgentOptions {
  maxSteps?: number;     // 最大步数，防止无限循环
}
```

### 3.2 Agent 类构造

```typescript
export class Agent {
  // ─── 私有状态 ───
  private readonly _context: AgentContext;     // 内部上下文（外部通过 getter 访问）
  private _streaming = false;                  // 是否正在流式运行
  private _abortController: AbortController | null = null;  // 取消控制器

  // ─── 公开只读属性 ───
  readonly name?: string;
  readonly model: Model;
  readonly options: Required<AgentOptions>;    // ← Required<T> 把所有可选变必选
  readonly middlewares: AgentMiddleware[];

  constructor({
    name, model, prompt, messages = [], tools, middlewares = [], maxSteps = 100,
  }: {                           // ← 解构参数 + 内联类型声明
    name?: string;
    model: Model;
    prompt: string;
    messages?: NonSystemMessage[];
    tools?: Tool[];
    middlewares?: AgentMiddleware[];
    maxSteps?: number;
  }) {
    this.name = name;
    this.model = model;
    this._context = { prompt, tools, messages };
    this.middlewares = middlewares;
    this.options = { maxSteps };      // maxSteps 有默认值 100，所以可以满足 Required
  }
```

**TS 语法：`Required<T>`**
```typescript
// Required<T> 是内置工具类型
// 将 T 的所有可选属性变为必选
// AgentOptions = { maxSteps?: number }
// Required<AgentOptions> = { maxSteps: number }  ← 不再可选
```

**TS 语法：解构参数 + 内联类型**
```typescript
// 普通写法：
function foo(opts: { a: string; b?: number }) { ... }

// 等价于解构写法：
function foo({ a, b = 0 }: { a: string; b?: number }) { ... }

// Agent 的构造函数用了同样的模式，参数是一个对象，直接解构取出各字段
```

```typescript
  // ─── getter / setter ───
  get messages() { return this._context.messages; }

  get prompt() { return this._context.prompt; }
  set prompt(prompt: string) { this._context.prompt = prompt; }

  get tools() { return this._context.tools; }
  get streaming() { return this._streaming; }

  // ─── 清空消息 ───
  clearMessages() {
    this._context.messages.length = 0;
    // 技巧：直接设 .length = 0 会清空数组，但保留引用
    // 这样所有持有该数组引用的地方都会看到空数组
    // 比 this._context.messages = [] 更好，后者会断开引用
  }
```

**TS 语法：getter / setter**
```typescript
// get propertyName() — 定义访问器属性
// 外部调用：agent.messages（不加括号，像属性一样）
// 内部实际执行 get messages() 函数体
```

### 3.3 `stream()` — ReAct 主循环

这是整个 Agent 最核心的方法：

```typescript
  async *stream(message: UserMessage): AsyncGenerator<AgentEvent> {
  // ^^^^^^^^
  // async *  = 异步生成器函数
  // 可以同时 await（等异步）和 yield（产出值）
  // 返回类型是 AsyncGenerator<AgentEvent>

    // 防止重入
    if (this._streaming) {
      throw new Error("Agent is already streaming");
    }

    // 初始化取消控制器
    this._abortController = new AbortController();

    // 将用户消息追加到对话历史
    this._appendMessage(message);

    // ─── 钩子：运行开始前 ───
    await this._beforeAgentRun();

    this._streaming = true;
    try {
      // ═══════════════════════════════════════════
      // 核心 ReAct 循环：最多执行 maxSteps 步
      // ═══════════════════════════════════════════
      for (let step = 1; step <= this.options.maxSteps; step++) {

        // 检查是否已被取消
        this._abortController.signal.throwIfAborted();

        // ─── 钩子：每步开始前 ───
        await this._beforeAgentStep(step);

        // ═══ THINK：调用 LLM，获取 assistant 回复 ═══
        const assistantMessage = yield* this._think();
        //                       ^^^^^^
        // yield* 是"委托"语法 — 将 _think() 这个子生成器的所有 yield 值
        // 直接"透传"给外层的消费者。同时，_think() 的 return 值
        // 成为 yield* 表达式的值（赋给 assistantMessage）

        // ─── 钩子：模型返回后 ───
        await this._afterModel(assistantMessage);

        // 向外产出完整的 assistant 消息事件
        yield { type: "message", message: assistantMessage };

        // ═══ 判断：是否有工具调用？ ═══
        const toolUses = this._extractToolUses(assistantMessage);
        if (toolUses.length === 0) {
          // 没有工具调用 → LLM 给出了最终回答 → 循环结束
          await this._afterAgentRun();
          return;    // 结束生成器
        }

        // ═══ ACT：并行执行所有工具 ═══
        yield* this._act(toolUses);
        // 同样用 yield* 透传 _act() 的事件

        // ─── 钩子：每步结束后 ───
        await this._afterAgentStep(step);

        // 回到循环顶部 → 进入下一步的 THINK
      }

      // 超过最大步数
      throw new Error("Maximum number of steps reached");

    } finally {
      // 无论正常结束还是异常，都清理状态
      this._streaming = false;
      this._abortController = null;
    }
  }
```

**TS 语法：`async *` 和 `yield*`**
```typescript
// async function*  — 异步生成器函数
// 结合了两种能力：
//   1. async → 可以 await 异步操作
//   2. function* → 可以 yield 值给消费者

// yield* subGenerator()  — 委托(delegation)
// 效果：subGenerator 的每个 yield 值都"穿透"到外层
// 同时 subGenerator 的 return 值变成 yield* 表达式的值

// 示例：
async function* outer(): AsyncGenerator<number, void> {
  const returnValue = yield* inner();  // inner 的 yield 值直接穿到 outer 的消费者
  console.log(returnValue);            // inner 的 return 值
}

async function* inner(): AsyncGenerator<number, string> {
  yield 1;
  yield 2;
  return "done";   // ← 这个值成为 yield* 表达式的值
}

// 消费者看到的：1, 2（return 值不会被 yield 出去）
```

**ReAct 模式图解**：
```
step 1: THINK → assistant 说 "我需要读取文件" + tool_use(read_file)
        ACT   → 执行 read_file → 得到文件内容 → 追加 tool_result

step 2: THINK → assistant 看到文件内容，说 "我需要修改第 10 行" + tool_use(str_replace)
        ACT   → 执行 str_replace → 追加 tool_result

step 3: THINK → assistant 看到修改成功，说 "已完成修改"（无 tool_use）
        → 循环结束 ✓
```

### 3.4 `_think()` — 调用 LLM

```typescript
  private async *_think(): AsyncGenerator<AgentEvent, AssistantMessage> {
  //                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // AsyncGenerator<YieldType, ReturnType>
  //   YieldType = AgentEvent     — yield 出去的值类型
  //   ReturnType = AssistantMessage — return 的值类型（给 yield* 表达式）

    // 构建模型调用上下文
    const modelContext: ModelContext = {
      prompt: this.prompt,
      messages: this.messages,
      tools: this.tools,
      signal: this._abortController?.signal,
      //                             ^
      // ?. 可选链(optional chaining)
      // 如果 _abortController 是 null/undefined，整个表达式返回 undefined
      // 而不是抛出 TypeError
    };

    // ─── 钩子：模型调用前（中间件可以修改 modelContext）───
    await this._beforeModel(modelContext);

    // 流式调用 LLM
    let latest: AssistantMessage | null = null;
    for await (const snapshot of this.model.stream(modelContext)) {
      // model.stream() 是一个 AsyncGenerator
      // 每次 yield 一个"渐进快照" — 越来越完整的 AssistantMessage
      latest = snapshot;
      if (snapshot.streaming) {
        // 还在流式中 → 产出进度事件（thinking 或 tool 进度）
        yield this._deriveProgress(snapshot);
      }
    }

    if (!latest) {
      throw new Error("Model stream ended without producing a message");
    }

    // 确保最终消息不再标记为 streaming
    if (latest.streaming) {
      delete latest.streaming;
      // delete 操作符：删除对象属性
      // 这里删除 streaming 字段，等价于 latest.streaming = undefined 但更干净
    }

    // 将 assistant 消息追加到对话历史
    this._appendMessage(latest);

    return latest;
    // return 值 → 被 yield* 表达式接收
    // 即 stream() 中的：const assistantMessage = yield* this._think();
  }
```

### 3.5 `_act()` — 并行执行工具

```typescript
  private async *_act(toolUses: ToolUseContent[]): AsyncGenerator<AgentEvent> {
    const signal = this._abortController?.signal;

    // ═══ 步骤 1：启动所有工具的并行执行 ═══
    const pending = toolUses.map(async (toolUse, index) => {
      // .map() 对每个 toolUse 启动一个 async 函数（立即开始执行）
      // 返回 Promise 数组 — 所有工具同时运行
      try {
        const tool = this.tools?.find((t) => t.name === toolUse.name);
        if (!tool) throw new Error(`Tool ${toolUse.name} not found`);

        // ─── 钩子：工具执行前 ───
        const beforeResult = await this._beforeToolUse(toolUse);
        if (beforeResult.skip) {
          // 中间件说"跳过这个工具"（例如：权限拒绝）
          return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: beforeResult.result };
        }

        // 实际调用工具
        const result = await tool.invoke(toolUse.input, signal);

        // ─── 钩子：工具执行后 ───
        await this._afterToolUse(toolUse, result);
        return { index, toolUseId: toolUse.id, toolName: toolUse.name, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: `Error: ${message}` };
      }
    });

    // ═══ 步骤 2：构建取消 Promise（如果有 signal）═══
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
      //            ^^^^^^
      // Promise<never> — 永远不会 resolve，只会 reject
      // never 类型表示"这个值不可能存在"
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
      : null;

    // ═══ 步骤 3：逐个收集完成的工具结果（谁先完成谁先处理）═══
    const remaining = new Set(pending.map((_, i) => i));
    //                    ^^^
    // Set<number> — 跟踪还未完成的索引

    while (remaining.size > 0) {
      const candidates = [...remaining].map((i) => pending[i]);
      //                  ^^^^^^^^^^^^^
      // Set 转 Array（展开语法）

      const resolved = (await (abortPromise
        ? Promise.race([...candidates, abortPromise])
        : Promise.race(candidates)))!;
      //                            ^
      // ! 非空断言(non-null assertion) — 告诉 TS "我确定这不是 null/undefined"
      // Promise.race 返回最先 settle 的 Promise 结果

      remaining.delete(resolved.index);

      // 构建 ToolMessage
      const toolMessage: ToolMessage = {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: resolved.toolUseId,
            content: formatToolResultForMessage({
              toolName: resolved.toolName,
              result: resolved.result,
            }),
          },
        ],
      };

      // 追加到对话历史 & 产出事件
      this._appendMessage(toolMessage);
      yield { type: "message", message: toolMessage };
    }
  }
```

**并行执行 + 逐个收集的模式图解**：
```
toolUses = [bash, read_file, grep_search]

step 1: 同时启动三个 Promise
  pending = [Promise<bash>, Promise<read_file>, Promise<grep_search>]

step 2: Promise.race → grep_search 最先完成
  → yield ToolMessage(grep_search result)
  → remaining = {0, 1}

step 3: Promise.race → read_file 完成
  → yield ToolMessage(read_file result)
  → remaining = {0}

step 4: Promise.race → bash 完成
  → yield ToolMessage(bash result)
  → remaining = {} → 退出循环
```

### 3.6 `_deriveProgress()` — 流式进度事件

```typescript
  private _deriveProgress(snapshot: AssistantMessage): AgentEvent {
    const toolUses = snapshot.content.filter(
      (c): c is ToolUseContent => c.type === "tool_use",
      //   ^^^^^^^^^^^^^^^^^^
      // 类型谓词(type predicate)
      // 告诉 TS：当这个函数返回 true 时，c 的类型是 ToolUseContent
      // 这样 filter 的返回类型变成 ToolUseContent[]（而非 (TextContent | ...)[]）
    );

    if (toolUses.length === 0) {
      return { type: "progress", subtype: "thinking" };
    }

    const last = toolUses[toolUses.length - 1]!;
    return { type: "progress", subtype: "tool", name: last.name, input: last.input };
  }
```

**TS 语法：类型谓词（Type Predicate）**
```typescript
// 语法：paramName is Type
// 用在 filter/find 等回调中，帮助 TS 收窄类型

// 没有类型谓词：
const items = arr.filter(x => x.type === "tool_use");
// items 的类型仍是 (TextContent | ThinkingContent | ToolUseContent)[]

// 有类型谓词：
const items = arr.filter((x): x is ToolUseContent => x.type === "tool_use");
// items 的类型是 ToolUseContent[] ✓
```

---

## 4. AgentEvent 事件体系

> 文件：`src/agent/agent-event.ts`

```typescript
// ─── 事件类型定义 ───

// 完整消息事件（assistant 回复或 tool 结果）
export interface AgentMessageEvent {
  type: "message";
  message: AssistantMessage | ToolMessage;
}

// 进度事件 — 正在思考
export interface AgentProgressThinkingEvent {
  type: "progress";
  subtype: "thinking";
}

// 进度事件 — 正在生成工具调用
export interface AgentProgressToolEvent {
  type: "progress";
  subtype: "tool";
  name: string;      // 工具名
  input: unknown;    // 可能是不完整的 JSON（流式中）
}

// ─── 联合类型 ───
export type AgentProgressEvent = AgentProgressThinkingEvent | AgentProgressToolEvent;
export type AgentEvent = AgentMessageEvent | AgentProgressEvent;
```

**判别式联合（Discriminated Union）**：
```typescript
// 所有事件都有 type 字段作为判别式
// TS 可以通过 type 值自动收窄：

function handleEvent(event: AgentEvent) {
  if (event.type === "message") {
    // TS 自动知道 event 是 AgentMessageEvent
    console.log(event.message);   // ✓ 安全访问
  } else if (event.subtype === "tool") {
    // TS 自动知道 event 是 AgentProgressToolEvent
    console.log(event.name);      // ✓ 安全访问
  }
}
```

---

## 5. 中间件系统

> 文件：`src/agent/agent-middleware.ts`

### 5.1 AgentMiddleware 接口

```typescript
export interface AgentMiddleware {
  beforeModel?:     (params: BeforeModelParams)     => Promise<Partial<ModelContext> | null | undefined | void>;
  afterModel?:      (params: AfterModelParams)      => Promise<Partial<AssistantMessage> | null | undefined | void>;
  beforeAgentRun?:  (params: BeforeAgentRunParams)   => Promise<Partial<AgentContext> | null | undefined | void>;
  afterAgentRun?:   (params: AfterAgentRunParams)    => Promise<Partial<AgentContext> | null | undefined | void>;
  beforeAgentStep?: (params: BeforeAgentStepParams)  => Promise<Partial<AgentContext> | null | undefined | void>;
  afterAgentStep?:  (params: AfterAgentStepParams)   => Promise<Partial<AgentContext> | null | undefined | void>;
  beforeToolUse?:   (params: BeforeToolUseParams)    => Promise<BeforeToolUseResult>;
  afterToolUse?:    (params: AfterToolUseParams)     => Promise<Partial<AgentContext> | null | undefined | void>;
}
```

**TS 语法：`Partial<T>`**
```typescript
// Partial<T> 将 T 的所有属性变为可选
// Partial<AgentContext> = {
//   prompt?: string;
//   messages?: NonSystemMessage[];
//   tools?: Tool[];
//   skills?: SkillFrontmatter[];
//   requestedSkillName?: string | null;
// }
// 中间件只需要返回想修改的字段，其余保持不变
```

**TS 语法：`null | undefined | void`**
```typescript
// 三种"空值"：
// null       — 明确的"没有值"
// undefined  — 未赋值 / 函数没有 return
// void       — 函数的返回类型声明"我不关心返回值"

// 这里三者都允许 → 中间件可以返回 null、不返回、或返回修改对象
```

### 5.2 8 个生命周期钩子

```
beforeAgentRun    ── 用户消息入队后、第一步开始前
  │
  ├── beforeAgentStep(step=1) ── 每步开始
  │   ├── beforeModel      ── LLM 调用前（可修改 prompt/tools）
  │   ├── [LLM 调用]
  │   ├── afterModel       ── LLM 返回后（可修改回复）
  │   ├── beforeToolUse    ── 每个工具执行前（可跳过）
  │   ├── [工具执行]
  │   ├── afterToolUse     ── 每个工具执行后
  │   └── afterAgentStep(step=1) ── 每步结束
  │
  ├── beforeAgentStep(step=2) ...
  │   └── ...
  │
afterAgentRun     ── 无工具调用时（正常结束）
```

### 5.3 beforeToolUse 的特殊返回值

```typescript
export type BeforeToolUseResult =
  | Partial<AgentContext>                              // 正常：修改上下文
  | { readonly __skip: true; readonly result: unknown } // 跳过：不执行工具，用 result 代替
  | null | undefined | void;                           // 无操作

// Agent 中的处理逻辑：
private async _beforeToolUse(toolUse: ToolUseContent): Promise<{ skip: boolean; result?: unknown }> {
  for (const middleware of this.middlewares) {
    if (!middleware.beforeToolUse) continue;
    const result = await middleware.beforeToolUse({ agentContext: this._context, toolUse });
    if (result && typeof result === "object" && "__skip" in result) {
      //                                        ^^^^^^^^^^^^^^^^
      // in 操作符：检查属性是否存在于对象中
      // 这里做了三重检查：truthy + 是对象 + 含 __skip 属性
      return { skip: true, result: result.result };
    }
    if (result) {
      Object.assign(this._context, result);
    }
  }
  return { skip: false };
}
```

中间件执行模式（所有钩子通用）：
```typescript
// 遍历所有中间件 → 依次执行 → 结果 merge 到共享上下文
for (const middleware of this.middlewares) {
  if (!middleware.hookName) continue;                // 该中间件没有实现此钩子 → 跳过
  const result = await middleware.hookName(params);
  if (result) {
    Object.assign(context, result);                  // 浅合并到共享对象
  }
}
```

---

## 6. Session 持久化：Transcript

### 6.1 transcript-storage.ts — 存储层

> 文件：`src/agent/transcript/transcript-storage.ts`

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
//       ^^^^^^^^^^^^^^^
// Bun/Node 的 fs 同步 API
// appendFileSync — 追加写入（不会覆盖已有内容）
// existsSync — 检查文件/目录是否存在

// ─── 路径安全化：将 CWD 中的路径分隔符替换为 - ───
export function sanitizeCwd(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, "-");
  // 例如：E:\Github\helixent → E-Github-helixent
}

// ─── 获取项目的 transcript 目录 ───
export function getProjectDir(cwd: string): string {
  return join(homedir(), ".helixent", "projects", sanitizeCwd(cwd));
  // 例如：~/.helixent/projects/E-Github-helixent-helixent/
}

// ─── 追加一条消息到 JSONL 文件 ───
export function appendEntry(filePath: string, message: NonSystemMessage): void {
  const entry = {
    type: message.role,                   // "user" | "assistant" | "tool"
    timestamp: new Date().toISOString(),  // ISO 8601 时间戳
    message,                              // 完整消息对象
  };
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    //              ^^^^^^^^^^^^^^^^^
    // recursive: true — 递归创建（类似 mkdir -p）
    // mode: 0o700 — 只有 owner 有权限（rwx------）
    // 0o 是八进制前缀
  }
  appendFileSync(filePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
  //             ^^^^^^^^^
  // 追加一行 JSON + 换行符
  // mode: 0o600 — owner 读写权限（rw-------）
}
```

**JSONL 格式示例**：
```json
{"type":"user","timestamp":"2026-05-11T08:30:00.000Z","message":{"role":"user","content":[{"type":"text","text":"help me fix bug"}]}}
{"type":"assistant","timestamp":"2026-05-11T08:30:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"I'll look into it."},{"type":"tool_use","id":"call_1","name":"read_file","input":{"path":"src/main.ts"}}],"usage":{"promptTokens":150,"completionTokens":50,"totalTokens":200}}}
{"type":"tool","timestamp":"2026-05-11T08:30:06.000Z","message":{"role":"tool","content":[{"type":"tool_result","tool_use_id":"call_1","content":"...file contents..."}]}}
```

```typescript
// ─── SessionInfo：会话元信息 ───
export type SessionInfo = {
  id: string;           // UUID（文件名去掉 .jsonl）
  path: string;         // 完整文件路径
  mtime: Date;          // 最后修改时间
  messageCount: number; // 消息行数
};

// ─── 列出项目的所有会话 ───
export function listSessions(projectDir: string, limit = 5): SessionInfo[] {
  if (!existsSync(projectDir)) return [];

  return readdirSync(projectDir)
    .filter((f) => f.endsWith(".jsonl"))       // 只要 .jsonl 文件
    .map((f) => {
      const filePath = join(projectDir, f);
      const stat = statSync(filePath);
      const content = readFileSync(filePath, "utf-8");
      const lineCount = content.split("\n").filter(Boolean).length;
      //                                   ^^^^^^^^^^^^^^^
      // filter(Boolean) — 过滤掉空字符串（最后一个 \n 后的空行）
      // Boolean 作为函数：Boolean("") → false, Boolean("abc") → true
      return {
        id: f.replace(".jsonl", ""),
        path: filePath,
        mtime: stat.mtime,
        messageCount: lineCount,
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())  // 按时间倒序
    .slice(0, limit);                                          // 取前 limit 条
}

// ─── 从 JSONL 文件加载所有消息 ───
export function loadTranscript(filePath: string): NonSystemMessage[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).message as NonSystemMessage);
    //                                      ^^^^^^^^^^^^^^^^^^^^^
    // as NonSystemMessage — 类型断言(type assertion)
    // 告诉 TS "我知道 JSON.parse 返回的 .message 是 NonSystemMessage 类型"
    // 这是不安全的（运行时不检查），但 JSONL 是我们自己写的，格式可信
}
```

### 6.2 transcript-middleware.ts — 写入中间件

> 文件：`src/agent/transcript/transcript-middleware.ts`

```typescript
export function createTranscriptMiddleware(options: {
  cwd: string;
  projectDir?: string;
}): AgentMiddleware {
  // ─── 闭包变量：跨钩子共享状态 ───
  let transcriptPath: string;    // 当前会话的 JSONL 文件路径
  let lastWrittenIndex = 0;      // 已写入的消息索引（防重复写入）

  return {
    // ─── 运行开始前：创建新的 JSONL 文件 ───
    beforeAgentRun: async ({ agentContext }) => {
      const sessionId = randomUUID();   // 生成唯一 ID
      const dir = options.projectDir ?? getProjectDir(options.cwd);
      //                              ^^
      // ?? 空值合并(nullish coalescing)
      // 左边是 null/undefined 时用右边的值
      // 注意：和 || 的区别 — || 在左边为 falsy（0, "", false）时也用右边
      // ?? 只在 null/undefined 时用右边

      transcriptPath = join(dir, `${sessionId}.jsonl`);

      // 写入已有的消息（可能是 resume 恢复的）
      for (const msg of agentContext.messages) {
        appendEntry(transcriptPath, msg);
      }
      lastWrittenIndex = agentContext.messages.length;
      return null;   // 不修改上下文
    },

    // ─── 每步结束后：追加新消息 ───
    afterAgentStep: async ({ agentContext }) => {
      const newMessages = agentContext.messages.slice(lastWrittenIndex);
      //                                       ^^^^^
      // Array.slice(startIndex) — 从 startIndex 到末尾的子数组
      // 只取新增的消息，避免重复写入

      for (const msg of newMessages) {
        appendEntry(transcriptPath, msg);
      }
      lastWrittenIndex = agentContext.messages.length;
      return null;
    },
  };
}
```

**核心设计**：
- **Append-only**：只追加，不修改已有内容
- **去重**：通过 `lastWrittenIndex` 追踪写入位置
- **闭包**：`transcriptPath` 和 `lastWrittenIndex` 在 `createTranscriptMiddleware` 的闭包中共享

---

## 7. Resume 功能完整流程

### 7.1 use-agent-loop.ts — React Hook

> 文件：`src/cli/tui/hooks/use-agent-loop.ts`

**状态管理**：

```typescript
export function AgentLoopProvider({ agent, commands = [], children }: { ... }) {
  const [streaming, setStreaming]       = useState(false);
  const [messages, setMessages]         = useState<NonSystemMessage[]>([]);
  const [resumeRequest, setResumeRequest] = useState<SessionInfo[] | null>(null);
  //     ^^^^^^^^^^^^^
  // 当不为 null 时，表示用户触发了 /resume，需要显示选择菜单
```

**Resume 触发**：

```typescript
  if (invocation?.name === "resume") {
    const sessions = listSessions(getProjectDir(process.cwd()));
    if (sessions.length === 0) {
      // 没有历史会话 → 显示提示消息
      const noSessionMsg: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "No previous sessions found." }],
      };
      setMessages((prev) => [...prev, noSessionMsg]);
    } else {
      // 有历史会话 → 触发选择菜单
      setResumeRequest(sessions);
    }
    return;
  }
```

**Resume 选择处理**：

```typescript
  const handleResumeSelect = useCallback(
    (session: SessionInfo | null) => {
      setResumeRequest(null);              // 1. 关闭选择菜单
      if (!session) return;                // 2. 用户取消

      agent.clearMessages();               // 3. 清空 agent 的对话历史
      const restored = loadTranscript(session.path);  // 4. 从 JSONL 加载消息
      for (const msg of restored) {
        agent.messages.push(msg);          // 5. 逐条恢复到 agent
      }

      flushPendingMessages();              // 6. 清空待渲染队列

      // 7. 构建摘要消息 + 最近一轮对话
      const summaryMsg: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `Resumed session with ${restored.length} messages.` }],
      };
      const recentMessages = getLastCompleteTurn(restored);
      setMessages([summaryMsg, ...recentMessages]);
      // UI 显示：摘要 + 上次最后一轮的对话
    },
    [agent, flushPendingMessages],   // ← useCallback 依赖项
  );
```

**TS 语法：`useCallback`**
```typescript
// React Hook：缓存回调函数的引用
// useCallback(fn, deps) — 只有 deps 变化时才创建新的函数实例
// 避免子组件因为父组件重渲染而不必要地重渲染

// [agent, flushPendingMessages] — 依赖项数组
// 只有当 agent 或 flushPendingMessages 变化时，handleResumeSelect 才会重建
```

**获取最后一轮对话**：

```typescript
function getLastCompleteTurn(messages: NonSystemMessage[]): NonSystemMessage[] {
  // 从后往前找最后一条 user 消息
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      //            ^
      // ! 非空断言 — 告诉 TS "messages[i] 不是 undefined"
      // 因为 i 在 0..length-1 范围内，所以确实不会越界
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx === -1) return messages.slice(-2);
  // 找不到 user 消息 → 返回最后 2 条

  // 返回最后一个 user 消息及其后的所有回复
  return messages.slice(lastUserIdx);
}
```

**消息入队的批量优化**：

```typescript
  // 50ms 节流：避免每条 tool_result 都触发 React 重渲染
  const enqueueMessage = useCallback(
    (message: NonSystemMessage) => {
      pendingMessagesRef.current.push(message);  // 先放入 ref 缓冲区
      if (flushTimerRef.current) return;         // 已有定时器在等

      flushTimerRef.current = setTimeout(() => {
        flushPendingMessages();                  // 50ms 后批量刷新
      }, 50);
    },
    [flushPendingMessages],
  );
```

### 7.2 resume-prompt.tsx — TUI 选择界面

> 文件：`src/cli/tui/components/resume-prompt.tsx`

```typescript
export function ResumePrompt({
  sessions,
  onSelect,
}: {
  sessions: SessionInfo[];
  onSelect: (session: SessionInfo | null) => void;
  //         ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  // 回调签名：传 session 表示选中，传 null 表示取消
}) {
  // 构建选项列表：会话列表 + [Cancel]
  const options = useMemo(
    () => [
      ...sessions.map((s) => ({ type: "session" as const, session: s })),
      //                        ^^^^^^^^^^^^^^^^^^^
      // as const — const 断言
      // 让 type 的类型从 string 收窄为字面量 "session"
      // 这对后面的 if (selected.type === "cancel") 判别很重要
      { type: "cancel" as const },
    ],
    [sessions],
  );

  const [index, setIndex] = useState(0);   // 当前高亮的选项索引

  // 键盘输入处理（ink 的 useInput hook）
  useInput((_input, key) => {
    if (key.upArrow) {
      setIndex((i) => (i > 0 ? i - 1 : options.length - 1));  // 上移（循环）
      return;
    }
    if (key.downArrow) {
      setIndex((i) => (i < options.length - 1 ? i + 1 : 0));  // 下移（循环）
      return;
    }
    if (key.return) {                      // Enter 确认
      const selected = options[index]!;
      if (selected.type === "cancel") {
        onSelect(null);
      } else {
        onSelect(selected.session);
      }
      return;
    }
    if (key.escape) {                      // Esc 取消
      onSelect(null);
    }
  });

  // ─── 渲染 ───
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>Resume a previous session:</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((opt, i) => {
          const marker = i === index ? ">" : " ";       // 选中标记
          const color = i === index ? "cyan" : undefined; // 高亮颜色
          if (opt.type === "cancel") {
            return <Text key="cancel" color={color}>{marker} [Cancel]</Text>;
          }
          return (
            <Text key={opt.session.id} color={color}>
              {marker} {formatDate(opt.session.mtime)} ({opt.session.messageCount} messages)
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Up/Down to move, Enter to select, Esc to cancel</Text>
      </Box>
    </Box>
  );
}
```

### 7.3 Resume 的完整时序

```
用户                   CLI 层                    Agent 层               存储层
 │                      │                         │                      │
 │── "/resume" ────────►│                         │                      │
 │                      │── listSessions() ──────────────────────────────►│
 │                      │◄─ SessionInfo[] ───────────────────────────────│
 │                      │                         │                      │
 │◄── ResumePrompt ────│                         │                      │
 │    显示会话列表       │                         │                      │
 │                      │                         │                      │
 │── 选择会话 ─────────►│                         │                      │
 │                      │── clearMessages() ─────►│                      │
 │                      │── loadTranscript() ────────────────────────────►│
 │                      │◄─ NonSystemMessage[] ─────────────────────────│
 │                      │── messages.push() ─────►│                      │
 │                      │   (恢复所有消息)         │                      │
 │                      │                         │                      │
 │◄── 显示摘要 ─────────│                         │                      │
 │    + 上次最后一轮     │                         │                      │
 │                      │                         │                      │
 │── 新的 prompt ──────►│                         │                      │
 │                      │── stream(userMsg) ─────►│                      │
 │                      │                         │── beforeAgentRun ────►│
 │                      │                         │   (创建新 .jsonl)     │
 │                      │                         │── _think() ──►[LLM]  │
 │                      │                         │── _act()             │
 │                      │                         │── afterAgentStep ───►│
 │                      │                         │   (追加新消息)        │
```

---

## 8. TypeScript 语法速查表

本文涉及的所有 TS 语法，汇总如下：

### 类型系统基础

| 语法 | 示例 | 说明 |
|------|------|------|
| `interface` | `interface Foo { a: string }` | 定义对象形状，编译期擦除 |
| `type` | `type Foo = A \| B` | 类型别名，可定义联合/交叉等复杂类型 |
| 可选属性 `?` | `name?: string` | 可以是 `string \| undefined` |
| 字面量类型 | `role: "user"` | 值只能是 `"user"` |
| 联合类型 `\|` | `string \| number` | 可以是其中任一种 |

### 泛型与工具类型

| 语法 | 示例 | 说明 |
|------|------|------|
| 泛型 | `<T>` | 类型参数 |
| 泛型约束 | `<T extends Foo>` | T 必须是 Foo 的子类型 |
| 泛型默认值 | `<T = string>` | 不传 T 时用 string |
| `Partial<T>` | `Partial<AgentContext>` | 所有属性变可选 |
| `Required<T>` | `Required<AgentOptions>` | 所有属性变必选 |
| `Record<K, V>` | `Record<string, unknown>` | `{ [key: string]: unknown }` |

### 类型收窄与断言

| 语法 | 示例 | 说明 |
|------|------|------|
| 类型谓词 | `(x): x is Foo => ...` | 返回 true 时收窄类型 |
| 类型断言 | `value as Foo` | 手动告诉 TS 类型（不安全） |
| 非空断言 `!` | `arr[i]!` | 告诉 TS 不是 null/undefined |
| `in` 检查 | `"__skip" in result` | 检查对象是否含某属性 |
| `instanceof` | `error instanceof Error` | 运行时类型检查 |
| const 断言 | `"foo" as const` | 字面量不拓宽（"foo"而非string） |

### 类语法

| 语法 | 示例 | 说明 |
|------|------|------|
| 参数属性 | `constructor(readonly name: string)` | 自动生成 `this.name = name` |
| `private` | `private _context` | 只在类内部可访问 |
| `readonly` | `readonly model: Model` | 不可重新赋值 |
| getter/setter | `get messages() { ... }` | 访问器属性 |

### 异步与生成器

| 语法 | 示例 | 说明 |
|------|------|------|
| `async function*` | `async *stream()` | 异步生成器（可 await + yield） |
| `yield` | `yield event` | 产出一个值给消费者 |
| `yield*` | `yield* subGen()` | 委托：透传子生成器的 yield，接收其 return |
| `AsyncGenerator<Y, R>` | `AsyncGenerator<AgentEvent, AssistantMessage>` | Y=yield类型, R=return类型 |
| `for await...of` | `for await (const x of stream)` | 消费异步迭代器 |
| `Promise.race` | `Promise.race(promises)` | 返回最先完成的 |
| `AbortController` | `new AbortController()` | 取消异步操作 |

### 运算符

| 语法 | 示例 | 说明 |
|------|------|------|
| `?.` | `obj?.prop` | 可选链：obj 为 null 时返回 undefined |
| `??` | `a ?? b` | 空值合并：a 为 null/undefined 时用 b |
| `!` 后缀 | `value!` | 非空断言 |
| `delete` | `delete obj.prop` | 删除对象属性 |
| `satisfies` | `x satisfies Type` | 校验表达式符合类型（不改变推导结果） |
| `...` | `[...arr]` / `{...obj}` | 展开/收集 |

---

## 附录：关键文件索引

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/agent/agent.ts` | 362 | ReAct 循环主体 |
| `src/agent/agent-middleware.ts` | 137 | 中间件接口定义 |
| `src/agent/agent-event.ts` | 46 | 事件类型定义 |
| `src/agent/transcript/transcript-storage.ts` | 95 | 会话存储（读写 JSONL） |
| `src/agent/transcript/transcript-middleware.ts` | 40 | 会话持久化中间件 |
| `src/cli/tui/hooks/use-agent-loop.ts` | 262 | React Hook（含 resume 逻辑） |
| `src/cli/tui/components/resume-prompt.tsx` | 78 | TUI 会话选择组件 |
| `src/foundation/messages/types/message.ts` | 58 | 消息类型定义 |
| `src/foundation/messages/types/content.ts` | 79 | 内容类型定义 |
| `src/foundation/models/model.ts` | 65 | Model 封装类 |
| `src/foundation/models/model-provider.ts` | 37 | Provider 接口 |
| `src/foundation/models/model-context.ts` | 10 | ModelContext 接口 |
