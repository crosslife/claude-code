# Claude Code Reactive Compact 架构分析

## 1. 概述

Reactive Compact 是 Claude Code 多层压缩流水线中的**被动/兜底层**，当 API 返回 `413 Prompt Too Long` 错误或媒体文件过大错误时触发。与主动式的 Autocompact 不同，它是在 API 调用**失败后**被动触发的。

核心源码位于 `reactiveCompact.js`（ant-only 模块，通过 `feature('REACTIVE_COMPACT')` 门控），在 external build 的 `cli.js` 中以 minified 形式存在。

## 2. 触发位置与条件

### 2.1 在 Query 循环中的触发

Reactive Compact 在 API 调用返回错误后触发，位于 `query.ts` 的错误处理逻辑中：

```
// query.ts 397963-398001 (从 cli.js 反编译)
let isPromptTooLong = lastAssistant?.isApiErrorMessage && isWithheldPromptTooLong(lastAssistant)
let isMediaError = feature('REACTIVE_COMPACT') && isWithheldMediaSizeError(lastAssistant)

if (isPromptTooLong || isMediaError) {
  const compactResult = await tryReactiveCompact({
    hasAttempted,          // 是否已尝试过
    querySource,
    aborted,
    messages,
    cacheSafeParams,
  })
  if (compactResult) {
    // yield post-compact messages, 用压缩后消息重试 API 调用
  }
}
```

### 2.2 前置条件

`tryReactiveCompact`（cli.js 中的 `eI4`）的前置检查：

```
// 必须同时满足：
// 1. 尚未在本轮尝试过 reactive compact (!hasAttempted)
// 2. 不是 compact 或 session_memory 子 agent
// 3. autoCompact 已启用 (isAutoCompactEnabled)
// 4. 未被用户中断
// 5. 处于 reactive-only 模式 (isReactiveOnlyMode)
```

### 2.3 Reactive-only 模式

```
// cli.js 267808-267811
function isReactiveOnlyMode() {
  if (isContextCollapseEnabled()) return false
  return getFeatureValue('tengu_cobalt_raccoon', false)
}
```

当 `tengu_cobalt_raccoon` feature flag 为 true 时：
- 主动 autocompact 被抑制（`shouldAutoCompact` 返回 false）
- `/compact` 命令走 reactive 路径
- API 错误时触发 reactive compact

## 3. 核心算法：分组迭代摘要

### 3.1 整体流程

Reactive Compact 的核心是 `reactiveCompactOnPromptTooLong`（cli.js 中的 `Dr1`），它调用分组迭代函数 `bI4`：

```
reactiveCompactOnPromptTooLong(messages, cacheSafeParams, options)
    │
    ├── bI4(messages, cacheSafeParams, options)  // 分组迭代摘要核心
    │     │
    │     ├── groupMessagesByApiRound(messages)   // 按 API 轮次分组
    │     │
    │     └── while (preserveCount < totalGroups):
    │           ├── summarizeSet = groups[0..splitPoint]
    │           ├── preserveSet = groups[splitPoint..end]
    │           ├── c0z(summarizeSet, ...)  // 尝试摘要
    │           │     ├── 成功 → 返回结果
    │           │     ├── prompt_too_long → 增加 preserveCount, 继续循环
    │           │     ├── media_too_large → 开启 stripImages 模式重试
    │           │     └── error/aborted → 终止
    │           └── 步长由 gap-guided step 计算
    │
    ├── Post-compact cleanup
    ├── File attachment restoration
    ├── Hook execution (PostCompact)
    └── Build CompactionResult
```

### 3.2 分组迭代核心（cli.js `bI4` 反编译）

