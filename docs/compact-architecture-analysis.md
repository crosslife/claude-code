# Claude Code 上下文压缩(Compact)架构分析

## 1. 概述

Claude Code 的 Compact 系统是一套多层次的上下文管理方案，核心目标是在对话接近模型上下文窗口限制时，通过摘要压缩历史消息来释放空间，使对话能够无限延续。

系统包含两条主要路径：
- **手动压缩**：用户输入 `/compact [instructions]` 触发
- **自动压缩**：每轮 query 循环中检测 token 使用量，超过阈值时自动触发

两条路径共享相同的底层压缩逻辑 `compactConversation`。

## 2. 多层压缩流水线

在每轮 API 调用之前，`query.ts` 按顺序应用多种压缩策略：

```
原始消息 → ① Snip → ② Microcompact → ③ Context Collapse → ④ Autocompact → ⑤ API 调用
                                                                                   ↓ 413 错误
                                                                             Reactive Compact
```

### 2.1 流水线在 query.ts 中的执行顺序

```396:468:src/query.ts
    // Apply snip before microcompact (both may run — they are not mutually exclusive).
    // snipTokensFreed is plumbed to autocompact so its threshold check reflects
    // what snip removed; tokenCountWithEstimation alone can't see it (reads usage
    // from the protected-tail assistant, which survives snip unchanged).
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      // ...
    }

    // Apply microcompact before autocompact
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // ...

    // Project the collapsed context view and maybe commit more collapses.
    // Runs BEFORE autocompact so that if collapse gets us under the
    // autocompact threshold, autocompact is a no-op and we keep granular
    // context instead of a single summary.
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(...)
      messagesForQuery = collapseResult.messages
    }

    // Autocompact
    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: messagesForQuery },
      querySource,
      tracking,
      snipTokensFreed,
    )
```

各层策略的职责对比：

| 策略 | 行为 | 是否删除消息 | 是否调用模型 |
|------|------|:---:|:---:|
| **Snip** | 裁剪历史消息 + 插入 boundary | 是 | 否 |
| **Microcompact** | 清除旧 tool result 内容 | 否（仅清空内容） | 否 |
| **Context Collapse** | 渐进式 span 摘要 | 是（替换为摘要） | 是 |
| **Autocompact** | 全量摘要压缩 | 是（全部替换） | 是 |
| **Reactive Compact** | 413/媒体错误时被动压缩 | 是 | 是 |

## 3. 自动压缩的触发时机与条件

### 3.1 触发位置

自动压缩在 **每轮 query 循环的 API 调用之前** 检查触发条件。核心入口是 `autoCompactIfNeeded` 函数：

```241:277:src/services/compact/autoCompact.ts
export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // Circuit breaker: stop retrying after N consecutive failures.
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel
  const shouldCompact = await shouldAutoCompact(
    messages, model, querySource, snipTokensFreed,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }
  // ...
```

### 3.2 阈值计算公式

自动压缩的触发阈值通过以下公式计算：

```
触发条件: tokenCount >= autoCompactThreshold

autoCompactThreshold = effectiveContextWindowSize - AUTOCOMPACT_BUFFER_TOKENS (13,000)
effectiveContextWindowSize = contextWindowForModel - min(maxOutputTokens, 20,000)
```

对应源码：

```30:49:src/services/compact/autoCompact.ts
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}
```

```62:91:src/services/compact/autoCompact.ts
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}
```

**以 200K 窗口模型为例的计算**：
- `effectiveContextWindow` = 200,000 - 20,000 = 180,000
- `autoCompactThreshold` = 180,000 - 13,000 = **167,000 tokens**
- 即当 token 使用量 ≥ 167,000 时触发自动压缩

### 3.3 关键阈值常量总览

