# Claude Code Snip Compact 架构分析

## 1. 概述

Snip Compact 是 Claude Code 多层压缩流水线中的**第一层**（最先执行），核心策略是**直接裁剪历史消息 + 插入 boundary 标记**，不调用模型，无延迟开销。

**重要说明**：Snip Compact 的实现位于 `snipCompact.js` 和 `snipProjection.js`，这两个文件是 ant-only 内部模块，通过 `feature('HISTORY_SNIP')` 门控，在 external build 的 `cli.js` 中已被 DCE（Dead Code Elimination）完全移除。以下分析基于 `src/` 目录中的调用代码和类型引用推导。

## 2. 核心入口

### 2.1 模块加载

```115:117:src/query.ts
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
```

### 2.2 在 Query 循环中的调用位置

Snip 在每轮 query 循环中**最先执行**，位于 microcompact 之前：

```396:410:src/query.ts
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
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage
      }
      queryCheckpoint('query_snip_end')
    }
```

### 2.3 返回值结构

从调用代码推导，`snipCompactIfNeeded` 返回：

```typescript
interface SnipResult {
  messages: Message[]            // 裁剪后的消息数组
  tokensFreed: number           // 释放的 token 数量
  boundaryMessage?: Message     // 可选的 snip boundary 标记
}
```

## 3. snipTokensFreed 的作用

Snip 释放的 token 数量需要传递给 autocompact 的阈值计算，因为 `tokenCountWithEstimation` 无法感知 snip 的效果：

```160:167:src/services/compact/autoCompact.ts
export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
): Promise<boolean> {
```

```225:225:src/services/compact/autoCompact.ts
  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
```

这确保 snip 已经释放的空间不会导致 autocompact 误触发。

## 4. Snip Projection（投影视图）

`snipProjection.js` 提供投影功能，在读取消息时过滤已 snip 的内容：

```
// src/utils/messages.ts (推导)
if (!options?.includeSnipped && feature('HISTORY_SNIP')) {
  const { projectSnippedView } =
    require('../services/compact/snipProjection.js')
  return projectSnippedView(sliced as Message[]) as T[]
}
```

### 4.1 Snip Boundary 消息识别

`snipProjection` 模块导出 `isSnipBoundaryMessage` 函数，用于在 UI 和逻辑中识别 snip 边界：

```
// src/QueryEngine.ts
snipReplay: (yielded: Message, store: Message[]) => {
  if (!snipProjection!.isSnipBoundaryMessage(yielded))
    return undefined
  return snipModule!.snipCompactIfNeeded(store, { force: true })
}
```

### 4.2 UI 中的 Snip 标记

```
// src/components/Message.tsx
// isSnipBoundaryMessage / isSnipMarkerMessage 用于在 UI 中显示 snip 边界
```

## 5. 强制 Snip 模式

在 `QueryEngine.ts` 的 `snipReplay` 回调中，当检测到 snip boundary 消息时，会以 `{ force: true }` 参数强制执行 snip：

```
snipModule!.snipCompactIfNeeded(store, { force: true })
```

这用于会话恢复时重播 snip 操作。

## 6. 与 Time-based Microcompact 的协同

Time-based Microcompact 的触发判断函数 `evaluateTimeBasedTrigger` 可被 snip 的 force-apply 路径复用：

```419:420:src/services/compact/microCompact.ts
// Extracted so other pre-request paths (e.g. snip force-apply) can consult
// the same predicate without coupling to the tool-result clearing action.
```

## 7. 与其他层的关系

| 关系 | 说明 |
|------|------|
| Snip → Microcompact | Snip 先执行，两者不互斥 |
| Snip → Autocompact | `snipTokensFreed` 传递给 autocompact 避免误触发 |
| Snip → Context Collapse | 均在 autocompact 之前运行 |
| Snip → 消息投影 | `projectSnippedView` 过滤已 snip 内容 |

## 8. 相关文件

| 文件 | 用途 |
|------|------|
| `src/services/compact/snipCompact.js` | 核心实现（ant-only，不在仓库中） |
| `src/services/compact/snipProjection.js` | 投影视图（ant-only，不在仓库中） |
| `src/query.ts` | 流水线调用入口 |
| `src/QueryEngine.ts` | snipReplay 回调 |
| `src/utils/messages.ts` | projectSnippedView 调用 |
| `src/components/Message.tsx` | UI 渲染 |

## 9. 推测的工作原理

基于调用模式和注释推导：

1. **触发条件**：可能基于消息数量或 token 使用量阈值
2. **裁剪策略**：删除最旧的消息，保留最近的消息
3. **Boundary 标记**：在裁剪点插入 snip_boundary 系统消息
4. **投影隔离**：通过 `projectSnippedView` 确保已 snip 的消息不会被发送给 API
5. **REPL 保留**：REPL 可能保留完整消息用于 UI 滚动回看（`compact.ts` 中注释提到 "REPL keeps snipped messages for UI scrollback"）
