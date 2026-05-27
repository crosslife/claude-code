# Agent Loop 核心算法流程分析

## 概述

Claude Code 的 **Agent Loop**（又称 Query Loop / Agentic Loop）是整个系统的核心运行引擎。它实现了一个 **「模型调用 → 流式响应 → 工具执行 → 消息追加 → 递归下一轮」** 的自动循环，直到模型不再发起 `tool_use`、达到 `maxTurns`、或被 stop hook 终止。

核心实现位于 `src/query.ts`，是一个 **1730 行的单文件**，包含两个关键函数：
- `query()` — 对外公开的 AsyncGenerator API（L219-L239）
- `queryLoop()` — 内部 `while(true)` 主循环（L241-L1729）

## 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                          入口层                                      │
│  REPL.tsx │ QueryEngine.ts │ print.ts │ AgentTool │ forkedAgent     │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  query() — 对外 AsyncGenerator 封装 (src/query.ts:219)              │
│  • yield* queryLoop()                                               │
│  • 正常结束时通知 command lifecycle (completed)                       │
└──────────────┬──────────────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  queryLoop() — while(true) 主循环 (src/query.ts:241)                │
│                                                                      │
│  每次迭代（一个 Turn）包含以下阶段：                                    │
│                                                                      │
│  ┌─ Phase 1: 预处理 ─────────────────────────────────────────────┐  │
│  │  1a. Skill Discovery 预取                                      │  │
│  │  1b. Tool Result Budget 控制                                   │  │
│  │  1c. Snip Compact (历史裁剪)                                   │  │
│  │  1d. Microcompact (微压缩)                                     │  │
│  │  1e. Context Collapse (上下文折叠)                              │  │
│  │  1f. AutoCompact (自动压缩)                                    │  │
│  │  1g. Token 阻塞限制检查                                        │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─ Phase 2: 模型调用 ─────────────────────────────────────────────┐  │
│  │  2a. 流式调用 deps.callModel (queryModelWithStreaming)           │  │
│  │  2b. 收集 assistant messages + tool_use blocks                  │  │
│  │  2c. 流式工具执行 (StreamingToolExecutor)                       │  │
│  │  2d. Fallback 模型切换                                          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─ Phase 3: 后处理 ─────────────────────────────────────────────┐  │
│  │  3a. Post-sampling hooks                                       │  │
│  │  3b. 中断检查 (aborted)                                        │  │
│  │  3c. 错误恢复 (413/max_output_tokens/media_error)              │  │
│  │  3d. Stop hooks + memory/dream/suggestion fork                 │  │
│  │  3e. Token Budget 检查                                         │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─ Phase 4: 工具执行 (当 needsFollowUp=true) ──────────────────┐  │
│  │  4a. 串行/并行工具执行 (runTools / StreamingToolExecutor)       │  │
│  │  4b. Hook 阻止继续检查                                         │  │
│  │  4c. Attachment 注入 (memory/file changes/queued commands)      │  │
│  │  4d. Memory 预取消费                                            │  │
│  │  4e. Skill Discovery 注入                                       │  │
│  │  4f. MCP Tools 刷新                                             │  │
│  │  4g. maxTurns 检查                                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  state = next → continue (回到 while 顶部)                          │
│       或 return { reason: '...' } (终止循环)                         │
└─────────────────────────────────────────────────────────────────────┘
```

## 核心数据结构

### QueryParams — 循环不可变参数

```typescript
// src/query.ts:181-199
export type QueryParams = {
  messages: Message[]               // 初始消息数组
  systemPrompt: SystemPrompt        // 系统提示词
  userContext: { [k: string]: string }   // 用户上下文
  systemContext: { [k: string]: string } // 系统上下文
  canUseTool: CanUseToolFn          // 工具权限判断函数
  toolUseContext: ToolUseContext     // 工具使用上下文（运行时共享状态）
  fallbackModel?: string            // 备用模型名
  querySource: QuerySource          // 查询来源（repl/sdk/agent:* 等）
  maxOutputTokensOverride?: number  // 输出 token 上限覆盖
  maxTurns?: number                 // 最大循环轮数
  skipCacheWrite?: boolean          // 是否跳过缓存写入
  taskBudget?: { total: number }    // API task_budget
  deps?: QueryDeps                  // 可注入依赖
}
```

### State — 跨迭代可变状态

```typescript
// src/query.ts:204-217
type State = {
  messages: Message[]                    // 当前消息数组（每轮追加）
  toolUseContext: ToolUseContext          // 工具上下文（可被工具执行修改）
  autoCompactTracking: AutoCompactTrackingState | undefined  // 自动压缩追踪
  maxOutputTokensRecoveryCount: number   // max_output_tokens 恢复次数
  hasAttemptedReactiveCompact: boolean   // 是否已尝试响应式压缩
  maxOutputTokensOverride: number | undefined  // 输出 token 覆盖
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined    // stop hook 是否激活
  turnCount: number                      // 当前轮次计数
  transition: Continue | undefined       // 上一次迭代的继续原因
}
```

### QueryDeps — 可注入依赖

```typescript
// src/query/deps.ts:21-31
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming   // 模型调用
  microcompact: typeof microcompactMessages  // 微压缩
  autocompact: typeof autoCompactIfNeeded    // 自动压缩
  uuid: () => string                         // UUID 生成
}
```

### QueryConfig — 入口快照配置

```typescript
// src/query/config.ts:15-27
export type QueryConfig = {
  sessionId: SessionId
  gates: {
    streamingToolExecution: boolean    // 流式工具执行开关
    emitToolUseSummaries: boolean      // 工具使用摘要
    isAnt: boolean                     // 是否 Anthropic 内部用户
    fastModeEnabled: boolean           // 快速模式
  }
}
```

## Phase 1: 预处理阶段（上下文准备）

每轮循环开始前，系统需要对消息上下文进行多层压缩和裁剪，确保不超出模型上下文窗口。这些操作形成一条 **压缩管线（Compaction Pipeline）**，按顺序执行：

### 1a. Skill Discovery 预取

```typescript
// src/query.ts:331-335
const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
  null, messages, toolUseContext,
)
```

异步预取 skill 发现结果。在模型流式输出和工具执行期间并行运行，结果在 Phase 4 注入。

### 1b. Tool Result Budget

```typescript
// src/query.ts:379-394
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements ? records => void recordContentReplacement(...) : undefined,
  new Set(toolUseContext.options.tools.filter(t => !Number.isFinite(t.maxResultSizeChars)).map(t => t.name)),
)
```

对每条消息中的工具结果大小进行预算控制，超出限制的内容被替换为引用。在 microcompact 之前运行，两者可组合。

### 1c. Snip Compact

```typescript
// src/query.ts:401-410
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
}
```

历史裁剪——移除早期不再需要的消息片段，释放 token 空间。

### 1d. Microcompact

```typescript
// src/query.ts:414-426
const microcompactResult = await deps.microcompact(
  messagesForQuery, toolUseContext, querySource,
)
messagesForQuery = microcompactResult.messages
```

微压缩——对工具结果进行细粒度的内容缩减（如移除冗余输出），支持缓存编辑模式。

### 1e. Context Collapse

```typescript
// src/query.ts:440-447
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery, toolUseContext, querySource,
  )
  messagesForQuery = collapseResult.messages
}
```

上下文折叠——将历史消息折叠为摘要。在 autocompact 之前执行，如果折叠已经将上下文缩减到阈值以下，autocompact 就不再触发。

### 1f. AutoCompact

```typescript
// src/query.ts:454-543
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery, toolUseContext,
  { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: messagesForQuery },
  querySource, tracking, snipTokensFreed,
)
if (compactionResult) {
  // 更新 task_budget, tracking, yield 压缩后消息
  messagesForQuery = buildPostCompactMessages(compactionResult)
}
```

自动全量压缩——当消息数量/token 达到阈值时，fork 一个子 agent 生成完整摘要。

### 1g. Token 阻塞限制

```typescript
// src/query.ts:628-648
if (!compactionResult && querySource !== 'compact' && ...) {
  const { isAtBlockingLimit } = calculateTokenWarningState(
    tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
    toolUseContext.options.mainLoopModel,
  )
  if (isAtBlockingLimit) {
    yield createAssistantAPIErrorMessage({ content: PROMPT_TOO_LONG_ERROR_MESSAGE, error: 'invalid_request' })
    return { reason: 'blocking_limit' }
  }
}
```

硬阻塞检查——在 auto-compact 关闭时生效，预留空间给手动 `/compact`。

**压缩管线的执行顺序和设计原则：**

```
Tool Result Budget → Snip → Microcompact → Context Collapse → AutoCompact → Blocking Check
   ↑细粒度            ↑裁剪    ↑缩减          ↑折叠              ↑全量摘要      ↑最终防线
