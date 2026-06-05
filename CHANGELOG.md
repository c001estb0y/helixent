# 从零搭建一个 Agent：Helixent 开发实录

> 本文以 Helixent 项目的真实 Git 提交顺序为线索，梳理从零开始构建一个 ReAct 编码代理的完整过程。
> 每一步都对应实际代码，可以直接参照 `src/` 目录学习。

---

## 前置：用大白话理解整个系统

如果你不熟悉 TypeScript 语法，这一节先用日常比喻把整个系统讲透。后面的代码只是这些比喻的"精确表达"。

### 整体比喻：Agent = 一个有工具箱的实习生

想象你雇了一个实习生（Agent），他：

1. **能听懂你说话**（接收用户消息）
2. **会动脑想**（调用大模型推理）
3. **手边有工具箱**（bash、文件读写等）
4. **干完一件事会汇报**（返回结果）
5. **循环往复**直到任务做完

整个系统就是在代码里模拟这个过程。

---

### Q1：什么是 `async *stream()` 和 `AsyncGenerator`？

**直觉**：它是一个"**边做边汇报**"的工作模式。

普通函数像寄快递——你等着，最后一次性收到结果。
`async *stream()` 像**实时直播**——实习生每做一步就喊一声：

```
"我在想..." → "想好了，要执行 bash 命令" → "命令跑完了，结果是..." → "继续想..."
```

代码里 `yield` 就是"喊一声"：

```typescript
yield { type: "progress", subtype: "thinking" }  // 喊：我在想
yield { type: "message", message: result }        // 喊：这是结果
```

外面的人用 `for await` 来"听直播"：

```typescript
for await (const event of agent.stream(消息)) {
  // 每次实习生"喊一声"，这里就执行一次
  显示到屏幕上(event)
}
```

**为什么不用普通函数？** 因为 Agent 可能要执行 30 秒甚至几分钟，如果等全部做完才返回，用户看到的就是一片空白的等待。直播模式让用户实时看到进度。

`yield*` 是"转播"——实习生叫了个帮手干活，帮手的直播自动转给观众：

```typescript
yield* this._think()  // 把 _think 的直播内容直接转给外面
```

---

### Q2：中间件是什么？怎么融入主循环的？

**直觉**：中间件 = **检查站**。

实习生干活的流程里，有很多"检查站"。每经过一个检查站，站里的人可以：
- **看一眼**然后放行（返回 null）
- **塞点东西**进实习生的背包（返回修改后的上下文）
- **拦住不让过**（返回 skip，用于审批）

```
用户消息
  ↓
[检查站] beforeAgentRun → 技能中间件在这里加载技能列表
  ↓
┌──── 循环开始 ────┐
│                   │
│ [检查站] beforeModel → 技能中间件在这里把技能说明塞进提示词
│    ↓              │
│  调用大模型       │
│    ↓              │
│ [检查站] afterModel
│    ↓              │
│  模型说要调 bash  │
│    ↓              │
│ [检查站] beforeToolUse → 审批中间件在这里拦住，问用户"允许吗？"
│    ↓              │
│  执行 bash        │
│    ↓              │
│ [检查站] afterToolUse
│    ↓              │
└──── 继续循环 ────┘
```

**为什么用中间件而不是直接写进代码？**

因为你可能今天想加审批，明天想加日志，后天想加 Todo 提醒。如果每个功能都改主循环代码，很快就乱了。中间件让你"**插拔式地加功能**"——主循环代码一行不改。

**代码怎么写一个中间件？** 就像填表格——你只填你关心的检查站：

```typescript
const 审批中间件 = {
  // 我只关心"工具执行前"这个检查站
  beforeToolUse: async ({ toolUse }) => {
    if (是敏感操作(toolUse.name)) {
      const 用户说 = await 弹窗问用户("允许执行吗？")
      if (!用户说.同意) {
        return { __skip: true, result: "用户拒绝了" }  // 拦住
      }
    }
    return null  // 放行
  }
}
```

---

### Q3：Bash 工具只是个函数，模型怎么知道它的存在？

**直觉**：工具 = **菜单** + **厨师**。

- **菜单**（name + description + parameters）是给模型看的——"这个工具叫 bash，能执行命令，需要传一个 command 参数"
- **厨师**（invoke 函数）是实际干活的——接到订单后真正去执行命令

模型看的是菜单，不是厨师。流程是：

```
1. 你把菜单递给服务员（Provider 发给 OpenAI API）
   → OpenAI 看到："哦，有个工具叫 bash，接受 command 参数"

2. 模型点菜（返回 tool_call）
   → "我要点 bash，command 是 'ls -la'"

3. 你拿着订单找厨师（Agent 按名字找到 bashTool）
   → bashTool.invoke({ command: "ls -la" })

4. 厨师做好菜端上来（执行结果）
   → "total 48\ndrwxr-xr-x ..."

5. 你把菜端回给模型（tool_result 消息）
   → 模型看到结果，决定下一步
```

