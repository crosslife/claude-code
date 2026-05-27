# Claude Code Subagent 架构深度分析

## 目录

1. [架构概览](#1-架构概览)
2. [核心类型系统](#2-核心类型系统)
3. [Agent 工具定义（入口）](#3-agent-工具定义入口)
4. [内置 Agent 类型](#4-内置-agent-类型)
5. [Subagent 生命周期](#5-subagent-生命周期)
6. [上下文隔离机制](#6-上下文隔离机制)
7. [工具过滤与权限系统](#7-工具过滤与权限系统)
8. [模型选择逻辑](#8-模型选择逻辑)
9. [Fork Subagent 实验](#9-fork-subagent-实验)
10. [异步 Agent 与通知机制](#10-异步-agent-与通知机制)
11. [Agent 恢复（Resume）机制](#11-agent-恢复resume机制)
12. [Transcript 存储与管理](#12-transcript-存储与管理)
13. [Worktree 隔离](#13-worktree-隔离)
14. [关键代码文件索引](#14-关键代码文件索引)
15. [端到端流程图](#15-端到端流程图)

---

## 1. 架构概览

Claude Code 的 subagent 系统**没有**一个名为 `SubAgent` 的类。它基于以下核心抽象构建：


| 概念       | 实现                                                 |
| -------- | -------------------------------------------------- |
| Agent 定义 | `AgentDefinition` 联合类型（Built-in / Custom / Plugin） |
| Agent 执行 | `runAgent()` 异步生成器 → 内部复用 `query()` 主循环            |
| 上下文隔离    | `createSubagentContext()` 创建独立的 `ToolUseContext`   |
| 后台任务管理   | `LocalAgentTask` 注册/通知/终止                          |
| 唯一标识     | `agentId`（UUID），通过 `AsyncLocalStorage` 追踪          |


**工具命名：**

- 当前名称：`Agent`（`AGENT_TOOL_NAME`）
- 遗留名称：`Task`（`LEGACY_AGENT_TOOL_NAME`），用于向后兼容

```
src/tools/AgentTool/constants.ts:
  AGENT_TOOL_NAME = 'Agent'
  LEGACY_AGENT_TOOL_NAME = 'Task'
```

---

## 2. 核心类型系统

### 2.1 AgentDefinition（Agent 定义）

**文件：** `src/tools/AgentTool/loadAgentsDir.ts` (L105-165)

```typescript
// 基础类型 - 所有 Agent 共享字段
type BaseAgentDefinition = {
  agentType: string              // 类型标识，如 'general-purpose', 'Explore'
  whenToUse: string              // 描述何时使用此 Agent
  tools?: string[]               // 允许的工具列表，['*'] 表示全部
  disallowedTools?: string[]     // 禁止的工具列表
  model?: string                 // 模型选择：'inherit' | 'haiku' | 'sonnet' | 'opus'
  permissionMode?: PermissionMode
  maxTurns?: number              // 最大轮次
  background?: boolean           // 是否强制后台运行
  isolation?: 'worktree' | 'remote'
  omitClaudeMd?: boolean         // 省略 CLAUDE.md（节省 token）
  hooks?: HooksSettings          // 会话级钩子
  mcpServers?: AgentMcpServerSpec[]
  effort?: EffortValue
  // ...更多字段
}

// 三种 Agent 定义类型
type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  getSystemPrompt: (params) => string  // 动态系统提示词
}
type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: SettingSource  // 'userSettings' | 'projectSettings' | ...
}
type PluginAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'plugin'
  plugin: string
}

type AgentDefinition = BuiltInAgentDefinition | CustomAgentDefinition | PluginAgentDefinition
```

### 2.2 SubagentContext（分析上下文）

**文件：** `src/utils/agentContext.ts` (L28-54)

使用 `AsyncLocalStorage` 实现并发安全的上下文追踪：

```typescript
type SubagentContext = {
  agentId: string
  parentSessionId?: string
  agentType: 'subagent'
  subagentName?: string
  isBuiltIn?: boolean
  invokingRequestId?: string
  invocationKind?: 'spawn' | 'resume'
  invocationEmitted?: boolean
}
```

关键设计：当多个 Agent 并发执行时（ctrl+b 后台化），`AsyncLocalStorage` 确保每个执行链的 `agentId` 不会交叉污染——这是选择 `AsyncLocalStorage` 而非 `AppState` 的原因。

### 2.3 LocalAgentTaskState（后台任务状态）

**文件：** `src/tasks/LocalAgentTask/LocalAgentTask.tsx` (L116-148)

```typescript
type LocalAgentTaskState = TaskStateBase & {
  type: 'local_agent'
  agentId: string
  prompt: string
  selectedAgent?: AgentDefinition
  agentType: string
  model?: string
  abortController?: AbortController
  result?: AgentToolResult
  progress?: AgentProgress
  isBackgrounded: boolean
  pendingMessages: string[]     // SendMessage 排队的消息
  retain: boolean               // UI 是否持有此任务
  diskLoaded: boolean           // 是否已从磁盘加载 transcript
}
```

---

## 3. Agent 工具定义（入口）

**文件：** `src/tools/AgentTool/AgentTool.tsx` (L82-160)

### 3.1 输入 Schema

```typescript
const baseInputSchema = z.object({
  description: z.string(),           // 3-5 词任务描述
  prompt: z.string(),                // Agent 执行的任务
  subagent_type: z.string().optional(), // Agent 类型
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
  run_in_background: z.boolean().optional(),
})

// 完整 schema 扩展了多 Agent 参数
const fullInputSchema = baseInputSchema.merge(z.object({
  name: z.string().optional(),       // 可寻址名称
  team_name: z.string().optional(),  // 团队名称
  mode: permissionModeSchema().optional(),
})).extend({
  isolation: z.enum(['worktree', 'remote']).optional(),
  cwd: z.string().optional(),        // 工作目录覆盖
})
```

### 3.2 输出 Schema

同步与异步两种结果：

```typescript
const outputSchema = z.union([
  // 同步完成
  agentToolResultSchema.extend({
    status: z.literal('completed'),
    prompt: z.string()
  }),
  // 异步启动
  z.object({
    status: z.literal('async_launched'),
    agentId: z.string(),
    description: z.string(),
    prompt: z.string(),
    outputFile: z.string(),
  })
])
```

### 3.3 工具注册

```typescript
// AgentTool.tsx L196-228
export const AgentTool = buildTool({
  name: AGENT_TOOL_NAME,           // 'Agent'
  searchHint: 'delegate work to a subagent',
  aliases: [LEGACY_AGENT_TOOL_NAME], // ['Task']
  // ...
})
```

`isConcurrencySafe(): true` — 允许父 Agent 在同一轮次并行发起多个 Agent 调用。

---

## 4. 内置 Agent 类型

**文件：** `src/tools/AgentTool/builtInAgents.ts`

```typescript
function getBuiltInAgents(): AgentDefinition[] {
  // 1. 环境变量可完全禁用（SDK 场景）
  // 2. Coordinator 模式走独立路径
  // 3. 默认注册：
  const agents = [
    GENERAL_PURPOSE_AGENT,    // 始终可用
    STATUSLINE_SETUP_AGENT,   // 始终可用
  ]
  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)  // GrowthBook 控制
  }
  if (isNonSdkEntrypoint) {
    agents.push(CLAUDE_CODE_GUIDE_AGENT)     // 非 SDK 入口可用
  }
  if (feature('VERIFICATION_AGENT') && growthbook) {
    agents.push(VERIFICATION_AGENT)          // 实验性
  }
  return agents
}
```

### 各内置 Agent 详情

| Agent 类型 | 文件 | 工具 | 模型 | 特点 |
|---|---|---|---|---|
| `general-purpose` | `built-in/generalPurposeAgent.ts` | `['*']` 全部工具 | 默认（继承） | 通用多步骤任务 |
| `Explore` | `built-in/exploreAgent.ts` | 排除写入工具 | ant=inherit, 外部=haiku | 只读搜索，`omitClaudeMd: true` |
| `Plan` | `built-in/planAgent.ts` | 排除写入工具 | inherit | 规划模式，`omitClaudeMd: true` |
| `claude-code-guide` | `built-in/claudeCodeGuideAgent.ts` | 明确工具列表 | haiku | `permissionMode: 'dontAsk'` |
| `verification` | `built-in/verificationAgent.ts` | 排除写入工具 | inherit | 实验性验证，`background: true` |
| `statusline-setup` | `built-in/statuslineSetup.ts` | `['Read', 'Edit']` | sonnet | 状态栏配置 |
| `fork`（合成） | `forkSubagent.ts` | `['*']` | inherit | 继承父会话上下文 |

### 4.1 General-purpose Agent（通用 Agent）

最基础的 subagent，拥有所有工具，继承父模型。核心用途是执行复杂的多步骤任务。

```typescript
// built-in/generalPurposeAgent.ts
export const GENERAL_PURPOSE_AGENT: BuiltInAgentDefinition = {
  agentType: 'general-purpose',
  whenToUse: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks...',
  tools: ['*'],          // 全部工具
  source: 'built-in',
  baseDir: 'built-in',
  // model 故意省略 — 使用 getDefaultSubagentModel()
  getSystemPrompt: getGeneralPurposeSystemPrompt,
}
```

系统提示词要求：完成任务后返回简洁报告，因为调用者会转述给用户。

### 4.2 Explore Agent（探索 Agent）

**Explore 是 subagent 的一个典型应用**——专门用于只读代码搜索。它展示了 subagent 系统如何通过约束工具集和自定义系统提示词来创建专用代理。

```typescript
// built-in/exploreAgent.ts
export const EXPLORE_AGENT: BuiltInAgentDefinition = {
  agentType: 'Explore',
  whenToUse: 'Fast agent specialized for exploring codebases...',
  disallowedTools: [
    'Agent',              // 不能嵌套 Agent
    'ExitPlanMode',
    'Edit',               // 禁止编辑
    'Write',              // 禁止写入
    'NotebookEdit',       // 禁止笔记本编辑
  ],
  source: 'built-in',
  baseDir: 'built-in',
  model: process.env.USER_TYPE === 'ant' ? 'inherit' : 'haiku',  // 外部用户用 haiku（快速+便宜）
  omitClaudeMd: true,     // 省略 CLAUDE.md，节省 ~5-15 Gtok/week
  getSystemPrompt: () => getExploreSystemPrompt(),
}
```

**Explore 的系统提示词关键设计：**

1. **严格只读约束**：`=== CRITICAL: READ-ONLY MODE ===` 列出所有禁止操作
2. **搜索策略指导**：使用 Glob/Grep/Read/Bash(只读) 的搭配指导
3. **速度优先**：明确要求"尽可能快速返回输出"和"并行发起多个工具调用"
4. **适应性搜索深度**：根据调用者指定的 thoroughness level（quick/medium/very thorough）调整

**Explore 在 runAgent 中的特殊优化：**

```typescript
// runAgent.ts:390-410
// Explore/Plan 省略 CLAUDE.md 的 userContext
const shouldOmitClaudeMd = agentDefinition.omitClaudeMd && ...
const resolvedUserContext = shouldOmitClaudeMd ? userContextNoClaudeMd : baseUserContext

// Explore/Plan 省略 gitStatus 的 systemContext（最高 40KB）
const resolvedSystemContext =
  agentDefinition.agentType === 'Explore' || agentDefinition.agentType === 'Plan'
    ? systemContextNoGit    // 不带 gitStatus
    : baseSystemContext
```

这些优化在 34M+ 周 Explore 调用量级下节省了大量 token。

### 4.3 Plan Agent（规划 Agent）

与 Explore 共享只读约束，但系统提示词侧重于架构设计和实现规划：

```typescript
// built-in/planAgent.ts
export const PLAN_AGENT: BuiltInAgentDefinition = {
  agentType: 'Plan',
  disallowedTools: [...],  // 同 Explore
  tools: EXPLORE_AGENT.tools,  // 复用 Explore 的工具配置
  model: 'inherit',
  omitClaudeMd: true,
  getSystemPrompt: () => getPlanV2SystemPrompt(),
}
```

Plan 的系统提示词有明确的工作流程：理解需求 → 深入探索 → 设计方案 → 详细计划，并要求最终输出"关键实现文件"列表。

### 4.4 Claude Code Guide Agent

文档查询专用 Agent，是唯一一个使用 `permissionMode: 'dontAsk'` 的内置 Agent：

```typescript
export const CLAUDE_CODE_GUIDE_AGENT: BuiltInAgentDefinition = {
  agentType: 'claude-code-guide',
  tools: [Glob, Grep, Read, WebFetch, WebSearch],  // 只有搜索和网络获取工具
  model: 'haiku',                  // 始终使用 haiku（快速回答）
  permissionMode: 'dontAsk',       // 无需权限确认
  getSystemPrompt({ toolUseContext }) {
    // 动态系统提示词：注入用户已配置的 skills/agents/MCP/settings 上下文
    // 这样 Guide 可以感知用户环境
  },
}
```

**动态系统提示词**：这是唯一使用 `getSystemPrompt(params)` 带参数形式的内置 Agent。它在生成提示词时读取当前环境的自定义 skills、agents、MCP 服务器和用户设置，使 Guide 能够感知用户的完整配置。

### 4.5 Verification Agent（验证 Agent）

实验性 Agent，用于验证实现是否正确：

```typescript
export const VERIFICATION_AGENT: BuiltInAgentDefinition = {
  agentType: 'verification',
  background: true,                    // 始终后台运行
  color: 'red',                        // 红色标识
  model: 'inherit',
  disallowedTools: [Agent, Edit, Write, NotebookEdit, ExitPlanMode],
  getSystemPrompt: () => VERIFICATION_SYSTEM_PROMPT,
  criticalSystemReminder_EXPERIMENTAL: 'CRITICAL: This is a VERIFICATION-ONLY task...',
}
```

系统提示词极长（~130行），包含：反模式识别（"代码看起来正确"不算验证）、对抗性探测要求、PASS/FAIL/PARTIAL 输出格式、以及按变更类型（前端/后端/CLI/基础设施等）的验证策略。

### 4.6 Statusline Setup Agent

唯一使用显式工具白名单而非 disallowedTools 的内置 Agent：

```typescript
export const STATUSLINE_SETUP_AGENT: BuiltInAgentDefinition = {
  agentType: 'statusline-setup',
  tools: ['Read', 'Edit'],    // 只需要读取配置 + 编辑设置
  model: 'sonnet',
  color: 'orange',
}
```

### ONE_SHOT_BUILTIN_AGENT_TYPES

`Explore` 和 `Plan` 被标记为"一次性" Agent，父 Agent 不会通过 `SendMessage` 继续与它们交互。返回结果时跳过 `agentId/SendMessage/usage` 尾部信息以节省 token。

### 4.7 内置 Agent 注册机制

```typescript
// builtInAgents.ts
export function getBuiltInAgents(): AgentDefinition[] {
  // 1. SDK 可通过环境变量禁用所有内置 Agent
  if (isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) && getIsNonInteractiveSession()) {
    return []
  }
  // 2. Coordinator 模式使用独立的 worker agent 列表
  if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
    return getCoordinatorAgents()
  }
  // 3. 默认注册
  const agents = [GENERAL_PURPOSE_AGENT, STATUSLINE_SETUP_AGENT]
  if (areExplorePlanAgentsEnabled()) agents.push(EXPLORE_AGENT, PLAN_AGENT)
  if (isNonSdkEntrypoint) agents.push(CLAUDE_CODE_GUIDE_AGENT)
  if (feature('VERIFICATION_AGENT') && growthbook) agents.push(VERIFICATION_AGENT)
  return agents
}

---

## 4.8 Agent 定义的三大来源与加载机制

**文件：** `src/tools/AgentTool/loadAgentsDir.ts`

Agent 定义来自三个来源，按优先级递增（后者覆盖前者的同名 agentType）：

```
Built-in → Plugin → User → Project → Flag → Managed(Policy)
   ↑           ↑        ↑       ↑         ↑          ↑
  代码硬编码   插件系统  用户配置  项目配置  远程Feature  管理策略
```

```typescript
// loadAgentsDir.ts:359-365
const allAgentsList: AgentDefinition[] = [
  ...builtInAgents,     // getBuiltInAgents()
  ...pluginAgents,      // loadPluginAgents()
  ...customAgents,      // loadMarkdownFilesForSubdir('agents', cwd)
]
const activeAgents = getActiveAgentsFromList(allAgentsList)  // 同名去重，后者覆盖
```

**自定义 Agent 的定义格式：**

1. **Markdown 格式**（.md 文件放在 `.claude/agents/` 目录下）：

```markdown
---
name: my-agent
description: 何时使用此 Agent
tools: ["Read", "Grep", "Bash"]
model: sonnet
permissionMode: dontAsk
maxTurns: 10
background: true
memory: user
isolation: worktree
hooks:
  Stop:
    - command: "echo done"
---
这里是系统提示词内容...
```

2. **JSON 格式**（通过 settings 注入，用于 flagSettings 等远程配置）：

```json
{
  "description": "何时使用此 Agent",
  "tools": ["Read", "Grep"],
  "prompt": "系统提示词内容",
  "model": "haiku",
  "maxTurns": 5
}
```

**Memory 机制**：当 `memory` 字段非空时，Agent 的系统提示词会自动追加 `loadAgentMemoryPrompt(agentType, scope)` 的内容，并且工具列表自动注入 Read/Write/Edit 工具以允许 Agent 读写记忆文件。

**MCP Server 规格**：Agent 可定义自己专属的 MCP 服务器（通过名称引用或内联配置），在 Agent 启动时连接，结束时清理。

---

## 5. Subagent 生命周期

### 5.1 创建阶段

**入口：** `AgentTool.call()` — `AgentTool.tsx` L239+

```
用户 → 模型调用 Agent 工具 → AgentTool.call()
  ├── 解析 subagent_type → 查找 AgentDefinition
  ├── 无 subagent_type + Fork 实验开启 → FORK_AGENT 路径
  ├── 有 subagent_type → 正常 Agent 路径
  ├── 检查 MCP 要求 / 权限 / 隔离
  ├── 构建 system prompt + user messages
  ├── 决定同步 vs 异步执行
  └── 调用 runAgent()
```

### 5.2 执行阶段

**核心：** `runAgent()` — `runAgent.ts` L248-329

```typescript
async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  forkContextMessages,  // Fork 路径的父会话消息
  model,
  availableTools,
  allowedTools,
  useExactTools,        // Fork 路径直接使用父工具池
  worktreePath,
  // ...
}): AsyncGenerator<Message, void> {
  // 1. 解析模型
  const resolvedAgentModel = getAgentModel(...)
  
  // 2. 创建 agentId
  const agentId = override?.agentId ?? createAgentId()
  
  // 3. 构建隔离上下文
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentGetAppState,
    agentId,
    messages: initialMessages,
    shareSetAppState: !isAsync,
    // ...
  })
  
  // 4. 写入 Agent 元数据
  await writeAgentMetadata(agentId, { agentType, worktreePath, description })
  
  // 5. 运行 query() 循环
  for await (const message of query({
    messages: initialMessages,
    systemPrompt,
    tools: resolvedTools,
    model: resolvedAgentModel,
    toolUseContext: agentToolUseContext,
    // ...
  })) {
    // 记录 transcript
    recordSidechainTranscript(agentId, message)
    
    // 仅 yield 完成的消息（跳过 stream_event）
    if (isRecordableMessage(message)) {
      yield message
    }
  }
}
```

**关键点：** subagent 和主线程共享同一个 `query()` 主循环，区别在于隔离的 `ToolUseContext`。

### 5.2.1 runAgent 的完整初始化链

`runAgent()` 在调用 `query()` 之前，经历了一个复杂的初始化链：

```
runAgent() 入口
  │
  ├── 1. 解析模型: getAgentModel(def.model, parentModel, toolParam, permMode)
  │
  ├── 2. 创建 agentId: createAgentId() (UUID)
  │
  ├── 3. 构建初始消息:
  │     ├── forkContextMessages? filterIncompleteToolCalls() : []
  │     └── [...contextMessages, ...promptMessages]
  │
  ├── 4. 解析上下文:
  │     ├── getUserContext() / getSystemContext()
  │     ├── shouldOmitClaudeMd? → 移除 claudeMd
  │     └── Explore/Plan? → 移除 gitStatus
  │
  ├── 5. 权限模式处理:
  │     ├── agentPermissionMode 覆盖（除非父级是 bypassPermissions/acceptEdits/auto）
  │     ├── isAsync && !canShowPrompts → shouldAvoidPermissionPrompts: true
  │     └── allowedTools → 替换 session 级 allow rules
  │
  ├── 6. 解析工具:
  │     ├── useExactTools? availableTools : resolveAgentTools(def, tools, isAsync)
  │     └── + agentMcpTools (Agent 专属 MCP 工具)
  │
  ├── 7. 构建系统提示词:
  │     ├── agentDefinition.getSystemPrompt(params)
  │     └── + enhanceSystemPromptWithEnvDetails() (路径/emoji 补充)
  │
  ├── 8. 确定 abortController:
  │     ├── override?.abortController → 使用覆盖
  │     ├── isAsync → new AbortController() (独立)
  │     └── sync → toolUseContext.abortController (共享)
  │
  ├── 9. 执行 SubagentStart hooks → 注入额外上下文
  │
  ├── 10. 注册 frontmatter hooks (Stop → SubagentStop 转换)
  │
  ├── 11. 预加载 Skills → 注入初始消息
  │
  ├── 12. 初始化 Agent MCP servers
  │
  ├── 13. 构建 agentOptions (thinkingConfig: disabled 或 inherit)
  │
  ├── 14. createSubagentContext() → 隔离的 ToolUseContext
  │
  ├── 15. 写入 transcript 和 metadata (fire-and-forget)
  │
  └── 16. 进入 query() 循环
```

**Thinking 配置的关键设计**：

```typescript
// runAgent.ts:679-684
thinkingConfig: useExactTools
  ? toolUseContext.options.thinkingConfig  // fork: 继承以匹配 prompt cache
  : { type: 'disabled' as const },         // 普通 subagent: 禁用以控制成本
```

普通 subagent **关闭 extended thinking** 以控制 output token 成本；只有 fork 路径为了匹配 prompt cache 才继承父级的 thinking 配置。

### 5.3 完成阶段

#### 同步完成

`AgentTool.tsx` 中消费 `runAgent` 的消息迭代器 → `finalizeAgentTool()` 构建结构化结果：

```typescript
// agentToolUtils.ts L276-357
function finalizeAgentTool(messages, agentDefinition) {
  // 提取最后一条 assistant 文本
  // 统计 usage、工具调用次数
  // 返回 AgentToolResult
}
```

#### 异步完成

```
runAsyncAgentLifecycle()
  ├── 正常完成 → completeAsyncAgent() → enqueueAgentNotification()
  ├── 被中止 → killAsyncAgent() → notification(status: 'killed')
  └── 错误 → failAsyncAgent() → notification(status: 'failed')
```

### 5.4 结果返回

`**mapToolResultToToolResultBlockParam**` — `AgentTool.tsx` L1298+


| 场景             | 返回内容                                                 |
| -------------- | ---------------------------------------------------- |
| 同步完成           | `status: 'completed'` + Agent 文本结果 + agentId + usage |
| 异步启动           | `status: 'async_launched'` + agentId + outputFile 路径 |
| One-shot Agent | 省略 agentId/SendMessage/usage 尾部                      |


---

## 6. 上下文隔离机制

**文件：** `src/utils/forkedAgent.ts` L345-462

`createSubagentContext()` 是隔离的核心，从父 `ToolUseContext` 创建独立的子上下文：

```typescript
function createSubagentContext(
  parentContext: ToolUseContext,
  overrides?: SubagentContextOverrides,
): ToolUseContext {
  return {
    // ===== 默认隔离 =====
    readFileState: cloneFileStateCache(parent),     // 克隆文件状态
    abortController: createChildAbortController(),  // 新的 abort 控制器
    setAppState: () => {},                          // 默认 no-op
    localDenialTracking: createDenialTrackingState(), // 独立拒绝追踪
    nestedMemoryAttachmentTriggers: new Set(),      // 新的触发器集合
    toolDecisions: undefined,
    contentReplacementState: clone(parent),          // 克隆替换状态
    
    // ===== UI 回调 — 子 Agent 无法控制父 UI =====
    addNotification: undefined,
    setToolJSX: undefined,
    setStreamMode: undefined,
    
    // ===== 可选共享 =====
    // shareSetAppState: true → 同步 Agent 可更新共享状态
    // shareAbortController: true → 交互式 Agent 共享中止
    // shareSetResponseLength: true → 共享响应长度追踪
    
    // ===== 始终共享 =====
    setAppStateForTasks: parent.setAppStateForTasks, // 任务注册必须到达根
    updateAttributionState: parent.updateAttributionState,
    queryTracking: { depth: parent.depth + 1 },     // 深度递增
  }
}
```

**隔离等级策略：**


| 场景                  | setAppState | abortController | 说明    |
| ------------------- | ----------- | --------------- | ----- |
| 异步后台 Agent          | no-op       | 新建 child        | 完全隔离  |
| 同步 Agent            | 共享          | 新建 child        | 可更新状态 |
| Fork Agent          | 共享          | 共享              | 缓存对齐  |
| In-process Teammate | 共享          | 共享              | 交互式   |


---

## 7. 工具过滤与权限系统

工具过滤分为四层：

### Layer 1：全局禁止列表

**文件：** `src/constants/tools.js` L36-111

```javascript
ALL_AGENT_DISALLOWED_TOOLS = [
  'Agent',           // 防止递归（ant 用户除外）
  'Task',            // 遗留名称
  'AskUserQuestion',
  'TaskStop',
  // ...plan mode 工具
]
ASYNC_AGENT_ALLOWED_TOOLS = [/* 后台 Agent 允许的工具子集 */]
```

### Layer 2：filterToolsForAgent()

**文件：** `agentToolUtils.ts` L70-116

```typescript
function filterToolsForAgent({ tools, isBuiltIn, isAsync, permissionMode }) {
  return tools.filter(tool => {
    if (tool.name.startsWith('mcp__')) return true           // MCP 工具始终通过
    if (ALL_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    if (!isBuiltIn && CUSTOM_AGENT_DISALLOWED_TOOLS.has(tool.name)) return false
    if (isAsync && !ASYNC_AGENT_ALLOWED_TOOLS.has(tool.name)) return false
    return true
  })
}
```

### Layer 3：resolveAgentTools()

**文件：** `agentToolUtils.ts` L122-224

处理通配符扩展 `['*']`、明确工具列表验证、`disallowedTools` 过滤，以及 `Agent(type1,type2)` 嵌套 Agent 类型允许列表。

### Layer 4：assembleToolPool()

在 `AgentTool.call()` 中为 worker 组装独立的工具池，使用 worker 自身的 `permissionMode`（而非父级的限制）。

Fork 路径例外：直接复用父 Agent 的工具池 (`useExactTools: true`)，确保 API 请求前缀字节一致以命中 prompt cache。

---

## 8. 模型选择逻辑

**文件：** `src/utils/model/agent.ts` L37-121

```
优先级（高 → 低）：
1. 环境变量 CLAUDE_CODE_SUBAGENT_MODEL
2. 工具参数 model（'sonnet' | 'opus' | 'haiku'）
3. AgentDefinition.model
4. 默认值 'inherit'（继承父模型）
```

**特殊逻辑：**

- `aliasMatchesParentTier`: 如果 subagent 请求 `opus` 而父模型已是 opus 级别，保持父模型字符串避免降级
- Bedrock: 继承父模型的 region 前缀以保持 IAM 对齐
- Fork 路径: `model: undefined`，子 Agent 匹配父缓存

---

## 9. Fork Subagent 实验

**核心文件：**
- `src/tools/AgentTool/forkSubagent.ts` — Fork Agent 定义、消息构建、防递归
- `src/utils/forkedAgent.ts` — 通用 fork 执行引擎 + CacheSafeParams + 上下文隔离

Fork 是一个实验性的 subagent 路径，当 `subagent_type` 为空时触发。其核心设计目标是 **最大化 Anthropic API prompt cache 命中率**。

### 9.1 启用条件

```typescript
// forkSubagent.ts:32-39
function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    if (isCoordinatorMode()) return false    // 与 Coordinator 互斥
    if (getIsNonInteractiveSession()) return false  // SDK 模式不可用
    return true
  }
  return false
}
```

### 9.2 FORK_AGENT 定义

```typescript
// forkSubagent.ts:60-71
const FORK_AGENT = {
  agentType: 'fork',
  tools: ['*'],               // 全部工具
  maxTurns: 200,              // 高上限
  model: 'inherit',           // 继承父模型（上下文长度对齐）
  permissionMode: 'bubble',   // 权限提示冒泡到父终端
  getSystemPrompt: () => '',  // ← 从不调用！使用 override.systemPrompt
} satisfies BuiltInAgentDefinition
```

**关键设计**：`getSystemPrompt` 返回空字符串，因为 fork 路径通过 `override.systemPrompt` 直接使用父 Agent 的**已渲染**系统提示词字节。重新调用 `getSystemPrompt()` 可能因 GrowthBook 状态差异（cold → warm）产生不同字节，破坏 prompt cache。

### 9.3 Prompt Cache 对齐策略详解

Anthropic API 的 prompt cache key 由以下元素组成：**system prompt + tools + model + messages prefix + thinking config**。Fork 子 Agent 必须在这五个维度上与父 Agent 产生**字节相同的 API 请求前缀**，才能命中父 Agent 的缓存。

#### 9.3.1 CacheSafeParams — 缓存安全参数

```typescript
// forkedAgent.ts:57-68
export type CacheSafeParams = {
  systemPrompt: SystemPrompt         // 必须与父一致
  userContext: { [k: string]: string }  // 预追加到消息，影响缓存
  systemContext: { [k: string]: string } // 追加到 system prompt，影响缓存
  toolUseContext: ToolUseContext       // 包含 tools、model 和其他选项
  forkContextMessages: Message[]       // 父上下文消息（构成 prefix）
}
```

**CacheSafeParams 的保存时机**：在每轮 `handleStopHooks` 结束后保存到全局 slot：

```typescript
// stopHooks.ts:96-98 + forkedAgent.ts:73-81
if (querySource === 'repl_main_thread' || querySource === 'sdk') {
  saveCacheSafeParams(createCacheSafeParams(stopHookContext))
}
// 后续的 promptSuggestion、autoDream、/btw 等 fork 任务
// 通过 getLastCacheSafeParams() 获取，无需每个调用者手动传递
```

#### 9.3.2 五维度对齐策略

```
┌──────────────────────────────────────────────────────────────────────┐
│              Anthropic API Prompt Cache Key 组成                      │
├────────────────┬─────────────────────────────────────────────────────┤
│ 1. System      │ override.systemPrompt = 父的已渲染系统提示词字节         │
│    Prompt      │ 不重新调用 getSystemPrompt()，避免 GrowthBook 差异      │
├────────────────┼─────────────────────────────────────────────────────┤
│ 2. Tools       │ useExactTools: true → 直接复用父的工具定义对象             │
│                │ 不经过 resolveAgentTools()，保持字节一致                 │
├────────────────┼─────────────────────────────────────────────────────┤
│ 3. Model       │ model: 'inherit' → getAgentModel() 返回父模型字符串     │
│                │ aliasMatchesParentTier: 避免"opus"降级到不同字符串        │
├────────────────┼─────────────────────────────────────────────────────┤
│ 4. Messages    │ [...forkContextMessages, ...forkedMessages]          │
│    Prefix      │ forkContextMessages = 父的完整消息历史                   │
│                │ forkedMessages = buildForkedMessages() 构建的尾部       │
│                │ 所有 fork 子 Agent 的 tool_result 使用相同占位文本        │
│                │ → 只有最后一个 text block（directive）不同               │
├────────────────┼─────────────────────────────────────────────────────┤
│ 5. Thinking    │ useExactTools → 继承父的 thinkingConfig                │
│    Config      │ 普通 subagent: { type: 'disabled' } → 不同 key         │
│                │ maxOutputTokens 会 clamp budget_tokens → 也影响 key    │
└────────────────┴─────────────────────────────────────────────────────┘
```

#### 9.3.3 消息前缀构建

```typescript
// forkSubagent.ts:107-169
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // 1. 克隆 assistant message，保留所有内容（thinking, text, tool_use）
  const fullAssistantMessage = { ...assistantMessage, uuid: randomUUID(), ... }

  // 2. 为每个 tool_use 构建 tool_result，全部使用相同占位文本
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result',
    tool_use_id: block.id,
    content: [{ type: 'text', text: FORK_PLACEHOLDER_RESULT }],
    //                              ↑ 所有 fork 子 Agent 完全相同
  }))

  // 3. 构建单个 user message：所有占位结果 + 每个子 Agent 不同的 directive
  return [fullAssistantMessage, createUserMessage({
    content: [
      ...toolResultBlocks,                          // ← 字节相同
      { type: 'text', text: buildChildMessage(directive) },  // ← 只有这里不同
    ],
  })]
}
```

**缓存命中的数学**：假设父消息历史有 100K tokens，fork 的 directive 只有 200 tokens。那么 99.8% 的请求前缀是缓存命中的（以 cache_read 价格计费），只有最后 0.2% 需要全价计算。

#### 9.3.4 ContentReplacementState 克隆

```typescript
// forkedAgent.ts:389-403
contentReplacementState:
  overrides?.contentReplacementState ??
  (parentContext.contentReplacementState
    ? cloneContentReplacementState(parentContext.contentReplacementState)
    : undefined),
```

克隆而非新建：cache-sharing fork 处理父消息中包含的 tool_use_id。新建状态会对这些 ID 做出不同的替换决策 → wire prefix 不同 → cache miss。克隆保证做出相同决策 → cache hit。

### 9.4 Fork 子 Agent 的指令模板

```typescript
// forkSubagent.ts:171-198
function buildChildMessage(directive: string): string {
  return `<fork_boilerplate>
STOP. READ THIS FIRST.
You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. 你的系统提示说"默认 fork"。忽略它——那是给父 Agent 的。你就是 fork。
2. 不要对话、提问或建议下一步
3. 不要添加评论
4. 直接使用工具：Bash, Read, Write 等
5. 如果修改了文件，在报告前提交变更，包含 commit hash
6. 工具调用之间不要输出文本。静默执行，最后报告一次
7. 严格在指令范围内工作
8. 报告控制在 500 词以内
9. 回复必须以 "Scope:" 开头
10. 报告结构化事实，然后停止

Output format:
  Scope: <一句话回显你的任务范围>
  Result: <答案或关键发现>
  Key files: <相关文件路径>
  Files changed: <列表 + commit hash>
  Issues: <如有问题需标记>
</fork_boilerplate>

<fork_directive>YOUR TASK: ${directive}`
}
```

### 9.5 防递归机制

Fork 子 Agent 保留 Agent 工具（为了 cache-identical 工具定义），但通过消息历史中的标签检测防止再次 fork：

```typescript
// forkSubagent.ts:78-89
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    if (m.type !== 'user') return false
    const content = m.message.content
    if (!Array.isArray(content)) return false
    return content.some(
      block => block.type === 'text' && block.text.includes(`<fork_boilerplate>`),
    )
  })
}
```

注意：不能简单地从工具池中移除 Agent 工具来防递归——那会导致工具定义不同 → 缓存失效。所以在调用时检查消息历史来拒绝。

### 9.6 runForkedAgent — 通用 Fork 执行引擎

`runForkedAgent()` 不只服务于 Fork Subagent，也被以下后台任务使用：

| 调用者 | querySource | 目的 |
|--------|-------------|------|
| **Prompt Suggestion** | `prompt_suggestion` | 生成下一步提示建议 |
| **Extract Memories** | `extract_memories` | 提取会话记忆 |
| **Auto Dream** | `auto_dream` | 自动梦境（反思） |
| **Session Memory** | `session_memory` | 会话记忆提取 |
| **Agent Summary** | `agent_summary` | 后台 agent 周期性摘要 |
| **Compact** | `compact` | 上下文压缩 |
| **Fork Subagent** | `agent:builtin:fork` | 用户发起的 fork |

```typescript
// forkedAgent.ts:489-626
export async function runForkedAgent({
  promptMessages,
  cacheSafeParams,    // ← 必须与父一致的参数
  canUseTool,
  querySource,
  forkLabel,          // 用于分析标签
  maxOutputTokens,    // ⚠️ 设置此值会改变 budget_tokens → cache key 变化
  maxTurns,
  skipTranscript,     // 临时任务可跳过 transcript
  skipCacheWrite,     // fire-and-forget fork 跳过缓存写入
}: ForkedAgentParams): Promise<ForkedAgentResult> {
  // 1. 创建隔离上下文
  const isolatedToolUseContext = createSubagentContext(toolUseContext, overrides)
  
  // 2. 拼接消息：[...父消息历史, ...新 prompt]
  //    注意：不调用 filterIncompleteToolCalls，因为 ensureToolResultPairing
  //    在 claude.ts 中下游修复 → 保持相同的修复前缀 → cache hit
  const initialMessages = [...forkContextMessages, ...promptMessages]
  
  // 3. 运行 query() 循环
  for await (const message of query({
    messages: initialMessages,
    systemPrompt, userContext, systemContext,  // ← 来自 cacheSafeParams
    canUseTool,
    toolUseContext: isolatedToolUseContext,
    querySource,
    maxOutputTokensOverride: maxOutputTokens,
    maxTurns,
    skipCacheWrite,
  })) {
    // 累积 usage 统计
  }
  
  // 4. 计算 cacheHitRate 并记录分析事件
  logForkAgentQueryEvent({ forkLabel, cacheHitRate, ... })
  
  return { messages: outputMessages, totalUsage }
}
```

**maxOutputTokens 的缓存风险**：

```typescript
// forkedAgent.ts:97-102
/**
 * Optional cap on output tokens. CAUTION: setting this changes both max_tokens
 * AND budget_tokens (via clamping in claude.ts). If the fork uses cacheSafeParams
 * to share the parent's prompt cache, a different budget_tokens will invalidate
 * the cache — thinking config is part of the cache key. Only set this when cache
 * sharing is not a goal (e.g., compact summaries).
 */
maxOutputTokens?: number
```

### 9.7 Worktree Fork

Fork 子 Agent 可在独立的 git worktree 中运行（`isolation: 'worktree'`）：

```typescript
// forkSubagent.ts:205-210
export function buildWorktreeNotice(parentCwd: string, worktreeCwd: string): string {
  return `你继承了父 Agent 在 ${parentCwd} 的上下文。
你在隔离的 git worktree ${worktreeCwd} 中运行——同一仓库，同一文件结构，独立工作副本。
上下文中的路径指向父目录；请转换到你的 worktree 根。
编辑前重新读取文件（父可能已修改）。
你的变更留在此 worktree，不影响父的文件。`
}
```

### 9.8 缓存命中率监控

```typescript
// forkedAgent.ts:647-654
const totalInputTokens =
  totalUsage.input_tokens +
  totalUsage.cache_creation_input_tokens +
  totalUsage.cache_read_input_tokens
const cacheHitRate =
  totalInputTokens > 0
    ? totalUsage.cache_read_input_tokens / totalInputTokens
    : 0
// → tengu_fork_agent_query 事件中记录
```

每次 fork 完成后计算并上报 `cacheHitRate`，用于监控对齐策略是否有效。

---

## 10. 异步 Agent 与通知机制

### 10.1 异步注册

**文件：** `src/tasks/LocalAgentTask/LocalAgentTask.tsx`

```typescript
registerAsyncAgent(taskId, {
  agentId, prompt, agentType, model,
  abortController, selectedAgent
})
```

### 10.2 生命周期管理

**文件：** `agentToolUtils.ts` L508+

```typescript
async function runAsyncAgentLifecycle({
  runAgentIterator, taskId, setAppState, ...
}) {
  try {
    for await (const message of runAgentIterator) {
      // 更新进度
      updateAsyncAgentProgress(taskId, message)
    }
    // 完成
    completeAsyncAgent(taskId)
    const result = finalizeAgentTool(messages)
    enqueueAgentNotification({ status: 'completed', finalMessage: result })
  } catch (error) {
    if (error instanceof AbortError) {
      killAsyncAgent(taskId)
      enqueueAgentNotification({ status: 'killed' })
    } else {
      failAsyncAgent(taskId, error)
      enqueueAgentNotification({ status: 'failed', error })
    }
  }
}
```

### 10.3 通知投递

`enqueueAgentNotification()` 构建 XML 格式的通知消息：

```xml
<task-notification>
  <task_id>{taskId}</task_id>
  <tool_use_id>{toolUseId}</tool_use_id>
  <output_file>{outputPath}</output_file>
  <status>completed|failed|killed</status>
  <summary>Agent "description" completed</summary>
  <result>{finalMessage}</result>
  <usage>
    <total_tokens>...</total_tokens>
    <tool_uses>...</tool_uses>
    <duration_ms>...</duration_ms>
  </usage>
</task-notification>
```

通知通过 `enqueuePendingNotification({ mode: 'task-notification' })` 排队，在父 Agent 的下一个 `query()` 迭代中被消费。

### 10.4 父线程接收

**文件：** `src/query.ts` L1560-1578

`query()` 循环在每次迭代前排空队列，确保正确的 `agentId` 接收到对应的 task-notification。

---

## 11. Agent 恢复（Resume）机制

**文件：** `src/tools/AgentTool/resumeAgent.ts`

### 11.1 触发路径

```
SendMessageTool → 目标是 agentId 或注册名称
  ├── 运行中的任务 → queuePendingMessage()（排队等工具边界消费）
  └── 已停止/缺失的任务 → resumeAgentBackground()
```

### 11.2 恢复流程

```typescript
async function resumeAgentBackground({ agentId, prompt, toolUseContext, canUseTool }) {
  // 1. 加载 transcript 和 metadata
  const [transcript, meta] = await Promise.all([
    getAgentTranscript(asAgentId(agentId)),
    readAgentMetadata(asAgentId(agentId)),
  ])
  
  // 2. 清理消息
  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages)
    )
  )
  
  // 3. 重建内容替换状态（prompt cache 稳定性）
  const resumedReplacementState = reconstructForSubagentResume(
    parentState, resumedMessages, transcript.contentReplacements
  )
  
  // 4. 恢复工作目录（如果 worktree 存在）
  // 5. 确定 Agent 定义（fork vs named vs fallback general-purpose）
  // 6. 合并 resume 用户消息
  // 7. 调用 runAgent() 继续执行
  
  return runWithAgentContext({
    agentId, agentType: 'subagent',
    invocationKind: 'resume',  // 标记为恢复而非新建
  }, () => {
    registerAsyncAgent(...)
    runAsyncAgentLifecycle(...)
  })
}
```

### 11.3 消息排队

运行中的 Agent 接收 `SendMessage` 时：

```typescript
// LocalAgentTask.tsx L162-167
function queuePendingMessage(taskId, msg, setAppState) {
  updateTaskState(taskId, setAppState, task => ({
    ...task,
    pendingMessages: [...task.pendingMessages, msg]
  }))
}