```

每一层更"重"的压缩只在前面轻量级压缩不够时才需要触发。

## Phase 2: 模型调用阶段

### 2a. 流式 API 调用

```typescript
// src/query.ts:659-708
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    fallbackModel,
    querySource,
    maxOutputTokensOverride,
    taskBudget: { total, remaining },
    // ... 其他配置
  },
})) {
```

调用 `queryModelWithStreaming`，返回一个流式 AsyncGenerator，产出类型为 `AssistantMessage | StreamEvent`。

### 2b. 消息收集与 tool_use 检测

```typescript
// src/query.ts:826-845
if (message.type === 'assistant') {
  assistantMessages.push(message)
  const msgToolUseBlocks = message.message.content.filter(
    content => content.type === 'tool_use',
  ) as ToolUseBlock[]
  if (msgToolUseBlocks.length > 0) {
    toolUseBlocks.push(...msgToolUseBlocks)
    needsFollowUp = true   // ← 关键标志：有 tool_use 则需要继续循环
  }
}
```

`needsFollowUp` 是决定循环是否继续的核心变量。当模型返回 `tool_use` block 时设为 `true`。

### 2c. 流式工具执行（StreamingToolExecutor）

```typescript
// src/query.ts:837-862
if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
  for (const toolBlock of msgToolUseBlocks) {
    streamingToolExecutor.addTool(toolBlock, message)
  }
  for (const result of streamingToolExecutor.getCompletedResults()) {
    if (result.message) {
      yield result.message
      toolResults.push(...)
    }
  }
}
```

这是一个重要的优化：工具在流式接收过程中就开始执行，不需要等待模型完全输出。`StreamingToolExecutor` 管理并发控制：
- **并发安全的工具**（只读工具）可并行执行
- **非并发安全的工具**（写操作）必须独占执行
- 结果按接收顺序缓冲和产出

### 2d. Fallback 模型切换

```typescript
// src/query.ts:893-953
if (innerError instanceof FallbackTriggeredError && fallbackModel) {
  currentModel = fallbackModel
  attemptWithFallback = true
  // 清除之前的消息和工具执行
  assistantMessages.length = 0
  toolResults.length = 0
  toolUseBlocks.length = 0
  // 销毁旧的 StreamingToolExecutor
  streamingToolExecutor?.discard()
  streamingToolExecutor = new StreamingToolExecutor(...)
  continue  // 重试
}
```

当主模型不可用时自动切换到 fallback 模型。会产出 tombstone 消息清理孤立的中间消息。

### 错误消息扣留（Withholding）机制

```typescript
// src/query.ts:799-825
let withheld = false
if (feature('CONTEXT_COLLAPSE')) {
  if (contextCollapse?.isWithheldPromptTooLong(message, isPromptTooLongMessage, querySource)) {
    withheld = true
  }
}
if (reactiveCompact?.isWithheldPromptTooLong(message)) withheld = true
if (mediaRecoveryEnabled && reactiveCompact?.isWithheldMediaSizeError(message)) withheld = true
if (isWithheldMaxOutputTokens(message)) withheld = true
if (!withheld) yield yieldMessage
```

可恢复的错误（413 prompt-too-long、max_output_tokens、media_size_error）不会立即产出给调用方，而是先扣留，尝试恢复。只有恢复失败才会最终产出错误。

## Phase 3: 后处理阶段

### 3a. Post-sampling Hooks

```typescript
// src/query.ts:1000-1009
if (assistantMessages.length > 0) {
  void executePostSamplingHooks(
    [...messagesForQuery, ...assistantMessages],
    systemPrompt, userContext, systemContext, toolUseContext, querySource,
  )
}
```

模型响应完成后触发的 hooks，异步执行不阻塞主循环。

### 3b. 中断检查

```typescript
// src/query.ts:1015-1052
if (toolUseContext.abortController.signal.aborted) {
  // 清理流式工具执行器
  if (streamingToolExecutor) {
    for await (const update of streamingToolExecutor.getRemainingResults()) { ... }
  } else {
    yield* yieldMissingToolResultBlocks(assistantMessages, 'Interrupted by user')
  }
  // 跳过 submit-interrupt 的中断消息
  if (toolUseContext.abortController.signal.reason !== 'interrupt') {
    yield createUserInterruptionMessage({ toolUse: false })
  }
  return { reason: 'aborted_streaming' }
}
```

在流式输出期间被用户中断。需要为所有未完成的 `tool_use` block 补充 `tool_result`（合成错误消息），否则 API 会报错。

### 3c. 错误恢复（核心容错逻辑）

当 `needsFollowUp === false`（模型没有发起工具调用）时，进入恢复/终止路径：

**Prompt-too-long (413) 恢复链：**

```
413 withheld → Context Collapse Drain → Reactive Compact → Surface Error
     ↓                  ↓                     ↓                 ↓
  先尝试折叠       廉价,保留粒度       全量摘要,重试        恢复失败,报错
