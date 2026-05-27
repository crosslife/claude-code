# Claude Code Microcompact 架构分析

## 1. 概述

Microcompact 是 Claude Code 多层压缩流水线中的第二层（Snip 之后、Context Collapse 之前），其核心策略是**清除旧的 tool result 内容而不删除消息本身**。这是一种轻量级的 token 节省手段，不需要调用模型。

核心源码位于 `src/services/compact/microCompact.ts`。

## 2. 设计定位

| 特性 | Microcompact | Autocompact |
|------|:---:|:---:|
| 调用模型 | 否 | 是 |
| 删除消息 | 否（仅清空 tool result 内容） | 是（全部替换为摘要） |
| Token 节省量 | 中等 | 大量 |
| 延迟开销 | 极低 | 高（需等待 API 响应） |
| 信息损失 | 丢失旧 tool 输出细节 | 丢失所有历史细节 |

## 3. 可压缩的工具类型

只有以下工具的 result 会被微压缩：

```41:50:src/services/compact/microCompact.ts
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])
```

这些工具的输出通常较大（文件内容、shell 输出、搜索结果等），清除后节省效果明显。

## 4. 三条执行路径

`microcompactMessages` 函数是入口，按优先级依次尝试三条路径：

```253:293:src/services/compact/microCompact.ts
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  clearCompactWarningSuppression()

  // 路径 1：Time-based MC（最高优先级，短路返回）
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // 路径 2：Cached MC（ant-only，通过 cache_edits API 删除）
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // 路径 3：无操作（external build 默认走这里）
  return { messages }
}
```

### 4.1 路径 1：Time-based Microcompact

当距离上一条 assistant 消息的时间间隔超过阈值时触发。此时服务端 cache 已过期（冷缓存），直接修改本地消息内容是最优策略。

**触发条件判断**：

```422:444:src/services/compact/microCompact.ts
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  // 必须是主线程且有显式 querySource
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() - new Date(lastAssistant.timestamp).getTime()) / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}
```

**执行逻辑**：

```446:530:src/services/compact/microCompact.ts
function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) return null
  const { gapMinutes, config } = trigger

  const compactableIds = collectCompactableToolIds(messages)

  // 保留最近 N 个 tool result，清除其余
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  if (clearSet.size === 0) return null

  let tokensSaved = 0
  const result: Message[] = messages.map(message => {
    // 将命中的 tool_result 的 content 替换为
    // '[Old tool result content cleared]'
    if (block.type === 'tool_result' && clearSet.has(block.tool_use_id)) {
      tokensSaved += calculateToolResultTokens(block)
      return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
    }
    // ...
  })
  // ...
}
```

清除后的占位符消息：

```36:36:src/services/compact/microCompact.ts
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'
```

### 4.2 路径 2：Cached Microcompact（ant-only）

利用 Anthropic API 的 `cache_edits` 特性在服务端删除 tool result，**不修改本地消息内容**，保持 cache prefix 有效。

**状态管理**：

```52:135:src/services/compact/microCompact.ts
// 惰性初始化，避免在 external build 中导入
let cachedMCModule: typeof import('./cachedMicrocompact.js') | null = null
let cachedMCState: import('./cachedMicrocompact.js').CachedMCState | null = null
let pendingCacheEdits: import('./cachedMicrocompact.js').CacheEditsBlock | null = null
```

**核心流程**：