| 常量 | 值 | 用途 |
|------|---:|------|
| `MAX_OUTPUT_TOKENS_FOR_SUMMARY` | 20,000 | 为摘要输出预留的 token 空间 |
| `AUTOCOMPACT_BUFFER_TOKENS` | 13,000 | 自动压缩触发缓冲区 |
| `WARNING_THRESHOLD_BUFFER_TOKENS` | 20,000 | UI 警告阈值缓冲区 |
| `MANUAL_COMPACT_BUFFER_TOKENS` | 3,000 | 无自动压缩时的阻塞限制 |
| `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` | 3 | 断路器最大连续失败次数 |
| `POST_COMPACT_TOKEN_BUDGET` | 50,000 | 压缩后文件恢复的 token 预算 |
| `POST_COMPACT_MAX_FILES_TO_RESTORE` | 5 | 压缩后最多恢复文件数 |
| `POST_COMPACT_MAX_TOKENS_PER_FILE` | 5,000 | 每个恢复文件的 token 上限 |

### 3.4 自动压缩的开关与抑制条件

开关控制：

```147:158:src/services/compact/autoCompact.ts
export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}
```

`shouldAutoCompact` 函数中的抑制条件：

```160:238:src/services/compact/autoCompact.ts
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  snipTokensFreed = 0,
): Promise<boolean> {
  // 1. 递归防护：compact 和 session_memory 子 agent 不触发
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // 2. Context Collapse agent (marble_origami) 不触发
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }
  // 3. 全局开关检查
  if (!isAutoCompactEnabled()) {
    return false
  }
  // 4. Reactive-only 模式下抑制主动压缩
  if (feature('REACTIVE_COMPACT')) {
    if (getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)) {
      return false
    }
  }
  // 5. Context Collapse 启用时抑制（由 collapse 接管上下文管理）
  if (feature('CONTEXT_COLLAPSE')) {
    const { isContextCollapseEnabled } = require('../contextCollapse/index.js')
    if (isContextCollapseEnabled()) {
      return false
    }
  }

  // 6. 计算 token 使用量并与阈值比较
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  // ...
  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(tokenCount, model)
  return isAboveAutoCompactThreshold
}
```

抑制条件总结：

| 条件 | 原因 |
|------|------|
| `querySource === 'compact'` | 防止压缩子 agent 死锁 |
| `querySource === 'session_memory'` | 防止 SM 子 agent 死锁 |
| `querySource === 'marble_origami'` | 防止 Context Collapse agent 破坏主线程状态 |
| `DISABLE_COMPACT` 环境变量 | 全局禁用所有压缩 |
| `DISABLE_AUTO_COMPACT` 环境变量 | 仅禁用自动压缩 |
| `autoCompactEnabled = false` | 用户设置关闭 |
| Reactive-only 模式 | 由 reactive compact 接管 |
| Context Collapse 启用 | 由 collapse 系统接管 |
| 连续失败 ≥ 3 次 | 断路器跳闸 |

### 3.5 断路器机制