```

```typescript
// src/query.ts:1085-1183
// Step 1: Context Collapse Drain
if (feature('CONTEXT_COLLAPSE') && contextCollapse && state.transition?.reason !== 'collapse_drain_retry') {
  const drained = contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
  if (drained.committed > 0) {
    state = next  // transition: 'collapse_drain_retry'
    continue
  }
}
// Step 2: Reactive Compact
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({...})
  if (compacted) {
    state = next  // transition: 'reactive_compact_retry'
    continue
  }
  // 恢复失败 → 产出扣留的错误
  yield lastMessage
  return { reason: 'prompt_too_long' }
}
```

**Max Output Tokens 恢复链：**

```
max_output_tokens withheld → Escalate (8k→64k) → Multi-turn Recovery (×3) → Surface Error
         ↓                         ↓                       ↓                      ↓
     先不报错              同一请求升高上限          注入续写提示            恢复次数耗尽
```

```typescript
// src/query.ts:1188-1256
// Step 1: Escalate (一次性)
if (capEnabled && maxOutputTokensOverride === undefined) {
  state = { ...state, maxOutputTokensOverride: ESCALATED_MAX_TOKENS }
  continue  // transition: 'max_output_tokens_escalate'
}
// Step 2: Multi-turn recovery (最多3次)
if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
  const recoveryMessage = createUserMessage({
    content: `Output token limit hit. Resume directly — no apology, no recap...`,
    isMeta: true,
  })
  state = { messages: [..., recoveryMessage], maxOutputTokensRecoveryCount: count + 1 }
  continue  // transition: 'max_output_tokens_recovery'
}
// Step 3: 恢复耗尽 → 产出错误
yield lastMessage
```

### 3d. Stop Hooks

```typescript
// src/query.ts:1267-1306
const stopHookResult = yield* handleStopHooks(
  messagesForQuery, assistantMessages,
  systemPrompt, userContext, systemContext, toolUseContext, querySource, stopHookActive,
)