```305:399:src/services/compact/microCompact.ts
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const mod = await getCachedMCModule()
  const state = ensureCachedMCState()
  const config = mod.getCachedMCConfig()

  // 1. 收集可压缩的 tool_use ID
  const compactableToolIds = new Set(collectCompactableToolIds(messages))

  // 2. 注册新发现的 tool result
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      const groupIds: string[] = []
      for (const block of message.message.content) {
        if (block.type === 'tool_result' &&
            compactableToolIds.has(block.tool_use_id) &&
            !state.registeredTools.has(block.tool_use_id)) {
          mod.registerToolResult(state, block.tool_use_id)
          groupIds.push(block.tool_use_id)
        }
      }
      mod.registerToolMessage(state, groupIds)
    }
  }

  // 3. 根据阈值判断哪些 tool 需要删除
  const toolsToDelete = mod.getToolResultsToDelete(state)

  if (toolsToDelete.length > 0) {
    // 4. 创建 cache_edits block（由 API 层插入请求中）
    const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
    if (cacheEdits) {
      pendingCacheEdits = cacheEdits
    }
    // ...

    // 消息本身不修改，cache_edits 在 API 层注入
    return {
      messages,
      compactionInfo: {
        pendingCacheEdits: {
          trigger: 'auto',
          deletedToolIds: toolsToDelete,
          baselineCacheDeletedTokens: baseline,
        },
      },
    }
  }

  return { messages }
}
```

关键区别：Cached MC **不修改本地消息**，而是通过 API 的 `cache_edits` 指令让服务端删除缓存中的 tool result 内容。这保留了 prompt cache prefix 的有效性。

### 4.3 路径 3：No-op

在 external build 中，`feature('CACHED_MICROCOMPACT')` 为 false，time-based MC 也可能未配置，此时 microcompact 是空操作，直接返回原消息。

## 5. 辅助函数

### 5.1 Tool ID 收集

```226:241:src/services/compact/microCompact.ts
function collectCompactableToolIds(messages: Message[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && COMPACTABLE_TOOLS.has(block.name)) {
          ids.push(block.id)
        }
      }
    }
  }
  return ids
}
```

### 5.2 Token 估算

```137:157:src/services/compact/microCompact.ts
function calculateToolResultTokens(block: ToolResultBlockParam): number {
  if (!block.content) return 0
  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content)
  }
  return block.content.reduce((sum, item) => {
    if (item.type === 'text') return sum + roughTokenCountEstimation(item.text)
    else if (item.type === 'image' || item.type === 'document')
      return sum + IMAGE_MAX_TOKEN_SIZE  // 2000
    return sum
  }, 0)
}
```

### 5.3 消息 Token 估算（含 4/3 保守填充）

```164:205:src/services/compact/microCompact.ts
export function estimateMessageTokens(messages: Message[]): number {
  let totalTokens = 0
  for (const message of messages) {
    // 遍历所有 content block，累加 token 估算
    // text, tool_result, image, thinking, tool_use 等
  }
  // Pad estimate by 4/3 to be conservative
  return Math.ceil(totalTokens * (4 / 3))
}
```

## 6. 状态重置

压缩（任何路径）完成后，microcompact 状态需要重置：

```130:135:src/services/compact/microCompact.ts
export function resetMicrocompactState(): void {
  if (cachedMCState && cachedMCModule) {
    cachedMCModule.resetCachedMCState(cachedMCState)
  }
  pendingCacheEdits = null
}
```

此函数在 `postCompactCleanup.ts` 和 `processSlashCommand.tsx` 中被调用。

## 7. 与流水线其他层的交互

- **与 Snip 的关系**：Snip 先执行，Microcompact 后执行，两者不互斥
- **与 Cached MC 的关系**：Time-based MC 优先于 Cached MC（冷缓存时 cache_edits 无效）
- **与 Autocompact 的关系**：Microcompact 先释放空间，可能使 autocompact 无需触发
- **对 query.ts 的返回**：返回 `MicrocompactResult`，包含处理后的消息和可选的 `pendingCacheEdits`

## 8. 主线程限制

Cached MC 仅在主线程运行，子 agent（session_memory、prompt_suggestion 等）不参与：

```249:251:src/services/compact/microCompact.ts
function isMainThreadSource(querySource: QuerySource | undefined): boolean {
  return !querySource || querySource.startsWith('repl_main_thread')
}
```

这防止子 agent 向全局 `cachedMCState` 注册不属于主对话的 tool result。