**Zod 的作用**是什么？ 就是"**一式三份的表格**"——你只填一次，自动生成：
- TypeScript 类型（给开发者的类型检查）
- 运行时校验（确保模型传的参数合法）
- JSON Schema（给模型看的菜单格式）

---

### Q4：各层之间的关系？

```
┌─────────────────────────────────────────────┐
│  你（用户）                                   │
│  "帮我写个 hello world 服务器"               │
└────────────────────┬────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│  CLI / TUI 层（前台接待）                      │
│  接收输入、显示输出、管理界面                   │
└────────────────────┬────────────────────────┘
                     ↓
┌─────────────────────────────────────────────┐
│  Agent 层（实习生的大脑）                      │
│  循环：想 → 做 → 看结果 → 再想                │
│  中间件在这里插入检查站                        │
└──────┬─────────────────────┬────────────────┘
       ↓                     ↓
┌──────────────┐   ┌──────────────────────────┐
│  Model 层    │   │  工具层（工具箱）           │
│  (调用 AI)   │   │  bash / read / write ... │
└──────┬───────┘   └──────────────────────────┘
       ↓
┌──────────────────────────────────────────────┐
│  Provider 层（翻译官）                         │
│  把统一格式翻译成 OpenAI / Anthropic 的格式    │
└──────────────────────────────────────────────┘
```

---

### Q5：工具和中间件到底什么关系？

很多人会混淆这两个概念。一句话：**工具是能力，中间件是流程控制**。

| | 工具（Tools） | 中间件（Middleware） |
|--|--------------|---------------------|
| **是什么** | 一个可执行的"技能" | 流程中的"检查站" |
| **谁触发** | 模型决定调用（点菜） | Agent 循环自动触发 |
| **类比** | 工具箱里的锤子、螺丝刀 | 门口的保安、走廊里的提示牌 |
| **数量** | 11+ 个 | 3 个 |

**工具清单**（模型能调用的"手"）：

```
bash, read_file, write_file, str_replace, apply_patch,
list_files, glob_search, grep_search, file_info, mkdir,
move_path, todo_write, ask_user_question
```

**中间件清单**（流程中的"检查站"）：

| 中间件 | 在哪个检查站工作 | 做什么 |
|--------|-----------------|--------|
| `skillsMiddleware` | 开始前 + 模型调用前 | 加载技能 → 塞进提示词 |
| `todoSystem` | 每步结束后 | 监控是否该提醒写 todo |
| `approvalMiddleware` | 工具执行前 | 拦住敏感操作 → 问用户同意 |

**Agent 构造时是分开注册的**：

```typescript
new Agent({
  tools: [bash, readFile, writeFile, ...],           // 能力
  middlewares: [skillsMiddleware, todoMw, approvalMw] // 流程控制
})
```

两者唯一的交集：`approvalMiddleware` 拦截的是工具执行——但它自己是中间件，不是工具。

---

### Q6：项目里出现的 JSON、YAML、XML 有什么区别？

这三种都是"写结构化数据的方式"，就像同一份简历可以用 Word、PDF、纯文本写：

#### 同一份数据的三种写法

**JSON**（像填表格，严格规范）：
```json
{
  "name": "coding-plan",
  "description": "Plan mode for coding",
  "tags": ["coding", "planning"],
  "readonly": true
}
```

**YAML**（像写笔记，简洁舒服）：
```yaml
name: coding-plan
description: Plan mode for coding
tags:
  - coding
  - planning
readonly: true
```

**XML**（像写公文，啰嗦但精确）：
```xml
<skill>
  <name>coding-plan</name>
  <description>Plan mode for coding</description>
  <tags>
    <tag>coding</tag>
    <tag>planning</tag>
  </tags>
  <readonly>true</readonly>
</skill>
```

#### 对比总结

| | JSON | YAML | XML |
|--|------|------|-----|
| **可读性** | 中等 | 最好 | 最差（标签多） |
| **写注释** | ❌ 不行 | ✅ 用 `#` | ✅ 用 `<!-- -->` |
| **冗余度** | 低 | 最低 | 高（开闭标签） |
| **常见用途** | API 通信、package.json | 配置文件、Docker/K8s | 老系统、HTML 同源 |
| **易错点** | 少个逗号/引号 | 缩进错一格 | 标签没闭合 |
| **机器解析** | 最快 | 中等 | 较慢 |

#### 在 Helixent 项目里谁用什么