// 在工具边界被消费
function drainPendingMessages(taskId, getAppState, setAppState): string[] {
  // 原子性地取出并清空 pendingMessages
}
```

---

## 12. Transcript 存储与管理

**文件：** `src/utils/sessionStorage.ts`

### 12.1 存储路径

```
{projectDir}/{sessionId}/subagents/[optional subdir/]agent-{agentId}.jsonl   # 消息
{projectDir}/{sessionId}/subagents/[optional subdir/]agent-{agentId}.meta.json # 元数据
```

### 12.2 写入

```typescript
recordSidechainTranscript(agentId, message)
// → insertMessageChain(..., { isSidechain: true, agentId, startingParentUuid })
```

每条可记录的消息通过 `runAgent` 循环中写入 JSONL 文件。

### 12.3 读取

```typescript
getAgentTranscript(agentId)
// → 加载 JSONL，过滤 agentId + isSidechain
// → 从叶节点重建消息链
// → 返回 { messages, contentReplacements }
```

### 12.4 元数据

```typescript
writeAgentMetadata(agentId, {
  agentType: string,
  worktreePath?: string,
  description?: string,
})

readAgentMetadata(agentId) // 恢复时使用
```

---

## 13. Worktree 隔离

**文件：** `src/utils/worktree.ts`

```typescript
// 创建 — isolation: 'worktree'
createAgentWorktree(slug)
// → git worktree add .claude/worktrees/{slug}
// → 不改变主会话的全局 cwd