当自动压缩连续失败达到 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`(3 次)时，断路器跳闸，后续不再尝试。源码注释说明了设计动机：

```67:70:src/services/compact/autoCompact.ts
// Stop trying autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
```

## 4. 手动 /compact 命令执行流程

### 4.1 命令定义

```4:15:src/commands/compact/index.ts
const compact = {
  type: 'local',
  name: 'compact',
  description:
    'Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  argumentHint: '<optional custom summarization instructions>',
  load: () => import('./compact.js'),
}
```

### 4.2 执行流程

`/compact` 命令的 `call` 函数定义了完整的执行路径：

```40:137:src/commands/compact/compact.ts
export const call: LocalCommandCall = async (args, context) => {
  const { abortController } = context
  let { messages } = context

  // 1. 投影到 compact boundary 之后的消息
  messages = getMessagesAfterCompactBoundary(messages)

  if (messages.length === 0) {
    throw new Error('No messages to compact')
  }

  const customInstructions = args.trim()

  try {
    // 2. 无自定义指令时，优先尝试 Session Memory 压缩
    if (!customInstructions) {
      const sessionMemoryResult = await trySessionMemoryCompaction(
        messages, context.agentId,
      )
      if (sessionMemoryResult) {
        getUserContext.cache.clear?.()
        runPostCompactCleanup()
        // ...
        return { type: 'compact', compactionResult: sessionMemoryResult, displayText: ... }
      }
    }

    // 3. Reactive-only 模式走 reactive 路径
    if (reactiveCompact?.isReactiveOnlyMode()) {
      return await compactViaReactive(messages, context, customInstructions, reactiveCompact)
    }

    // 4. 默认路径：先 microcompact 再全量压缩
    const microcompactResult = await microcompactMessages(messages, context)
    const messagesForCompact = microcompactResult.messages

    const result = await compactConversation(
      messagesForCompact,
      context,
      await getCacheSharingParams(context, messagesForCompact),
      false,           // suppressFollowUpQuestions = false（手动时允许提问）
      customInstructions,
      false,           // isAutoCompact = false
    )

    setLastSummarizedMessageId(undefined)
    suppressCompactWarning()
    getUserContext.cache.clear?.()
    runPostCompactCleanup()

    return { type: 'compact', compactionResult: result, displayText: ... }
  } catch (error) {
    // 错误处理...
  }
}
```

### 4.3 SlashCommand 分发处理

`processSlashCommand.tsx` 中对 compact 结果的处理：

```679:704:src/utils/processUserInput/processSlashCommand.tsx
            if (result.type === 'compact') {
              const slashCommandMessages = [syntheticCaveatMessage, userMessage, ...];
              const compactionResultWithSlashMessages = {
                ...result.compactionResult,
                messagesToKeep: [...(result.compactionResult.messagesToKeep ?? []), ...slashCommandMessages]
              };
              resetMicrocompactState();
              return {
                messages: buildPostCompactMessages(compactionResultWithSlashMessages),
                shouldQuery: false,
                command
              };
            }
```

关键点：`shouldQuery: false` 意味着手动压缩后不会立即发起 API 调用。

## 5. 核心压缩逻辑 compactConversation

### 5.1 主要步骤

`compactConversation` 是所有压缩路径的核心函数：

```387:763:src/services/compact/compact.ts
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult> {
```

执行步骤：

1. **执行 PreCompact Hooks** — 允许外部注入自定义摘要指令
2. **构建摘要 Prompt** — 调用 `getCompactPrompt(customInstructions)`
3. **调用模型生成摘要** — 通过 `streamCompactSummary` 函数
4. **处理 Prompt Too Long 重试** — 截断最旧消息组后重试（最多 3 次）
5. **清理文件缓存** — `readFileState.clear()`
6. **创建压缩后附件** — 恢复最近读取的文件、计划、技能等
7. **创建 Boundary 标记** — `createCompactBoundaryMessage`
8. **创建摘要消息** — 用 `getCompactUserSummaryMessage` 包装摘要
9. **执行 SessionStart Hooks** — 重新注入 CLAUDE.md 等
10. **执行 PostCompact Hooks** — 通知外部压缩完成
11. **返回 CompactionResult**

### 5.2 摘要生成的两条路径

`streamCompactSummary` 函数实现了两条摘要生成路径：

```1136:1396:src/services/compact/compact.ts
async function streamCompactSummary({...}): Promise<AssistantMessage> {
```

**路径 A：Fork Agent（优先）** — 复用主线程的 Prompt Cache

```1188:1200:src/services/compact/compact.ts
        const result = await runForkedAgent({
          promptMessages: [summaryRequest],
          cacheSafeParams,
          canUseTool: createCompactCanUseTool(),
          querySource: 'compact',
          forkLabel: 'compact',
          maxTurns: 1,
          skipCacheWrite: true,
          overrides: { abortController: context.abortController },
        })
```

**路径 B：直接流式调用（Fallback）** — Cache Sharing 失败时降级

```1292:1326:src/services/compact/compact.ts
      const streamingGen = queryModelWithStreaming({
        messages: normalizeMessagesForAPI(
          stripImagesFromMessages(
            stripReinjectedAttachments([
              ...getMessagesAfterCompactBoundary(messages),
              summaryRequest,
            ]),
          ),
          context.options.tools,
        ),
        systemPrompt: asSystemPrompt([
          'You are a helpful AI assistant tasked with summarizing conversations.',
        ]),
        thinkingConfig: { type: 'disabled' as const },
        tools,
        signal: context.abortController.signal,
        // ...
      })
```

### 5.3 工具调用禁止机制

压缩过程中严格禁止模型调用任何工具：

```1125:1134:src/services/compact/compact.ts
export function createCompactCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny' as const,
    message: 'Tool use is not allowed during compaction',
    decisionReason: {
      type: 'other' as const,
      reason: 'compaction agent should only produce text summary',
    },
  })
}
```

### 5.4 图片和不必要附件的剥离

压缩前会剥离图片（减少 token 占用）和会被重新注入的附件（如 skill_discovery）：

```145:200:src/services/compact/compact.ts
export function stripImagesFromMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    // 替换 image/document block 为文本标记 [image]/[document]
    // ...
  })
}
```

```211:223:src/services/compact/compact.ts
export function stripReinjectedAttachments(messages: Message[]): Message[] {
  // 过滤掉 skill_discovery 和 skill_listing 附件
  // ...
}
```

## 6. 摘要 Prompt 设计

### 6.1 反工具调用前言

```19:26:src/services/compact/prompt.ts
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`
```

