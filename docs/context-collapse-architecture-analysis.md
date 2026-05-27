# Claude Code Context Collapse 架构分析

## 1. 概述

Context Collapse 是 Claude Code 多层压缩流水线中的**第三层**（Microcompact 之后、Autocompact 之前），核心策略是**渐进式 span 摘要**——将对话中的特定片段（span）压缩为摘要，同时保留整体对话结构。

**重要说明**：Context Collapse 的实现位于 `src/services/contextCollapse/` 目录（ant-only 模块），通过 `feature('CONTEXT_COLLAPSE')` 门控。在 external build 的 `cli.js` 中，核心逻辑已被 DCE 移除，仅保留 session 持久化相关代码。以下分析基于 `src/` 目录中的调用代码、类型引用和 cli.js 中的残留代码推导。

## 2. 核心入口与调用位置

### 2.1 模块初始化

```
// src/setup.ts
initContextCollapse()
```

### 2.2 在 Query 循环中的调用

Context Collapse 在 microcompact 之后、autocompact 之前执行：

```428:447:src/query.ts
    // Project the collapsed context view and maybe commit more collapses.
    // Runs BEFORE autocompact so that if collapse gets us under the
    // autocompact threshold, autocompact is a no-op and we keep granular
    // context instead of a single summary.
    //
    // Nothing is yielded — the collapsed view is a read-time projection
    // over the REPL's full history. Summary messages live in the collapse
    // store, not the REPL array. This is what makes collapses persist
    // across turns: projectView() replays the commit log on every entry.
    // Within a turn, the view flows forward via state.messages at the
    // continue site (query.ts:1192), and the next projectView() no-ops
    // because the archived messages are already gone from its input.
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }
```

### 2.3 溢出恢复

当 API 返回 413 错误且 reactive compact 未启用时，Context Collapse 可以通过 `recoverFromOverflow` 紧急排水（drain）更多消息：

```
// src/query.ts 1090-1116
if (feature('CONTEXT_COLLAPSE') && contextCollapse &&
    state.transition?.reason !== 'collapse_drain_retry') {
  const drained = contextCollapse.recoverFromOverflow(
    messagesForQuery,
    querySource,
  )
  if (drained.committed > 0) {
    // transition: collapse_drain_retry — 用排水后的消息重试 API 调用
  }
}
```

## 3. 关键设计概念

### 3.1 投影视图（Projection）

Context Collapse 使用**读时投影**（read-time projection）模式：
- REPL 保留完整的消息历史
- 每次 query 时，`projectView()` 根据 commit log 重新投影当前视图
- 被 collapse 的消息从视图中移除，替换为摘要消息
- 摘要消息存储在 collapse store 中，不在 REPL 消息数组中

```
// src/commands/context/context.tsx:26
// projectView 在 /context 命令中用于可视化当前的 token 分布
```

### 3.2 Commit Log

Collapse 操作通过 commit log 记录，支持持久化和会话恢复：

```
// cli.js 495806-495823 (反编译)
async function recordContextCollapseCommit(data) {
  const sessionId = getSessionId()
  if (!sessionId) return
  await getSessionStorage().appendEntry({
    type: 'marble-origami-commit',
    sessionId,
    ...data,
  })
}

async function recordContextCollapseSnapshot(data) {
  const sessionId = getSessionId()
  if (!sessionId) return
  await getSessionStorage().appendEntry({
    type: 'marble-origami-snapshot',
    sessionId,
    ...data,
  })
}
```

### 3.3 内部代号：marble-origami

Context Collapse 的内部代号是 `marble-origami`，体现在持久化格式中。

## 4. 与 Autocompact 的互斥关系

当 Context Collapse 启用时，Autocompact 被抑制：

```201:223:src/services/compact/autoCompact.ts
  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  if (feature('CONTEXT_COLLAPSE')) {
    const { isContextCollapseEnabled } =
      require('../contextCollapse/index.js')
    if (isContextCollapseEnabled()) {
      return false
    }
  }
```

从注释推导出 Context Collapse 的阈值：
- **90% 有效窗口**：开始 commit（提交 collapse）
- **95% 有效窗口**：blocking spawn（阻塞式紧急排水）
- **93% 有效窗口**：Autocompact 的触发点（`effective - 13K`），正好位于两者之间