| 文件 | 格式 | 为什么 |
|------|------|--------|
| `SKILL.md` 头部 | YAML | 人写人读的元信息，简洁优先 |
| `config.yaml` | YAML | 用户手写的模型配置 |
| `package.json` | JSON | npm 生态硬性规定 |
| `tsconfig.json` | JSON | TypeScript 生态规定 |
| 发给 OpenAI 的请求 | JSON | API 通信标准格式 |
| 技能注入到 prompt | XML 风格 | 方便模型识别结构化指令边界 |

**为什么技能注入用 XML 风格？**

```xml
<skills>
  <skill name="coding-plan" description="Plan mode for coding" />
  <skill name="deep-research" description="Research planning" />
</skills>
```

因为大模型对 XML 标签的理解很好——开闭标签让模型清楚知道"这段是技能列表的开始和结束"，不容易跟正文混淆。Claude、GPT-4 等模型的训练数据中有大量 XML/HTML，所以它们天然擅长解析这种结构。

#### 一句话记住

- **JSON**：程序之间传数据的"普通话"
- **YAML**：人写配置的"简笔画"
- **XML**：老牌的"公文格式"，现在主要给模型看结构用

---

### 关键 TS 语法速查（看后面代码用）

| 语法 | 大白话 |
|------|--------|
| `interface Foo { ... }` | 定义一个"长什么样"的模板 |
| `type A = B \| C` | A 要么是 B，要么是 C |
| `async function` | 这个函数里面有等待（await），不会卡住程序 |
| `async *function` | 边做边吐结果的异步函数（直播模式） |
| `yield x` | 吐一个结果出去（直播喊一声） |
| `yield* other()` | 转播另一个直播 |
| `for await (const x of ...)` | 听直播，每次收到新内容就处理 |
| `z.object({ ... })` | 用 Zod 描述"参数应该长什么样" |
| `Promise<T>` | 未来会给你一个 T 类型的结果 |
| `Record<string, unknown>` | 一个字典（键是字符串，值随意） |
| `Partial<T>` | T 的所有字段都变成可选的 |

---

> 💡 带着上面的直觉去读后面的代码，你会发现每一段都是在实现这些比喻中的某一块。

---

## 第一步：定义基础类型（Foundation）

**对应提交**：`chore: init`（04-06 17:32）

一切从定义"对话"的数据结构开始。Agent 本质上是在管理一段对话 transcript，所以第一件事是：**定义消息和内容类型**。

### 1.1 内容类型（Content）

```typescript
// src/foundation/messages/types/content.ts
interface TextContent      { type: "text"; text: string }
interface ThinkingContent  { type: "thinking"; thinking: string }
interface ToolUseContent   { type: "tool_use"; id: string; name: string; input: unknown }
interface ToolResultContent{ type: "tool_result"; tool_use_id: string; content: string }
```

**关键决策**：使用 `type` 字段做辨别联合（Discriminated Union），这样 TypeScript 可以自动窄化类型。

### 1.2 消息类型（Message）

```typescript
// src/foundation/messages/types/message.ts
interface SystemMessage    { role: "system"; content: TextContent[] }
interface UserMessage      { role: "user"; content: (TextContent | ImageURLContent)[] }
interface AssistantMessage { role: "assistant"; content: (TextContent | ThinkingContent | ToolUseContent)[] }
interface ToolMessage      { role: "tool"; content: ToolResultContent[] }

type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage
```

**设计原则**：整个系统只有一种 `Message` 联合类型，从用户输入到模型调用到工具结果，全部用同一套类型流转。

### 1.3 工具定义（Tool）

```typescript
// src/foundation/tools/function-tool.ts
interface FunctionTool<P extends ZodSchema, R> {
  name: string
  description: string
  parameters: P           // Zod schema，自动生成 JSON Schema
  invoke: (input: z.infer<P>, signal?: AbortSignal) => Promise<R>
}

function defineTool<P, R>(config): FunctionTool<P, R>
```

**为什么用 Zod**：一份 Schema 同时获得 TypeScript 类型推断 + 运行时校验 + OpenAI function calling 所需的 JSON Schema。

### 1.4 模型抽象（Model + Provider）

```typescript
// src/foundation/models/model-provider.ts
interface ModelProvider {
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>
  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>
}

// src/foundation/models/model.ts
class Model {
  constructor(name: string, provider: ModelProvider, options?: Record<string, unknown>)
  invoke(context: ModelContext): Promise<AssistantMessage>
  stream(context: ModelContext): AsyncGenerator<AssistantMessage>
}
```

**设计**：`Model` 只做 Context → Params 转换，真正的 API 调用交给 `ModelProvider`。这样换模型只需换 Provider，Agent 代码不动。

---

## 第二步：实现 Agent 核心循环

**对应提交**：`feat: invoke in parallel`（04-06 18:02）

有了基础类型，就可以写核心 ReAct 循环了。

### 2.1 最小可用的 Agent