### 6.2 全量压缩 Prompt 结构

`getCompactPrompt` 生成的 Prompt 包含以下指导结构：

```61:143:src/services/compact/prompt.ts
const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary...

// 先在 <analysis> 标签中组织思路，然后在 <summary> 中输出结构化摘要

// 摘要包含 9 个章节：
// 1. Primary Request and Intent — 用户请求与意图
// 2. Key Technical Concepts — 关键技术概念
// 3. Files and Code Sections — 文件与代码片段（含完整代码）
// 4. Errors and fixes — 错误与修复
// 5. Problem Solving — 问题解决过程
// 6. All user messages — 所有用户消息（非工具结果）
// 7. Pending Tasks — 待办任务
// 8. Current Work — 当前工作（含文件名和代码）
// 9. Optional Next Step — 下一步行动（含最近对话原文引用）
`
```

### 6.3 摘要后处理

`formatCompactSummary` 会剥离 `<analysis>` 草稿区域，只保留 `<summary>` 内容：

```311:335:src/services/compact/prompt.ts
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary
  // 剥离 analysis 部分
  formattedSummary = formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  // 提取并格式化 summary 部分
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }
  return formattedSummary.trim()
}
```

### 6.4 摘要注入上下文消息

摘要被包装为用户消息注入到新的对话中：

```337:374:src/services/compact/prompt.ts
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`

  // 附加 transcript 路径以便查看完整记录
  if (transcriptPath) {
    baseSummary += `\n\nIf you need specific details from before compaction...read the full transcript at: ${transcriptPath}`
  }

  // 自动压缩时抑制后续提问
  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary...`
    return continuation
  }

  return baseSummary
}
```

自动压缩时 `suppressFollowUpQuestions=true`，指示模型直接继续工作而不提问。

## 7. Session Memory 压缩路径

这是一条**不调用模型的快速压缩路径**，直接使用 Session Memory 文件内容作为摘要。

### 7.1 触发条件

```403:431:src/services/compact/sessionMemoryCompact.ts
export function shouldUseSessionMemoryCompaction(): boolean {
  // 环境变量覆盖
  if (isEnvTruthy(process.env.ENABLE_CLAUDE_CODE_SM_COMPACT)) return true
  if (isEnvTruthy(process.env.DISABLE_CLAUDE_CODE_SM_COMPACT)) return false
  // 需要同时启用两个 feature flag
  const sessionMemoryFlag = getFeatureValue_CACHED_MAY_BE_STALE('tengu_session_memory', false)
  const smCompactFlag = getFeatureValue_CACHED_MAY_BE_STALE('tengu_sm_compact', false)
  return sessionMemoryFlag && smCompactFlag
}
```

### 7.2 消息保留策略

SM 压缩不是全量替换，而是保留最近的部分消息：

```57:61:src/services/compact/sessionMemoryCompact.ts
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,        // 至少保留 10K tokens
  minTextBlockMessages: 5,   // 至少保留 5 条含文本的消息
  maxTokens: 40_000,        // 最多保留 40K tokens
}
```

`calculateMessagesToKeepIndex` 函数从 `lastSummarizedMessageId` 位置开始，向前扩展直到满足最小保留要求。

### 7.3 优先级

在 `autoCompactIfNeeded` 中，Session Memory 压缩优先于模型压缩：

```287:310:src/services/compact/autoCompact.ts
  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // ...
    return { wasCompacted: true, compactionResult: sessionMemoryResult }
  }

  // 回退到传统模型压缩
  try {
    const compactionResult = await compactConversation(
      messages, toolUseContext, cacheSafeParams,
      true, undefined, true, recompactionInfo,
    )
    // ...
  }