因此 Autocompact 在 Context Collapse 模式下被抑制，避免竞态。

## 5. 压缩后重置

Compact（任何路径）完成后需要重置 Context Collapse 状态：

```42:50:src/services/compact/postCompactCleanup.ts
  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      ;(
        require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
      ).resetContextCollapse()
    }
  }
```

只在主线程压缩时重置，子 agent 压缩不影响主线程的 collapse 状态：

```
// 子 agent (marble_origami) 运行在同一进程中共享模块级状态
// 如果子 agent 的压缩重置了 collapse 状态，会破坏主线程的 committed log
```

这也是为什么 `shouldAutoCompact` 中对 `querySource === 'marble_origami'` 做了特殊防护。

## 6. 会话恢复

Context Collapse 的状态可以从 session storage 恢复：

```
// src/screens/ResumeConversation.tsx
// restoreFromEntries — 从持久化的 entries 中恢复 collapse commits/snapshot
```

```
// src/utils/sessionStorage.ts
// 读写 contextCollapseCommits / contextCollapseSnapshot
```

```
// src/utils/sessionRestore.ts
// 恢复 collapse commits/snapshot
```

## 7. 可视化

`/context` 命令和 UI 组件可以显示 Context Collapse 的状态：

```
// src/utils/analyzeContext.ts — feature gate
// src/components/ContextVisualization.tsx — collapse 可视化
// src/components/TokenWarning.tsx — collapse 模式 UI
```

## 8. 推测的完整工作原理

基于注释和调用模式推导：

### 8.1 Span 选择

Context Collapse 可能将对话划分为多个 span（例如按 API 轮次或任务单元），每个 span 包含一组相关的消息。

### 8.2 渐进式压缩

当上下文接近阈值时：
1. **90% 阈值**：选择最旧的、信息密度最低的 span 进行 collapse
2. **Collapse 操作**：调用模型（`marble_origami` agent）为选中的 span 生成摘要
3. **Commit**：将 collapse 记录到 commit log，摘要存入 collapse store
4. **投影**：后续 `projectView()` 调用时，被 collapse 的 span 替换为摘要

### 8.3 紧急排水

当 95% 阈值被触及或 API 返回 413 错误时：
- `recoverFromOverflow` 紧急 commit 更多 span
- 不需要等待新的摘要生成，可能使用已计算但未 commit 的 collapse

### 8.4 与全量压缩的对比

| 维度 | Context Collapse | Autocompact |
|------|:---:|:---:|
| 粒度 | Span 级别 | 全部消息 |
| 信息保留 | 高（只压缩部分 span） | 低（全部替换为摘要） |
| 渐进性 | 是（逐步 collapse 更多 span） | 否（一次性全量替换） |
| 模型调用 | 针对每个 span | 针对全部历史 |
| Prompt Cache | 保留（投影不改变消息结构） | 破坏（所有消息被替换） |

## 9. 相关文件

| 文件 | 用途 |
|------|------|
| `src/services/contextCollapse/` | 核心实现目录（ant-only，不在仓库中） |
| `src/query.ts` | `applyCollapsesIfNeeded` 和 `recoverFromOverflow` 调用 |
| `src/setup.ts` | `initContextCollapse()` 初始化 |
| `src/services/compact/autoCompact.ts` | 互斥逻辑 |
| `src/services/compact/postCompactCleanup.ts` | `resetContextCollapse()` 重置 |
| `src/utils/sessionStorage.ts` | Commit/Snapshot 持久化 |
| `src/utils/sessionRestore.ts` | 恢复 collapse 状态 |
| `src/components/ContextVisualization.tsx` | UI 可视化 |
| `src/components/TokenWarning.tsx` | 状态显示 |
| `src/tools.ts` | `CtxInspectTool` 调试工具 |

## 10. 设计亮点总结

1. **渐进式而非全量**：只压缩必要的 span，保留更多原始上下文
2. **读时投影**：不修改原始消息，通过投影实现灵活的视图管理
3. **Commit Log 持久化**：支持会话恢复和重放
4. **Prompt Cache 友好**：投影不改变未压缩消息的结构，保持 cache 有效性
5. **多级阈值**：90% commit + 95% blocking 的双级阈值设计
6. **与 Autocompact 优雅互斥**：通过 `shouldAutoCompact` 中的 feature 检查实现