```typescript
// src/agent/agent.ts（核心逻辑精简）
class Agent {
  async *stream(message: UserMessage): AsyncGenerator<AgentEvent> {
    this._messages.push(message)

    for (let step = 0; step < this._maxSteps; step++) {
      // 1. Think：调用模型
      const assistantMsg = await this._think()
      yield { type: "message", message: assistantMsg }

      // 2. 提取 tool_use
      const toolUses = assistantMsg.content.filter(c => c.type === "tool_use")
      if (toolUses.length === 0) return  // 没有工具调用 = 完成

      // 3. Act：并行执行工具
      const toolResults = await this._act(toolUses)
      yield { type: "message", message: toolResults }
    }
  }
}
```

**核心流程**：Think → 有工具调用? → Act → 把结果拼回 transcript → 下一轮 Think。

### 2.2 为什么用 `async *stream()` + `AsyncGenerator`？

这是理解整个架构的关键。先看三种可选方案对比：

| 方案 | 写法 | 问题 |
|------|------|------|
| 回调 | `agent.run(msg, onEvent)` | 回调地狱，难以组合 |
| Promise | `const result = await agent.run(msg)` | 必须等全部完成才能拿到结果，无法流式 |
| **AsyncGenerator** | `for await (const event of agent.stream(msg))` | ✅ 边产生边消费，天然流式 |

**为什么 Agent Loop 必须是流式的？**

Agent 一次执行可能持续几十秒（多轮 Think + Act），如果用 Promise 等全部做完才返回，UI 就卡死了。用 `AsyncGenerator`：

```typescript
// 生产者：Agent 内部
async *stream(message: UserMessage): AsyncGenerator<AgentEvent> {
  // 每次有新内容就 yield 出去，调用者立刻能拿到
  yield { type: "progress", subtype: "thinking" }   // 正在思考...
  yield { type: "message", message: assistantMsg }   // 模型回复了
  yield { type: "message", message: toolResult }     // 工具执行完了
}

// 消费者：TUI 层
for await (const event of agent.stream(userMsg)) {
  // 每次 yield 都会触发这里，实时更新界面
  updateUI(event)
}
```

**`yield*` 的作用——子生成器委托：**

```typescript
// agent.ts 中的关键写法
async *stream(message: UserMessage) {
  const assistantMessage = yield* this._think()  // 委托给 _think 生成器
  yield* this._act(toolUses)                     // 委托给 _act 生成器
}
```

`yield*` 意思是"把子生成器的所有 yield 透传给我的调用者"。这样 `_think()` 内部 yield 的进度事件会直接流到最外层的 `for await`，不需要手动转发。**Agent 的 stream 方法就像管道，子生成器的产出自动冒泡到消费者**。

**对比 Node.js Stream：** AsyncGenerator 比 Node Stream 更轻量——不需要管背压、不需要 pipe，语法就是普通的 `for await`，TypeScript 类型检查完全覆盖。

### 2.3 并行工具执行

```typescript
// 关键：用 Promise.race 而非 Promise.all
// 工具结果按完成顺序逐个 emit，而非等全部完成
async _act(toolUses: ToolUseContent[]) {
  const pending = toolUses.map(t => this._executeTool(t))
  const remaining = new Set(pending.map((_, i) => i))

  while (remaining.size > 0) {
    const { index, result } = await Promise.race(
      [...remaining].map(i => pending[i])
    )
    remaining.delete(index)
    // emit result immediately
  }
}
```

**为什么并行**：Agent 一次推理可能产生多个工具调用（如同时读 3 个文件），串行太慢。

---

## 第三步：添加中间件系统

**对应提交**：`feat: implement middleware support`（04-06 18:49）

Agent 需要扩展能力（审批、技能注入、Todo 提醒），但不想改 Agent 核心代码。解决方案：**中间件钩子**。

```typescript
// src/agent/agent-middleware.ts
interface AgentMiddleware {
  beforeAgentRun?(params): Partial<AgentContext> | null
  beforeModel?(params): Partial<ModelContext> | null
  beforeToolUse?(params): { __skip: true; result } | Partial<AgentContext> | null
  afterToolUse?(params): Partial<AgentContext> | null
  // ... 共 8 个钩子
}
```

**使用方式**：

```typescript
const agent = new Agent({
  model,
  tools,
  middlewares: [skillsMiddleware, todoMiddleware, approvalMiddleware]
})
```

**关键设计**：
- 钩子按数组顺序执行
- 返回 `null` = 不干预
- 返回 partial object = merge 到上下文
- `beforeToolUse` 可返回 `{ __skip: true, result }` 阻止执行（用于审批）

### 3.1 中间件如何融入 Agent Loop？

看 `agent.ts` 中 `stream()` 方法的完整调用链就明白了：