if (stopHookResult.preventContinuation) {
  return { reason: 'stop_hook_prevented' }
}
if (stopHookResult.blockingErrors.length > 0) {
  state = { messages: [..., ...stopHookResult.blockingErrors], stopHookActive: true }
  continue  // transition: 'stop_hook_blocking'
}
```

Stop hooks 在模型自然停止时执行（`src/query/stopHooks.ts`），包含：
1. **Stop hooks**：用户自定义的停止钩子，可返回 blocking error 强制模型继续
2. **副作用 fork 任务**：Prompt suggestion、Extract memories、Auto dream
3. **Teammate hooks**：TaskCompleted 和 TeammateIdle hooks
4. **Computer Use 清理**：释放浏览器锁

### 3e. Token Budget 检查

```typescript
// src/query.ts:1308-1355
if (feature('TOKEN_BUDGET')) {
  const decision = checkTokenBudget(budgetTracker!, ...)
  if (decision.action === 'continue') {
    incrementBudgetContinuationCount()
    state = { messages: [..., createUserMessage({ content: decision.nudgeMessage, isMeta: true })] }
    continue  // transition: 'token_budget_continuation'
  }
}
return { reason: 'completed' }
```

Token Budget 是一个 auto-continue 机制。当输出 token 未达到预算的 90% 时，注入 nudge 消息让模型继续。有递减回报检测：连续 3 次增量 < 500 token 时提前停止。

## Phase 4: 工具执行阶段

只有当 `needsFollowUp === true` 时（模型返回了 `tool_use`）才进入此阶段。

### 4a. 工具执行

有两种执行模式，取决于 `streamingToolExecution` 配置：

**StreamingToolExecutor（流式模式）：**

```typescript
// src/query.ts:1380-1408
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()     // 等待流式执行期间启动的工具完成
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)  // 传统批量模式