```javascript
// 267283-267380:cli.js (反编译注释版)
async function iterativeGroupSummarize(messages, cacheSafeParams, options) {
  // 1. 按 API 轮次分组
  const filteredMessages = getMessagesAfterCompactBoundary(messages)
    .filter(m => m.type !== 'progress')
  const groups = groupMessagesByApiRound(filteredMessages)
  const totalGroups = groups.length

  if (totalGroups < 2) {
    return { ok: false, reason: 'too_few_groups' }
  }

  let preserveCount = 1        // 从保留最新 1 组开始
  let attempts = 0
  let stripImages = false

  while (preserveCount < totalGroups) {
    if (signal.aborted) return { ok: false, reason: 'aborted' }
    attempts++

    const splitPoint = totalGroups - preserveCount
    const summarizeSet = groups.slice(0, splitPoint).flat()
    const preserveSet = groups.slice(splitPoint).flat()

    // 检查是否还有 assistant 消息可以摘要
    if (!summarizeSet.some(m => m.type === 'assistant')) {
      return { ok: false, reason: attempts > 1 ? 'exhausted' : 'too_few_groups' }
    }

    // 尝试对 summarizeSet 生成摘要
    const result = await summarizeOneAttempt(
      summarizeSet, cacheSafeParams, options.customInstructions, stripImages
    )

    if (result.ok) {
      return {
        ok: true,
        result: {
          summaryMessages: result.messages,
          summaryText: result.summaryText,
          messagesToPreserve: preserveSet,
          attempt: attempts,
          totalUsage: result.totalUsage,
          groupsPreserved: preserveCount,
          totalGroups,
        }
      }
    }

    switch (result.reason) {
      case 'aborted': return { ok: false, reason: 'aborted' }
      case 'error': return { ok: false, reason: 'error', detail: result.detail }
      case 'media_too_large':
        // 首次遇到：开启 strip images 模式，不增加 preserveCount
        if (!stripImages) { stripImages = true; attempts--; continue }
        return { ok: false, reason: 'media_unstrippable' }
      case 'prompt_too_long':
        // 使用 token gap 引导步长增加
        break
    }

    // Gap-guided step: 根据 prompt_too_long 报告的 token gap 计算步长
    const groupTokenCounts = groups.map(g => estimateMessageTokens(g))
    const step = calculateGapGuidedStep(result.tokenGap, groupTokenCounts, splitPoint)
    preserveCount += step.step
  }

  return { ok: false, reason: 'exhausted' }
}
```

### 3.3 单次摘要尝试（cli.js `c0z` 反编译）

```javascript
// 267189-267262:cli.js (反编译注释版)
async function summarizeOneAttempt(messages, cacheSafeParams, customInstructions, stripImages) {
  const prompt = getCompactPrompt(customInstructions)
  const summaryRequest = createUserMessage({ content: prompt })

  const messagesToSend = stripImages
    ? stripImagesFromMessages(getMessagesAfterCompactBoundary(messages))
    : getMessagesAfterCompactBoundary(messages)

  try {
    const result = await runForkedAgent({
      promptMessages: [summaryRequest],
      cacheSafeParams: {
        ...cacheSafeParams,
        forkContextMessages: messagesToSend,
      },
      canUseTool: createCompactCanUseTool(),
      querySource: 'compact',
      forkLabel: 'reactive-compact',
      maxTurns: 1,
      maxOutputTokens: Math.min(COMPACT_MAX_OUTPUT_TOKENS, getMaxOutputTokensForModel(model)),
      skipTranscript: true,
      skipCacheWrite: true,
    })
  } catch (error) {
    return { ok: false, reason: 'error', detail: errorMessage(error) }
  }

  // 处理各种错误情况
  if (aborted) return { ok: false, reason: 'aborted' }
  if (promptTooLong) return { ok: false, reason: 'prompt_too_long', tokenGap }
  if (mediaTooLarge) return { ok: false, reason: 'media_too_large' }

  // 成功
  const summaryText = getAssistantMessageText(assistantMsg)
  return {
    ok: true,
    summaryText,
    totalUsage: result.totalUsage,
    messages: [createUserMessage({
      content: getCompactUserSummaryMessage(summaryText, true, transcriptPath, undefined, hasPreservedMessages),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })]
  }
}
```

### 3.4 Gap-guided 步长计算

当单次摘要因 prompt_too_long 失败时，API 返回的 token gap 信息用于精确计算下一次应该保留多少额外的组：

```javascript
function calculateGapGuidedStep(tokenGap, groupTokenCounts, currentSplitPoint) {
  // 从 splitPoint 向前累加组的 token 数
  // 直到累计超过 tokenGap
  // 返回需要额外保留的组数
}
```

这避免了盲目的二分搜索，用 API 反馈的精确 token 信息引导步长。

## 4. 完整执行流程（reactiveCompactOnPromptTooLong）

从 cli.js `Dr1` 反编译：