// Agent 执行期间
runWithCwdOverride(worktreePath, () => runAgent(...))

// 清理
removeAgentWorktree(worktreePath)
cleanupWorktreeIfNeeded()  // AgentTool finally 路径

// 恢复时检查
if (meta.worktreePath && await dirExists(meta.worktreePath)) {
  // 使用原 worktree
} else {
  // 回退到当前 cwd
}
```

---

## 14. 关键代码文件索引


| 文件路径                                           | 职责                                                      | 关键行号/函数                                                                    |
| ---------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/tools/AgentTool/AgentTool.tsx`            | 工具定义、`call()` 入口、同步/异步分支、结果映射                           | L82(schema), L196(注册), L239(call), L1298(结果映射)                             |
| `src/tools/AgentTool/constants.ts`             | 名称常量、One-shot 类型                                        | L1-12                                                                      |
| `src/tools/AgentTool/runAgent.ts`              | Subagent 查询循环、transcript 记录、指标转发                        | L248(runAgent), L340(模型), L747(query循环)                                    |
| `src/tools/AgentTool/agentToolUtils.ts`        | 工具过滤、finalizeAgentTool、异步生命周期、Handoff 分类                | L70(filterTools), L122(resolveTools), L276(finalize), L508(asyncLifecycle) |
| `src/tools/AgentTool/loadAgentsDir.ts`         | AgentDefinition 类型、Agent 加载与合并                          | L105(类型), L296(getAgentDefinitionsWithOverrides)                           |
| `src/tools/AgentTool/builtInAgents.ts`         | 内置 Agent 列表组装                                           | L22(getBuiltInAgents)                                                      |
| `src/tools/AgentTool/built-in/*.ts`            | 各内置 Agent 定义（系统提示词、工具限制、模型选择）                           | 见各文件                                                                       |
| `src/tools/AgentTool/forkSubagent.ts`          | Fork 实验：FORK_AGENT、消息构建、缓存对齐                            | L32(gate), L60(FORK_AGENT), L91(buildForkedMessages)                       |
| `src/tools/AgentTool/resumeAgent.ts`           | Agent 恢复：加载 transcript、重建状态、继续执行                        | L42(resumeAgentBackground)                                                 |
| `src/tools/AgentTool/prompt.ts`                | Agent 工具描述文本、Agent 列表格式化                                | L66(getPrompt)                                                             |
| `src/utils/forkedAgent.ts`                     | `createSubagentContext`、`runForkedAgent`                | L345(createSubagentContext)                                                |
| `src/utils/agentContext.ts`                    | `AsyncLocalStorage`、SubagentContext、runWithAgentContext | L28(类型), L93(storage), L108(run)                                           |
| `src/utils/model/agent.ts`                     | 模型解析：环境变量 → 工具参数 → 定义 → 默认                              | L37(getAgentModel)                                                         |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx`  | 异步任务注册、通知排队、pending 消息、任务终止                             | L116(state), L162(queue), L197(notify)                                     |
| `src/utils/sessionStorage.ts`                  | Transcript 读写、元数据持久化                                    | recordSidechainTranscript, getAgentTranscript, writeAgentMetadata          |
| `src/utils/worktree.ts`                        | Git worktree 创建/删除                                      | createAgentWorktree, removeAgentWorktree                                   |
| `src/query.ts`                                 | 主查询循环、task-notification 消费                              | L1560(通知排空)                                                                |
| `src/tools/SendMessageTool/SendMessageTool.ts` | 消息路由到运行中/已停止的 Agent                                     | L800(路由逻辑)                                                                 |
| `src/constants/tools.js`                       | 全局工具禁止列表                                                | L36(ALL_AGENT_DISALLOWED_TOOLS)                                            |


---

## 15. 端到端流程图

### 同步 Subagent 流程

```
用户输入
  │
  ▼