```typescript
async *stream(message: UserMessage) {
  this._appendMessage(message)
  await this._beforeAgentRun()          // ← 钩子①：Agent 开始前（技能加载在这里）
  
  for (let step = 1; step <= maxSteps; step++) {
    await this._beforeAgentStep(step)   // ← 钩子②：每步开始（Todo 提醒在这里）
    
    // _think() 内部会调用：
    //   await this._beforeModel(ctx)   // ← 钩子③：模型调用前（注入 skills 到 prompt）
    const assistantMsg = yield* this._think()
    await this._afterModel(assistantMsg) // ← 钩子④：模型返回后

    const toolUses = this._extractToolUses(assistantMsg)
    if (toolUses.length === 0) {
      await this._afterAgentRun()       // ← 钩子⑤：Agent 结束
      return
    }

    // _act() 内部会对每个工具调用：
    //   await this._beforeToolUse(tu)  // ← 钩子⑥：执行前（审批拦截在这里）
    //   tool.invoke(...)
    //   await this._afterToolUse(tu,r) // ← 钩子⑦：执行后
    yield* this._act(toolUses)
    await this._afterAgentStep(step)    // ← 钩子⑧：每步结束
  }
}
```

**每个钩子的执行逻辑都一样**（以 `_beforeModel` 为例）：

```typescript
private async _beforeModel(modelContext: ModelContext) {
  for (const middleware of this.middlewares) {   // 按数组顺序遍历
    if (!middleware.beforeModel) continue        // 没实现就跳过
    const result = await middleware.beforeModel({ modelContext, agentContext: this._context })
    if (result) {
      Object.assign(modelContext, result)        // 把返回值 merge 进上下文
    }
  }
}
```

**实际效果举例**：
- `skillsMiddleware.beforeModel()` → 返回 `{ messages: [...原消息, 技能描述XML] }` → 模型就能看到技能列表了
- `approvalMiddleware.beforeToolUse()` → 返回 `{ __skip: true, result: "拒绝" }` → 工具不执行，直接用拒绝信息作为结果
- `todoMiddleware.afterAgentStep()` → 检查是否需要提醒使用 todo → 注入提醒消息

**本质**：中间件不是"插件系统"，而是 Agent Loop 源码里预埋的 `await` 调用点。每个点都可以被任意多个中间件拦截和修改。这比"继承 Agent 类重写方法"灵活得多——多个中间件可以组合工作，互不干扰。

---

## 第四步：实现编码工具

**对应提交**：`feat: introduce coding-specific agents and tools`（04-06 23:17）+ 后续 PR #18、#20

有了 Agent 骨架，接下来填充实际工具。

### 4.1 Bash 工具（最简工具示范）

```typescript
// src/coding/tools/bash.ts
export const bashTool = defineTool({
  name: "bash",
  description: "Execute a shell command",
  parameters: z.object({
    description: z.string(),
    command: z.string(),
  }),
```

### 4.0 工具如何跟系统提示词联系起来？

这是初学者最常困惑的问题。`bashTool` 只是一个 JS 对象，它怎么变成模型能调用的"能力"？

**答案：通过 3 层传递链**：

```
defineTool() 定义的对象
       ↓ 注册到
Agent({ tools: [bashTool, readFileTool, ...] })
       ↓ 传递给
Model.stream(modelContext)  ← modelContext.tools 带着工具列表
       ↓ 转换为
Provider 的 API 格式（如 OpenAI function calling）
```

具体看代码：

**第 1 步**：Agent 把 tools 放进 ModelContext

```typescript
// agent.ts → _think()
private async *_think() {
  const modelContext: ModelContext = {
    prompt: this.prompt,        // 系统提示词
    messages: this.messages,    // 对话历史
    tools: this.tools,          // ← 工具列表在这里传入
    signal: this._abortController?.signal,
  }
  // ...
  for await (const snapshot of this.model.stream(modelContext)) { ... }
}
```

**第 2 步**：Model 把 tools 原封不动传给 Provider

```typescript
// model.ts → _buildModelProviderParams()
private _buildModelProviderParams(context: ModelContext): ModelProviderInvokeParams {
  return {
    model: this.name,
    messages,             // 含 system prompt
    tools: context.tools, // ← 工具列表传递给 Provider
    signal: context.signal,
  }
}
```

**第 3 步**：Provider 把 FunctionTool 转换为 API 格式

```typescript
// community/openai/utils.ts → convertToOpenAITools()
export function convertToOpenAITools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,                         // "bash"
      description: tool.description,           // "Execute a shell command"
      parameters: tool.parameters.toJSONSchema(), // Zod → JSON Schema
    },
  }))
}
```

**最终发给 OpenAI 的请求长这样**：

```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "system", "content": "You are a coding agent..." },
    { "role": "user", "content": "列出当前目录文件" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Execute a shell command",
        "parameters": {
          "type": "object",
          "properties": {
            "description": { "type": "string" },
            "command": { "type": "string" }
          },
          "required": ["description", "command"]
        }
      }
    }
  ]
}
```