```javascript
// 267894-267978:cli.js (反编译注释版)
async function reactiveCompactOnPromptTooLong(messages, cacheSafeParams, options) {
  const preCompactTokens = estimateMessageTokens(messages)
  const startTime = performance.now()

  // 1. 调用分组迭代摘要核心
  const iterResult = await iterativeGroupSummarize(messages, cacheSafeParams, {
    customInstructions: options?.customInstructions
  })

  if (!iterResult.ok) {
    logEvent('tengu_reactive_compact_failed', { reason, preCompactTokens, ... })
    return { ok: false, reason: iterResult.reason }
  }

  const { result } = iterResult
  const { toolUseContext } = cacheSafeParams

  // 2. 保存并清除文件状态缓存
  const preCompactReadFileState = cacheToObject(toolUseContext.readFileState)
  toolUseContext.readFileState.clear()
  toolUseContext.loadedNestedMemoryPaths?.clear()

  // 3. 缓存断裂通知
  if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
    notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
  }
  markPostCompaction()
  runPostCompactCleanup()

  // 4. 创建 boundary 标记
  const boundaryMarker = createCompactBoundaryMessage(
    options?.trigger ?? 'auto',
    preCompactTokens,
    messages.at(-1)?.uuid,
  )
  boundaryMarker.compactMetadata.durationMs = Math.round(performance.now() - startTime)

  // 5. 恢复文件附件和 hooks
  const preservedMessages = result.messagesToPreserve.map(filterProgressMessages)
  const { attachments, hookResults } = await restoreAttachments(preCompactReadFileState, toolUseContext, preservedMessages)

  // 6. 执行 PostCompact hooks
  const postHookResult = await executePostCompactHooks({
    trigger: options?.trigger ?? 'auto',
    compactSummary: result.summaryText,
  }, toolUseContext.abortController.signal)

  // 7. 构建 CompactionResult
  const compactionResult = {
    boundaryMarker: annotateBoundaryWithPreservedSegment(boundaryMarker, ...),
    summaryMessages: result.summaryMessages,
    messagesToKeep: preservedMessages,
    attachments,
    hookResults,
    preCompactTokenCount: preCompactTokens,
  }

  // 8. 计算压缩后 token 并记录
  const postCompactTokens = estimateMessageTokens(buildPostCompactMessages(compactionResult))
  boundaryMarker.compactMetadata.postTokens = postCompactTokens

  logEvent('tengu_reactive_compact_succeeded', {
    attempts, groupsPreserved, totalGroups,
    preCompactTokens, postCompactTokens, ...
  })

  return { ok: true, result: compactionResult }
}
```

## 5. 与手动 /compact 的交互

在 reactive-only 模式下，`/compact` 命令走 reactive 路径而非传统 `compactConversation`：

```87:94:src/commands/compact/compact.ts
    // Reactive-only mode: route /compact through the reactive path.
    if (reactiveCompact?.isReactiveOnlyMode()) {
      return await compactViaReactive(
        messages, context, customInstructions, reactiveCompact,
      )
    }
```

`compactViaReactive` 内部并行执行 PreCompact hooks 和 cache 参数构建，然后调用 `reactiveCompactOnPromptTooLong`。

## 6. 错误处理与恢复

### 6.1 失败原因枚举

| 原因 | 说明 | 处理 |
|------|------|------|
| `too_few_groups` | 消息组少于 2 个 | 无法压缩 |
| `aborted` | 用户中断 | 终止 |
| `exhausted` | 所有组都尝试过仍失败 | 放弃 |
| `error` | API 或内部错误 | 记录并放弃 |
| `media_unstrippable` | 剥离图片后仍超限 | 放弃 |

### 6.2 Media 错误处理

首次遇到 `media_too_large` 时，开启 `stripImages` 模式重试同一组划分，不消耗尝试次数。如果剥离图片后仍失败，返回 `media_unstrippable`。

## 7. 与 Autocompact 的关系

| 维度 | Autocompact | Reactive Compact |
|------|:---:|:---:|
| 触发时机 | API 调用前（主动） | API 调用失败后（被动） |
| 阈值检查 | token 使用量 ≥ 阈值 | 无阈值（由 API 错误触发） |
| 保留消息 | 不保留（全量摘要） | 保留最近 N 组 |
| 重试策略 | 无（单次） | 迭代增加保留组数 |
| Cache 复用 | Fork Agent 复用 cache | Fork Agent 复用 cache |
| 互斥关系 | reactive-only 模式下被抑制 | autocompact 的兜底 |

## 8. 关键设计亮点

1. **渐进式保留**：从保留 1 组开始逐步增加，确保尽可能多的历史被摘要而不是丢弃
2. **Gap-guided 步长**：利用 API 的 token gap 反馈精确计算步长，避免盲目搜索
3. **图片剥离重试**：自动检测媒体过大问题并剥离图片重试
4. **Cache 复用**：通过 Fork Agent 复用主线程的 prompt cache
5. **消息保留**：压缩后保留最近的原始消息（`messagesToKeep`），比全量摘要保留更多上下文