for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message
    if (update.message.attachment?.type === 'hook_stopped_continuation') {
      shouldPreventContinuation = true
    }
    toolResults.push(...)
  }
  if (update.newContext) {
    updatedToolUseContext = { ...update.newContext, queryTracking }
  }
}
```

**工具并发策略（toolOrchestration.ts）：**

```
partitionToolCalls() 将工具分批：
  ┌──────────────────────────┐
  │ Batch 1: Read + Grep     │  ← 连续的并发安全工具 → 并行执行
  ├──────────────────────────┤
  │ Batch 2: Write           │  ← 非并发安全工具 → 串行执行
  ├──────────────────────────┤
  │ Batch 3: Read + Read     │  ← 又一组并发安全工具 → 并行执行
  └──────────────────────────┘
```

并发上限默认 10（`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`）。

**Bash 错误级联：** `StreamingToolExecutor` 中，Bash 工具错误会触发 sibling abort，取消所有并行执行中的兄弟工具。其他工具（Read/Grep 等）的错误不会级联。

### 4b. Attachment 注入

```typescript
// src/query.ts:1580-1614
// 注入 attachments
for await (const attachment of getAttachmentMessages(
  null, updatedToolUseContext, null, queuedCommandsSnapshot,
  [...messagesForQuery, ...assistantMessages, ...toolResults], querySource,
)) {
  yield attachment
  toolResults.push(attachment)
}