**模型返回工具调用后，Agent 怎么找到对应函数执行？**

```typescript
// agent.ts → _act() 内部
const tool = this.tools?.find((t) => t.name === toolUse.name)  // 按 name 匹配
const result = await tool.invoke(toolUse.input, signal)         // 调用 invoke 函数
```

**总结这条链路**：

```
┌──────────────┐     ┌───────────┐     ┌──────────────┐     ┌────────────┐
│ defineTool() │ ──→ │ Agent     │ ──→ │ Model        │ ──→ │ Provider   │
│ (JS 对象)    │     │ (tools[]) │     │ (ModelCtx)   │     │ (API 请求)  │
└──────────────┘     └───────────┘     └──────────────┘     └────────────┘
                                                                    │
                                                                    ↓
┌──────────────┐     ┌───────────┐     ┌──────────────┐     ┌────────────┐
│ tool.invoke()│ ←── │ Agent     │ ←── │ Model        │ ←── │ 模型响应    │
│ (执行函数)   │     │ (name匹配) │     │ (parse)      │     │ (tool_call) │
└──────────────┘     └───────────┘     └──────────────┘     └────────────┘
```

**关键认识**：工具的 `name` + `description` + `parameters` 是给模型看的（决定何时调用、传什么参数），而 `invoke` 函数是给 Agent 执行的。两者通过 `name` 字段关联。模型不知道 `invoke` 的存在，它只看到 JSON Schema。
  invoke: async ({ command }, signal) => {
    const proc = Bun.spawn(["zsh", "-c", command], { signal })
    const stdout = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text()
      return `Error (exit ${exitCode}): ${stderr}`
    }
    return stdout
  },
})
```

### 4.2 文件读取工具（带验证的工具示范）

```typescript
// src/coding/tools/read-file.ts
export const readFileTool = defineTool({
  name: "read_file",
  parameters: z.object({
    path: z.string(),
    startLine: z.number().optional(),
    endLine: z.number().optional(),
  }),
  invoke: async ({ path, startLine, endLine }) => {
    const validation = ensureAbsolutePath(path)
    if (!validation.ok) return validation.error

    const file = Bun.file(path)
    if (!(await file.exists())) return `Error: File not found: ${path}`

    let text = await file.text()
    // 按行范围截取...
    return text
  },
})
```

### 4.3 工具清单

随着项目发展，逐步添加了 11 个工具（按引入顺序）：

| 阶段 | 工具 | 作用 |
|------|------|------|
| Day 1 | `bash`, `read_file`, `write_file`, `str_replace` | 基础执行与编辑 |
| Day 3 | `list_files`, `glob_search`, `grep_search` | 代码导航 |
| Day 4 | `apply_patch`, `file_info`, `mkdir`, `move_path` | 高级文件操作 |

---

## 第五步：接入 LLM Provider

**对应提交**：`feat: add Anthropic as model provider`（04-10）

Agent 核心不关心调用的是哪个模型。Provider 负责格式转换。

### 5.1 OpenAI Provider

```typescript
// src/community/openai/model-provider.ts
class OpenAIModelProvider implements ModelProvider {
  private client: OpenAI

  async *stream(params: ModelProviderInvokeParams) {
    const stream = await this.client.chat.completions.create({
      model: params.model,
      messages: convertToOpenAIMessages(params.messages),
      tools: convertToOpenAITools(params.tools),
      stream: true,
    })

    const accumulator = new StreamAccumulator()
    for await (const chunk of stream) {
      accumulator.push(chunk)
      yield accumulator.snapshot()  // 每个 chunk 后 yield 完整快照
    }
  }
}
```

### 5.2 格式转换（关键胶水层）

```typescript
// src/community/openai/utils.ts
function convertToOpenAIMessages(messages: Message[]): ChatCompletionMessageParam[] {
  // Helixent Message → OpenAI 格式
  // 要点：ThinkingContent 被丢弃（OpenAI 不支持）
  //       ToolUseContent → tool_calls 数组
  //       ToolMessage → { role: "tool", tool_call_id, content }
}

function convertToOpenAITools(tools: FunctionTool[]): ChatCompletionTool[] {
  // Zod schema → JSON Schema（通过 .toJSONSchema()）
}