```

## 8. 压缩结果的数据结构与使用

### 8.1 CompactionResult

```299:310:src/services/compact/compact.ts
export interface CompactionResult {
  boundaryMarker: SystemMessage          // compact_boundary 系统消息
  summaryMessages: UserMessage[]         // isCompactSummary 用户消息（摘要）
  attachments: AttachmentMessage[]       // 文件/技能/计划等恢复附件
  hookResults: HookResultMessage[]       // SessionStart hook 结果
  messagesToKeep?: Message[]             // 部分保留的消息（SM/partial）
  userDisplayMessage?: string            // 用户可见的提示信息
  preCompactTokenCount?: number          // 压缩前 token 数
  postCompactTokenCount?: number         // 压缩 API 调用的总 token 用量
  truePostCompactTokenCount?: number     // 结果上下文的实际 token 大小
  compactionUsage?: ReturnType<typeof getTokenUsage>  // API 使用量详情
}
```

### 8.2 消息组装顺序

```330:338:src/services/compact/compact.ts
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,        // ① compact_boundary 标记
    ...result.summaryMessages,    // ② 摘要消息
    ...(result.messagesToKeep ?? []),  // ③ 保留的消息（可选）
    ...result.attachments,        // ④ 恢复的附件
    ...result.hookResults,        // ⑤ hook 结果
  ]
}
```

### 8.3 压缩后恢复的内容

压缩完成后，以下内容会作为附件重新注入：

| 附件类型 | 用途 | Token 预算 |
|---------|------|-----------|
| 最近读取的文件 | 避免模型重新读取 | 50K total, 5K/file, 最多 5 个 |
| 计划文件 | 保留当前计划 | — |
| Plan Mode 指令 | 维持计划模式 | — |
| 已调用的技能 | 保留技能指引 | 25K total, 5K/skill |
| 异步 Agent 状态 | 避免重复启动 | — |
| Deferred Tools 增量 | 恢复工具上下文 | — |
| Agent 列表增量 | 恢复 agent 列表 | — |
| MCP 指令增量 | 恢复 MCP 上下文 | — |

## 9. 压缩后清理

`runPostCompactCleanup` 在每次压缩（手动/自动）后统一执行：

```31:77:src/services/compact/postCompactCleanup.ts
export function runPostCompactCleanup(querySource?: QuerySource): void {
  const isMainThreadCompact = querySource === undefined ||
    querySource.startsWith('repl_main_thread') || querySource === 'sdk'

  resetMicrocompactState()                    // 重置 microcompact 状态
  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      resetContextCollapse()                  // 重置 context collapse 状态
    }
  }
  if (isMainThreadCompact) {
    getUserContext.cache.clear?.()             // 清除用户上下文缓存
    resetGetMemoryFilesCache('compact')        // 重置 memory 文件缓存
  }
  clearSystemPromptSections()                  // 清除系统 prompt 分段
  clearClassifierApprovals()                   // 清除分类器审批
  clearSpeculativeChecks()                     // 清除预测性检查
  clearBetaTracingState()                      // 清除 tracing 状态
  clearSessionMessagesCache()                  // 清除会话消息缓存
}
```

注意：子 agent 压缩时跳过主线程级别的状态重置，避免破坏共享模块状态。

## 10. 自动压缩在 query 循环中的后处理

压缩成功后，query.ts 中执行以下操作：

```470:543:src/query.ts
    if (compactionResult) {
      // 记录分析事件
      logEvent('tengu_auto_compact_succeeded', { ... })

      // 更新任务预算
      if (params.taskBudget) { ... }

      // 重置 tracking 状态
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      // 构建压缩后消息并 yield 给 REPL
      const postCompactMessages = buildPostCompactMessages(compactionResult)
      for (const message of postCompactMessages) {
        yield message
      }

      // 用压缩后消息替换当前消息，继续当前 query
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // 传播失败计数给断路器
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }
```

**关键区别**：自动压缩后 `messagesForQuery = postCompactMessages`，继续当前轮次的 API 调用；手动压缩后 `shouldQuery: false`，不发起额外调用。

## 11. Prompt Too Long 重试机制

当压缩请求本身超出限制时，`truncateHeadForPTLRetry` 函数会截断最旧的 API-round 组：

```243:291:src/services/compact/compact.ts
export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null {
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  // 按 token gap 精确截断，或回退到 20% 截断
  const tokenGap = getPromptTooLongTokenGap(ptlResponse)
  let dropCount: number
  if (tokenGap !== undefined) {
    let acc = 0
    dropCount = 0
    for (const g of groups) {
      acc += roughTokenCountEstimationForMessages(g)
      dropCount++
      if (acc >= tokenGap) break
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }
  // 至少保留一组用于生成摘要
  dropCount = Math.min(dropCount, groups.length - 1)
  // ...
}
```

最多重试 `MAX_PTL_RETRIES`(3) 次。

## 12. 完整架构流程图

```
┌─────────────────────────────────────────────────────────────────┐
│                    用户输入 /compact [instructions]                │
│                              │                                   │
│                    processSlashCommand                           │
│                              │                                   │
│                    commands/compact/compact.ts::call()            │
│                              │                                   │
│              ┌───────────────┼───────────────────┐               │
│              │               │                   │               │
│     trySessionMemory   reactiveCompact    microcompact +         │
│     Compaction()       OnPromptTooLong    compactConversation()   │
│              │               │                   │               │
│              └───────────────┼───────────────────┘               │
│                              │                                   │
│                    buildPostCompactMessages()                    │
│                    shouldQuery: false                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    每轮 Query Loop (query.ts)                    │
│                              │                                   │
│                 ① snipCompactIfNeeded()                          │
│                              │                                   │
│                 ② microcompactMessages()                         │
│                              │                                   │
│                 ③ applyCollapsesIfNeeded()                       │
│                              │                                   │
│                 ④ autoCompactIfNeeded()                          │
│                     │                                            │
│          shouldAutoCompact() ── tokens >= threshold? ─── No ──→ │
│                     │ Yes                                        │
│          trySessionMemoryCompaction()                            │
│                     │ null?                                      │
│          compactConversation(isAutoCompact=true)                 │
│                     │                                            │
│          buildPostCompactMessages() → yield → 替换 messages      │
│                              │                                   │
│                 ⑤ API 调用 (继续当前 query)                      │
│                              │                                   │
│              ┌── 413 错误? ──┤                                   │
│              │ Yes           │ No                                │
│    tryReactiveCompact()      │                                  │
│                              ↓                                   │
│                         正常响应                                  │
└─────────────────────────────────────────────────────────────────┘
```

## 13. 设计亮点总结

1. **渐进式多层压缩**：Snip → Microcompact → Collapse → Autocompact 逐级深入，优先使用低成本策略
2. **Cache 复用**：Fork Agent 路径复用主线程 Prompt Cache，避免额外 cache_creation 开销
3. **断路器保护**：连续失败 3 次后停止重试，避免浪费 API 调用
4. **Session Memory 快速路径**：不调用模型即可完成压缩，降低延迟和成本
5. **上下文恢复**：压缩后自动恢复文件、技能、计划等关键上下文
6. **Prompt Too Long 自愈**：压缩请求本身超限时自动截断重试
7. **子 agent 防护**：防止 compact/session_memory/collapse agent 递归触发压缩
8. **主线程状态隔离**：子 agent 压缩时跳过共享模块状态重置