// Memory 预取消费
if (pendingMemoryPrefetch && pendingMemoryPrefetch.settledAt !== null) {
  const memoryAttachments = filterDuplicateMemoryAttachments(await pendingMemoryPrefetch.promise, ...)
  for (const memAttachment of memoryAttachments) {
    const msg = createAttachmentMessage(memAttachment)
    yield msg; toolResults.push(msg)
  }
}
```

Attachment 类型包括：文件变更通知、Memory 文件、排队的命令（task notifications）、Skill Discovery 结果等。

### 4c. maxTurns 检查与状态推进

```typescript
// src/query.ts:1704-1728
if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({ type: 'max_turns_reached', maxTurns, turnCount: nextTurnCount })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}

const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  pendingToolUseSummary: nextPendingToolUseSummary,
  maxOutputTokensOverride: undefined,
  stopHookActive,
  transition: { reason: 'next_turn' },
}
state = next
// → continue → while(true) 回到 Phase 1
```

## 循环终止条件

循环有 **10+ 种** 终止原因（Terminal），分为正常终止和异常终止：

| reason | 触发条件 | 类型 |
|--------|----------|------|
| `completed` | 模型自然停止（无 tool_use）且 stop hooks 通过 | 正常 |
| `max_turns` | 达到 maxTurns 限制 | 正常 |
| `blocking_limit` | Token 硬阻塞限制 | 异常 |
| `prompt_too_long` | 413 错误且所有恢复失败 | 异常 |
| `image_error` | 图片尺寸/缩放错误 | 异常 |
| `model_error` | API 调用抛出异常 | 异常 |
| `aborted_streaming` | 流式输出期间被用户中断 | 中断 |
| `aborted_tools` | 工具执行期间被用户中断 | 中断 |
| `hook_stopped` | 工具执行结果包含阻止继续标志 | 控制 |
| `stop_hook_prevented` | Stop hook 阻止继续 | 控制 |

## 循环继续条件

循环有 **7 种** 继续原因（Continue / transition），每种都会设置 `state = next; continue`：

| transition.reason | 触发条件 | 说明 |
|-------------------|----------|------|
| `next_turn` | 正常的工具执行完毕 | 携带工具结果进入下一轮 |
| `collapse_drain_retry` | 413 → Context Collapse 释放了空间 | 重试 API 调用 |
| `reactive_compact_retry` | 413 → Reactive Compact 成功 | 用压缩后消息重试 |
| `max_output_tokens_escalate` | max_output_tokens → 升级到 64k | 同一请求升高上限 |
| `max_output_tokens_recovery` | max_output_tokens → 注入续写提示 | 多轮恢复（最多3次） |
| `stop_hook_blocking` | Stop hook 返回 blocking error | 注入错误消息让模型修正 |
| `token_budget_continuation` | Token budget 未达 90% | 注入 nudge 让模型继续 |

## 工具执行架构

### StreamingToolExecutor 状态机

```
           addTool()
              │
              ▼
  ┌─────── queued ──────┐
  │                      │ processQueue()
  │                      ▼
  │              executing ◄──── canExecuteTool()?
  │                │              │
  │                │ collectResults()
  │                ▼              │
  │           completed           │ 
  │                │              │
  │                │ getCompletedResults() / getRemainingResults()
  │                ▼
  └────────── yielded
```

并发控制规则：
- `canExecuteTool(isConcurrencySafe)`: 只有当前没有执行中的工具，或者当前所有执行中工具和新工具都是并发安全的
- Bash 错误触发 `siblingAbortController.abort('sibling_error')`
- 用户中断分两种：ESC 中断（`'cancel'`）和提交新消息中断（`'interrupt'`），后者只影响 `interruptBehavior === 'cancel'` 的工具

### 传统工具编排（toolOrchestration.ts）

```typescript
function partitionToolCalls(toolUseMessages, toolUseContext): Batch[] {
  // 将工具分区：连续的并发安全工具合并为一批，非安全工具单独一批
  // 保持原始顺序不变
}