主 Agent query() 循环
  │
  ▼ 模型输出 tool_use: Agent({prompt, subagent_type: "Explore"})
  │
AgentTool.call()
  ├── 解析 subagent_type → EXPLORE_AGENT
  ├── 组装工具池 assembleToolPool(permissionMode)
  ├── 构建系统提示词 getSystemPrompt()
  ├── 构建用户消息 createUserMessage(prompt)
  │
  ▼
runAgent()
  ├── createSubagentContext() → 隔离的 ToolUseContext
  ├── getAgentModel() → 解析模型
  ├── writeAgentMetadata() → 持久化元数据
  ├── runWithAgentContext() → 设置 AsyncLocalStorage
  │
  ▼
  query() 循环（共享主循环，隔离上下文）
  ├── API 调用 → 流式响应
  ├── 工具执行（受限工具集）
  ├── recordSidechainTranscript() → 写入 JSONL
  └── yield 完成的消息
  │
  ▼
AgentTool.call() 消费迭代器
  ├── finalizeAgentTool() → 提取结果
  ├── mapToolResultToToolResultBlockParam() → 格式化
  └── 返回 tool_result 给父 Agent
  │
  ▼
主 Agent 继续处理
```

### 异步 Subagent 流程

```
用户输入
  │
  ▼