function parseAssistantMessage(msg: ChatCompletionMessage): AssistantMessage {
  // OpenAI 响应 → Helixent AssistantMessage
}
```

**关键认识**：Provider 层是 "翻译官"，把统一的内部类型翻译成各家 API 的格式。加新 Provider 只需写新的翻译。

---

## 第六步：组装编码代理

**对应提交**：`feat: introduce coding-specific agents`（04-06 23:17）

把前面所有零件组装在一起：

```typescript
// src/coding/agents/lead-agent.ts
async function createCodingAgent({ model, cwd, skillsDirs, askUser }) {
  // 1. 加载项目上下文
  const agentsmd = await loadAgentsMd(cwd)

  // 2. 创建中间件
  const todoSystem = createTodoSystem()
  const skillsMiddleware = createSkillsMiddleware(skillsDirs)
  const approvalMiddleware = createApprovalMiddleware({ askUser })

  // 3. 组装 Agent
  return new Agent({
    model,
    prompt: CODING_SYSTEM_PROMPT,
    tools: [bash, readFile, writeFile, strReplace, applyPatch, ...],
    middlewares: [skillsMiddleware, todoSystem.middleware, approvalMiddleware],
    messages: agentsmd ? [{ role: "user", content: [{ type: "text", text: agentsmd }] }] : [],
  })
}
```

---

## 第七步：添加技能系统

**对应提交**：`feat: add skill feature`（04-06 23:11）

技能 = 可热加载的 Markdown 指令，让 Agent 获得新能力而不改代码。

```typescript
// src/agent/skills/skills-middleware.ts
function createSkillsMiddleware(skillsDirs: string[]): AgentMiddleware {
  return {
    beforeAgentRun: async () => {
      // 扫描目录，发现 SKILL.md 文件
      const skills = await listSkills(skillsDirs)
      // ... 存储 skill 元数据
    },
    beforeModel: ({ modelContext }) => {
      // 把技能描述注入系统提示
      const skillsXml = formatSkillsAsXml(skills)
      return { messages: [...modelContext.messages, skillsXml] }
    },
  }
}
```

**技能格式**：

```markdown
---
name: frontend-design
description: Create polished frontend interfaces
---
# Instructions for the agent...
```

---

## 第八步：实现人机协作审批

**对应提交**：`feat: implement HITL approval mechanism`（04-09，PR #13）

敏感操作（执行命令、写文件）需要人工确认。

```typescript
// src/coding/permissions/coding-approval-middleware.ts
function createApprovalMiddleware({ askUser }): AgentMiddleware {
  return {
    beforeToolUse: async ({ toolUse }) => {
      if (!requiresApproval(toolUse.name)) return null

      const decision = await askUser(toolUse)
      if (!decision.approved) {
        return { __skip: true, result: "Operation not approved by user" }
      }
      return null  // 继续执行
    },
  }
}
```

**精妙之处**：审批逻辑完全在中间件里，Agent 核心代码一行不改。

---

## 第九步：构建 TUI 界面

**对应提交**：`feat: add TUI`（04-07 11:58）

Agent 能跑了，但需要交互界面。用 Ink（React for terminal）构建。

### 9.1 核心 Hook

```typescript
// src/cli/tui/hooks/use-agent-loop.ts
function useAgentLoop(agent: Agent) {
  const [messages, setMessages] = useState<Message[]>([])

  const submit = async (text: string) => {
    const userMsg = { role: "user", content: [{ type: "text", text }] }

    for await (const event of agent.stream(userMsg)) {
      if (event.type === "message") {
        enqueueMessage(event.message)  // 50ms 防抖批量更新
      }
    }
  }

  return { messages, submit }
}
```

### 9.2 后续逐步增强

| 时间 | 功能 |
|------|------|
| 04-07 | 基础 TUI + /clear |
| 04-08 | Todo Panel + 深色主题 + Footer |
| 04-09 | 斜杠命令补全 + Token 用量显示 |
| 04-10 | 输入历史（↑↓） |
| 04-11 | Settings + always-allow 审批 |

---

## 第十步：流式传输与事件系统

**对应提交**：`feat: implement streaming support`（04-10 10:11）

### 10.1 事件类型

```typescript
// src/agent/agent-event.ts
type AgentEvent =
  | { type: "message"; message: AssistantMessage | ToolMessage }
  | { type: "progress"; subtype: "thinking" }
  | { type: "progress"; subtype: "tool"; name: string }
```

### 10.2 流式快照模式

```typescript
// Provider 层：每个 chunk 后 yield 一个完整的 AssistantMessage
class StreamAccumulator {
  push(chunk: ChatCompletionChunk) { /* 累积 */ }
  snapshot(): AssistantMessage { /* 返回当前完整状态 */ }
}
```

**为什么用快照而非差量**：消费者代码更简单——每次拿到的都是完整可渲染的消息。

---

## 第十一步：结构化工具结果

**对应提交**：`feat: structured tool-result runtime`（04-11，PR #23）

工具返回的原始数据可能很大（比如 `read_file` 读了 1 万行），需要智能截断。

```typescript
// src/agent/tool-result-runtime.ts
function formatToolResultForMessage({ toolName, result }): string {
  const policy = getToolResultPolicy(toolName)
  // read_file: 保留完整内容，最多 12000 字符
  // list_files: 只保留摘要
  // bash: 保留输出，最多 8000 字符
  return applyPolicy(result, policy)
}
```

---

## 第十二步：发布与兼容

**对应提交**：v1.0.2 → v1.1.0 → v1.2.0 → v1.3.1

| 版本 | 关键变化 |
|------|---------|
| v1.0.2 | CLI 命令体系可用，首次 npm publish |
| v1.1.0 | + Anthropic Provider、AskUserQuestion、Settings |
| v1.2.0 | + reasoning content 支持、中文文档 |
| v1.3.1 | 构建修复，稳定发布 |

---

## 总结：搭建路线图

如果你要从零搭建一个类似的 Agent，推荐按这个顺序：

```
1. 定义消息类型（Message, Content 联合类型）
       ↓