async function* runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext) {
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      yield* runToolsConcurrently(blocks, ...)  // all() 并发执行
    } else {
      yield* runToolsSerially(blocks, ...)       // 逐个执行
    }
  }
}
```

## 入口层适配

不同入口复用同一个 `query()` 循环，差异在于参数配置：

| 入口 | querySource | maxTurns | 特殊处理 |
|------|-------------|----------|----------|
| **REPL** (交互式) | `repl_main_thread` | 无限 | 处理 stream events → UI 渲染 |
| **SDK/Headless** | `sdk` | 可配置 | `QueryEngine.ask()` 封装 |
| **Subagent** | `agent:*` | agent 定义指定 | `runAgent()` 隔离 context + transcript |
| **Fork** | `compact/session_memory/...` | 通常 1 | 副作用任务，不阻塞主 loop |
| **Teammate** | 由 runner 设置 | 可配置 | 外层 prompt 循环包裹 |

## Memory 预取机制

```typescript
// src/query.ts:301-304
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages, state.toolUseContext,
)
```

Memory 预取在整个循环入口处触发一次（用户 prompt 不变），使用 `using` 语法确保在 generator 退出时自动 dispose。在每轮迭代的 Phase 4 中尝试消费已 settle 的结果：

```typescript
// src/query.ts:1599-1614
if (pendingMemoryPrefetch && pendingMemoryPrefetch.settledAt !== null
    && pendingMemoryPrefetch.consumedOnIteration === -1) {
  const memoryAttachments = filterDuplicateMemoryAttachments(
    await pendingMemoryPrefetch.promise,
    toolUseContext.readFileState,  // 去重：已被 Read/Write/Edit 的文件不重复注入
  )
}
```

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `src/query.ts` | Agent Loop 核心：`query()` / `queryLoop()` |
| `src/query/config.ts` | 入口快照配置 |
| `src/query/deps.ts` | 可注入依赖（callModel, autocompact, microcompact） |
| `src/query/stopHooks.ts` | Stop hooks 执行 + fork 副作用任务 |
| `src/query/tokenBudget.ts` | Token budget auto-continue 决策 |
| `src/services/api/claude.ts` | `queryModelWithStreaming` 单次 API 流式调用 |
| `src/services/tools/toolOrchestration.ts` | 工具批量编排（分区 + 并发/串行） |
| `src/services/tools/StreamingToolExecutor.ts` | 流式工具执行器 |
| `src/services/compact/autoCompact.ts` | 自动全量压缩 |
| `src/services/compact/microCompact.ts` | 微压缩 |
| `src/services/compact/reactiveCompact.ts` | 响应式压缩（413 恢复） |
| `src/services/contextCollapse/index.ts` | 上下文折叠 |
| `src/services/compact/snipCompact.ts` | 历史裁剪 |
| `src/utils/attachments.ts` | Attachment 注入 |
| `src/utils/messages.ts` | 消息创建工具函数 |
| `src/screens/REPL.tsx` | 交互式 REPL 入口 |
| `src/QueryEngine.ts` | SDK/Headless 入口 |
| `src/tools/AgentTool/runAgent.ts` | Subagent 生命周期 |

## 设计亮点总结

1. **单一循环实现**：主线程、Subagent、SDK、compact fork 全部收敛到同一个 `query()`，通过参数差异化行为
2. **多层压缩管线**：5 层递进式上下文压缩（Budget → Snip → Micro → Collapse → Auto），每层只在前层不够时触发
3. **弹性错误恢复**：413 和 max_output_tokens 都有多级恢复链，扣留错误直到恢复确认失败
4. **流式工具执行**：工具在模型流式输出过程中就开始执行，减少端到端延迟
5. **异步预取并行**：Memory 和 Skill Discovery 预取与模型调用并行，在结果可用时注入
6. **可注入依赖**：`QueryDeps` 让测试可以直接注入 fake，无需 spy
7. **State 结构化过渡**：每个 continue 站点都用完整的 `State` 赋值，transition 字段记录继续原因，便于调试和测试