主 Agent query() 循环
  │
  ▼ 模型输出 tool_use: Agent({prompt, run_in_background: true})
  │
AgentTool.call()
  ├── registerAsyncAgent() → 注册后台任务
  ├── runAsyncAgentLifecycle() → 异步启动（fire-and-forget）
  └── 立即返回 {status: 'async_launched', agentId, outputFile}
  │
  ▼
主 Agent 继续其他工作
  │                                    ┌─────────────────────────┐
  │                                    │ 后台 Agent 执行中...     │
  │                                    │  runAgent() → query()   │
  │                                    │  工具执行、transcript 写入│
  │                                    │  完成/失败/被终止        │
  │                                    │         │               │
  │                                    │         ▼               │
  │                                    │ enqueueAgentNotification│
  │                                    │   → XML task-notification│
  │                                    └─────────┬───────────────┘
  │                                              │
  ▼                                              ▼
主 Agent 下一次 query() 迭代
  ├── 排空通知队列
  ├── 注入 <task-notification> 消息
  ├── 模型处理通知并决定下一步
  └── 可通过 SendMessage 继续与 Agent 交互
```

### Resume 流程

```
SendMessageTool({to: agentId, content: "继续执行..."})
  │
  ├── 检查 agentId 是否运行中
  │   ├── 是 → queuePendingMessage() → 在工具边界被消费
  │   └── 否 → resumeAgentBackground()
  │            ├── getAgentTranscript() → 加载 JSONL
  │            ├── readAgentMetadata() → 恢复类型/路径
  │            ├── 消息清理（孤立思考、未解析工具调用）
  │            ├── reconstructForSubagentResume() → 重建替换状态
  │            ├── registerAsyncAgent() → 重新注册
  │            └── runAsyncAgentLifecycle() → 继续执行
  │
  ▼