2. 定义工具接口（FunctionTool + Zod）
       ↓
3. 定义模型抽象（Model + ModelProvider 接口）
       ↓
4. 实现 Agent 核心循环（Think → Act → Observe）
       ↓
5. 实现并行工具执行（Promise.race）
       ↓
6. 添加中间件系统（8 个生命周期钩子）
       ↓
7. 实现具体工具（bash → read_file → write_file → ...）
       ↓
8. 接入 LLM Provider（OpenAI / Anthropic 适配）
       ↓
9. 组装编码代理（createCodingAgent 工厂函数）
       ↓
10. 添加技能系统（SKILL.md 热加载）
       ↓
11. 实现审批机制（beforeToolUse 中间件拦截）
       ↓
12. 构建 TUI 界面（Ink + React hooks）
       ↓
13. 流式传输优化（StreamAccumulator + 快照模式）
       ↓
14. 工具结果策略（按工具名定制截断规则）
       ↓
15. 发布（npm publish + 版本管理）
```

**耗时参考**：Helixent 从 init 到 v1.3.1 用了 20 天，其中核心架构（步骤 1-9）在第一天就完成了雏形。

---

## 第十三步：Reasoning Content 与 Plan Mode 技能

**对应提交**：`feat: add reasoning_content`（05-02 12:36）+ `feat: add plan mode skill`（05-02 13:13）

v1.3.1 之后，项目继续演进。这一步解决两个问题：**支持模型推理内容**和**引入结构化计划模式**。

### 13.1 支持 reasoning_content

部分模型（如 DeepSeek、QwQ）在响应中返回 `reasoning_content` 字段，代表"思考过程"。需要在 Provider 层正确映射：

```typescript
// src/community/openai/utils.ts（变更部分）
// 转换 Helixent ThinkingContent → OpenAI reasoning_content
assistantMessage.reasoning_content = "";
for (const content of message.content) {
  if (content.type === "thinking") {
    assistantMessage.reasoning_content = content.thinking;
  }
}
```

**关键**：在构建 OpenAI 消息时，先初始化空字符串再赋值——这确保了即使模型不返回推理内容，字段也存在，兼容性更好。

### 13.2 Plan Mode 技能：coding-plan

```markdown
<!-- skills/coding-plan/SKILL.md -->
---
name: coding-plan
description: Enter "plan mode" for a coding task — read code, ask questions,
             design approach, write plans/<name>.md. No source files edited.
---
```

**核心约束**：Plan Mode 是**只读的**——只允许写 `plans/*.md`，不允许修改源代码。4 个阶段：

1. **Discover** — 阅读相关代码，理解上下文
2. **Clarify** — 向用户提问，消除歧义
3. **Design** — 设计一个推荐方案
4. **Write** — 输出 `plans/<name>.md` 计划文件

**为什么需要这个**：Agent 容易"冲动编码"——拿到需求就开始改文件。Plan Mode 强制它先思考、先规划，产出人可 review 的计划再动手。

### 13.3 Deep Research Plan 技能

```markdown
<!-- skills/deep-research-plan/SKILL.md -->
---
name: deep-research-plan
description: Plan mode for research/article tasks — search web, fetch sources,
             design outline, write plans/<name>.md. No article content drafted.
---
```

与 coding-plan 同构，但面向**研究/写作任务**——允许搜索和获取网页，但不允许产出正式内容。

### 13.4 输入编辑器增强

```typescript
// src/cli/tui/input-editor.ts
// 新增：Meta(Option/Alt) + ← / → 实现按词跳转
// 让终端编辑体验接近 IDE
```

---

## 更新后的搭建路线图

```
1-15. （前述步骤不变）
       ↓
16. 支持推理内容（reasoning_content 映射）
       ↓
17. 引入 Plan Mode 技能（只读计划阶段，强制先思考后编码）
       ↓
18. 持续打磨交互体验（按词跳转等编辑器增强）
```

---

*基于 Helixent 项目 99 条 Git 提交记录整理 | 最后更新：2026-05-06*