通知回传（同异步流程）
```

---

## 附录：设计决策要点

1. **无 SubAgent 类**：Agent 通过 `AgentDefinition` 配置 + `runAgent()` 执行 + `createSubagentContext()` 隔离的组合模式实现，而非面向对象的类继承
2. **共享 query() 循环**：subagent 和主 Agent 运行相同的查询循环代码，仅通过 `ToolUseContext` 差异化行为
3. **AsyncLocalStorage vs AppState**：并发 Agent 场景下，`AsyncLocalStorage` 提供执行链级别的隔离，避免全局状态污染
4. **Prompt Cache 优先**：Fork 路径的几乎每个设计决策都围绕字节一致性展开，以最大化 API prompt cache 命中率
5. **分层工具过滤**：4 层过滤机制确保安全性（防递归、限制写入、限制后台操作），同时保持灵活性
6. **ONE_SHOT 优化**：Explore/Plan 类型跳过 resume 相关信息，在 34M+ 周调用量级下显著节省 token
7. **Token 节省策略**：Explore/Plan 省略 CLAUDE.md（5-15 Gtok/week）和 gitStatus（1-3 Gtok/week），这些信息对只读搜索 Agent 无用
8. **Thinking 成本控制**：普通 subagent 禁用 extended thinking 以控制 output token 成本，只有 fork 路径为了 prompt cache 命中继承父配置
9. **三源 Agent 定义**：Built-in（代码）、Plugin（扩展）、Custom（.md/.json），后者覆盖前者的同名定义，实现灵活的定制层次
10. **Agent 专属 MCP**：每个 Agent 可定义自己的 MCP 服务器，启动时连接、结束时自动清理，实现了 Agent 级别的工具扩展

