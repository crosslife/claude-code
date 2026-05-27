# Claude Code 多次工具调用的上下文优化深度分析

> 分析一次对话中多次工具调用时，发送给 LLM 的内容、精简策略、以及上下文质量保障机制。

---

## 核心结论

Claude Code **并非简单地原样记录**工具调用参数和结果发回 LLM。它设计了一套 **6 层渐进式精简管线**，在保持质量的前提下，积极优化上下文数量。工具调用参数（`tool_use`）基本原样保留，但工具结果（`tool_result`）经历了多层处理。

---

## 一、工具调用参数的记录方式（tool_use）

### 1.1 基本原样保留

LLM 发出的 `tool_use` 块在存储和重新发回时，参数几乎不变。只经过轻量清洗：

**`normalizeToolInputForAPI`**（`src/utils/api.ts`）：
- `ExitPlanMode` 工具：剥离内部注入的 `plan`/`planFilePath` 字段
- `FileEdit` 工具：剥离旧版的 `old_string`/`new_string`/`replace_all`（当 `edits` 存在时）
- 其他工具：**直接透传**

**非 Tool Search 模式**：
- `tool_use` 块只保留标准 API 字段 `{type, id, name, input}`
- 剥离 `caller` 等扩展字段

### 1.2 assistant 消息的合并

流式返回中，同一个 API 响应的多个 content block 各生成一条独立的 `AssistantMessage`（共享 `message.id`），在 `normalizeMessagesForAPI` 中被合并回一条。

---

## 二、工具结果的记录方式（tool_result）

### 2.1 原始结果格式

每个工具自定义 `mapToolResultToToolResultBlockParam`，将执行结果映射为 `tool_result` 块：

| 工具 | 结果格式 |
|------|---------|
| Read（文本） | 带行号的文件内容：`     1\|import fs...\n     2\|...` |
| Read（图片） | base64 图片 block：`{type:'image', source:{type:'base64', ...}}` |
| Bash | stdout 纯文本，或 stdout + stderr 拼接 |
| Grep | `Found N files\npath1\npath2\n...` |
| Glob | 文件路径列表 |
| WebFetch | markdown 格式的网页内容 |

### 2.2 空结果保护

所有工具的空输出统一替换为：`(toolName completed with no output)`

### 2.3 错误结果格式

- 验证失败：`<tool_use_error>InputValidationError: ...</tool_use_error>` + `is_error: true`
- 权限拒绝：纯文本错误 + `is_error: true`
- 图片放在 `tool_result` 的**同级**（因为 `is_error` 的 `tool_result` 不允许非文本内容）

---

## 三、6 层渐进式精简管线

每轮查询前，消息在 `query.ts` 的 `queryLoop` 中按顺序经过：

```
原始消息 → ① 工具结果预算 → ② Snip → ③ Microcompact → ④ Context Collapse → ⑤ Autocompact → ⑥ Token限制检查
```

### 层级 1：单结果持久化 + 并行预算控制

**来源**：`src/utils/toolResultStorage.ts`、`src/constants/toolLimits.ts`

#### 常量定义

| 常量 | 值 | 作用 |
|------|------|------|
| `DEFAULT_MAX_RESULT_SIZE_CHARS` | 50,000 | 单个工具结果的默认持久化阈值 |
| `MAX_TOOL_RESULT_TOKENS` | 100,000 | token 级预算 |
| `BYTES_PER_TOKEN` | 4 | 估算系数 |
| `MAX_TOOL_RESULT_BYTES` | 400,000 | 后备持久化阈值（无工具指定时） |
| `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` | 200,000 | 单轮并行工具结果总量预算 |
| `DEFAULT_MAX_MCP_OUTPUT_TOKENS` | 25,000 | MCP 输出 token 上限 |

#### 单结果持久化

超过阈值的大结果写入磁盘，替换为预览：

```
<persisted-output>
Output too large (125.3 KB). Full output saved to: /path/.claude/projects/.../tool-results/toolu_xxx.txt

Preview (first 2.0 KB):
[文件内容的前 2000 字节]
...
</persisted-output>
```

#### 并行预算控制（`enforceToolResultBudget`）

按 API 级用户消息分组（assistant 消息是唯一的分组边界），对每组执行三分区决策：

```
partitionByPriorDecision(candidates, state) → {mustReapply, frozen, fresh}
```

- **mustReapply**：之前已替换 → 用 Map 查找直接替换（零 I/O，字节一致）
- **frozen**：之前已见过但未替换 → 永远发送完整内容
- **fresh**：首次出现 → 可以做新的替换决策

替换选择策略：将 fresh 候选按大小**降序排列**，从最大的开始替换，直到总量在 200,000 字符预算内。

#### `ContentReplacementState` — 缓存稳定性核心

```typescript
export type ContentReplacementState = {
  seenIds: Set<string>       // 所有经过预算检查的 tool_use_id
  replacements: Map<string, string>  // 被替换的 id → 精确替换文本
}
```

**设计原则**：一旦某个 `tool_use_id` 的命运被决定（保留/替换），在整个对话生命周期内保持不变，确保 prompt cache 前缀稳定。

#### MCP 输出截断

- 字符预算 = `getMaxMcpOutputTokens() × 4`
- 先做廉价估算，如果超过阈值的 50%，再调用精确 token 计数 API
- 超限时截断字符串并添加截断说明

### 层级 2：Snip（历史裁剪）

**来源**：`src/services/compact/snipCompact.js`（runtime 加载，feature `HISTORY_SNIP` 门控）

- 对历史消息进行**中间段移除**（不同于前缀截断）
- 返回 `{messages, tokensFreed, boundaryMessage?}`
- `tokensFreed` 传给后续 autocompact 用于调整阈值
- 会话恢复时通过 `snipMetadata.removedUuids` 过滤已删除消息

### 层级 3：Microcompact（微压缩）

**来源**：`src/services/compact/microCompact.ts`

**可压缩工具白名单（`COMPACTABLE_TOOLS`）**：

```typescript
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,      // Read
  ...SHELL_TOOL_NAMES,      // Bash, PowerShell
  GREP_TOOL_NAME,           // Grep
  GLOB_TOOL_NAME,           // Glob
  WEB_SEARCH_TOOL_NAME,     // WebSearch
  WEB_FETCH_TOOL_NAME,      // WebFetch
  FILE_EDIT_TOOL_NAME,      // Edit
  FILE_WRITE_TOOL_NAME,     // Write
])
```

#### 模式 A：Time-based Microcompact（基于空闲时间）

**触发条件**：上次 assistant 回复至今超过 `gapThresholdMinutes`（默认 60 分钟）

**处理逻辑**：
1. 收集所有可压缩工具的 `tool_use_id`（按消息顺序）
2. `keepRecent = max(1, config.keepRecent)` — 保留最近 N 个（至少 1 个）
3. 其余所有工具结果内容替换为：`[Old tool result content cleared]`

**关键**："旧"不是按时间戳判断，而是"消息顺序中除最后 N 个之外的所有可压缩工具结果"。

#### 模式 B：Cached Microcompact（API 层缓存删除）

更优雅的方案——不修改本地消息：
- 对旧的 `tool_result` 块添加 `cache_reference: tool_use_id`
- 在最新 user 消息中插入 `cache_edits` 块：`{type:'cache_edits', edits:[{type:'delete', cache_reference:'toolu_xxx'}]}`
- API 端执行删除，本地消息完全不变，前缀对齐保持完美

### 层级 4：Context Collapse（上下文折叠）

**来源**：`src/services/contextCollapse/`（feature `CONTEXT_COLLAPSE` 门控）

- 对较早的上下文段用**摘要替代原文**
- 是读时投影（read-time projection），不修改原始消息数组
- 启用时**禁用** proactive autocompact，由 collapse 接管上下文管理

### 层级 5：Autocompact（自动压缩）

**来源**：`src/services/compact/autoCompact.ts`

#### 触发阈值公式

```
effectiveContextWindow = getContextWindowForModel(model) - min(getMaxOutputTokensForModel(model), 20_000)
autocompactThreshold = effectiveContextWindow - 13_000  // AUTOCOMPACT_BUFFER_TOKENS
```

可选 env 覆盖：`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（1-100%）。

#### 执行优先级

1. **Session Memory Compaction**（`sessionMemoryCompact.ts`）：
   - 找到上次摘要点
   - 向后扩展尾部，直到满足 `minTokens`（10,000）和 `minTextBlockMessages`（5），但不超过 `maxTokens`（40,000）
   - 前面全部替换为摘要
   
2. **完整 Compact**（`compact.ts`）：
   - 让模型生成整个对话的摘要
   - 所有历史消息替换为：compact 边界标记 + 摘要 user 消息 + 附件 + session start hook
   
3. **PTL Retry**（`truncateHeadForPTLRetry`）：
   - 如果摘要本身导致 "prompt too long"
   - 逐步丢弃最老的 API 轮次组（最多 3 次重试）
   - 每次丢弃量：可解析 token gap 时按 gap 累加组大小；否则丢弃 `max(1, floor(20% × groupCount))` 个组
   - 断路器：连续 3 次 autocompact 失败后跳过（`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES`）

### 层级 6：Token 硬限制检查

```typescript
const { isAtBlockingLimit } = calculateTokenWarningState(
  tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
  toolUseContext.options.mainLoopModel,
)
```

超过硬限制 → 报错退出，对话无法继续。

---

## 四、系统提示中的配套指令

Claude Code 在系统提示中告知模型这些优化的存在，让模型**主动配合**：

### `summarize_tool_results` 段（始终包含）

> When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.

### `frc` 段（Cached Microcompact 启用时）

> Old tool results will be automatically cleared from context to free up space. The N most recent results are always kept.

**效果**：模型在文本回复中主动记录关键信息，而不是完全依赖工具结果原文。

---

## 五、Prompt Caching 稳定性保障

所有优化的设计围绕一个核心原则：**保持 prompt cache 前缀稳定**。

### 5.1 系统提示缓存

`buildSystemPromptBlocks` 将系统提示按 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 分割，生成多个 `TextBlockParam`：

- 静态段 → `scope: 'global'`（全局缓存）
- 动态段 → `scope: 'org'` 或不缓存
- TTL：满足条件时 `1h`，否则 `ephemeral`（~5min）

### 5.2 消息缓存

只在**一条消息**（最后一条或倒数第二条）的最后一个 content block 上放一个 `cache_control`，避免多余的 KV 页保护。

### 5.3 稳定性措施

| 机制 | 作用 | 来源 |
|------|------|------|
| 工具按名称排序 | 保证工具定义列表顺序一致 | `assembleToolPool` |
| `toolSchemaCache` | 工具 schema 首次渲染后冻结，避免 prompt 文案漂移 | `toolSchemaCache.ts` |
| `ContentReplacementState` | 替换决策一次冻结，后续字节一致 | `toolResultStorage.ts` |
| Beta header 粘性锁存 | 一旦发送过某个 beta header，后续始终发送 | `claude.ts` |
| 单一 cache breakpoint | 只放一个 `cache_control`，避免多余 KV 保护 | `addCacheBreakpoints` |
| TTL 会话锁存 | `1h`/`5m` TTL 在会话内不切换 | `should1hCacheTTL` |
| 缓存破坏检测 | cache_read 下降 >5% 且 >2000 token 时告警 | `promptCacheBreakDetection.ts` |

---

## 六、消息标准化：发送前的最终清洗

`normalizeMessagesForAPI`（`src/utils/messages.ts`）对所有消息做最终清洗：

### 6.1 消息类型处理

| 消息类型 | 处理方式 |
|---------|---------|
| `user` | 保留，连续的合并，`tool_result` 提升到前面 |
| `assistant` | 保留，相同 `message.id` 的合并（流式重组） |
| `progress` | **丢弃**（不发送给 API） |
| `system`（`local_command`） | 转为 user content 合并到相邻 user 消息 |
| `attachment` | 转为 user 消息 |
| 虚拟消息（`isVirtual`） | **丢弃** |
| 其他 system | **丢弃** |

### 6.2 `tool_result` 提升

`hoistToolResults` 确保所有 `tool_result` blocks 排在 user 消息 content 的最前面，非 tool_result blocks 排后面。

### 6.3 配对修复（`ensureToolResultPairing`）

- 缺失 `tool_result`：插入 `[Tool result missing due to internal error]` + `is_error: true`
- 孤立 `tool_result`：直接过滤掉
- 重复 ID：去重
- 不完整的 `server_tool_use`/`mcp_tool_use`：从 assistant content 中过滤

---

## 七、完整优化矩阵图

```
        新鲜工具结果
            │
  ┌─────────┼─────────┐
  │ >50k字符 │  正常    │ >200k(并行总量)
  │ 持久化   │  原样   │  最大的先持久化
  └────┬─────┴────┬────┴────┬────┘
       ▼          ▼         ▼
       多轮对话后
       │
  ┌────┴────────────────────┐
  │ Time-based Microcompact │  空闲>60min → 除最近N个外全部清除
  │ Cached Microcompact     │  API层 cache_edits 删除
  └────┬────────────────────┘
       ▼
  ┌────┴────────────────┐
  │ Context Collapse     │  早期上下文 → 摘要折叠
  └────┬────────────────┘
       ▼
  ┌────┴────────────────┐
  │ Session Memory       │  保留尾部10k-40k token
  │ Autocompact          │  接近窗口限制 → 完整摘要
  │ PTL Retry            │  溢出 → 丢弃最老轮次
  └─────────────────────┘
```

---

## 八、设计哲学总结

1. **渐进式降级**：从保留原文 → 预览替换 → 内容清除 → 摘要替换 → 完整压缩，精度逐步降低
2. **不可逆决策冻结**：一旦决定保留/替换某个结果，后续永不改变，保证缓存稳定
3. **读时投影**：大部分优化是"投影"而非修改原始数据，可以恢复（如 Context Collapse、Snip）
4. **系统提示配合**：明确告知模型"结果会被清理"，促使模型主动在文本中保存关键信息
5. **缓存优先**：所有设计都围绕 prompt cache 前缀稳定性，最大化 cache 命中率

---

## 关键文件索引

| 关注点 | 文件路径 | 核心符号 |
|--------|---------|---------|
| 查询主循环 | `src/query.ts` | `queryLoop`、6 层管线 |
| 工具结果持久化/预算 | `src/utils/toolResultStorage.ts` | `enforceToolResultBudget`、`ContentReplacementState` |
| 大小限制常量 | `src/constants/toolLimits.ts` | `DEFAULT_MAX_RESULT_SIZE_CHARS`、`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` |
| 微压缩 | `src/services/compact/microCompact.ts` | `maybeTimeBasedMicrocompact`、`COMPACTABLE_TOOLS` |
| 自动压缩 | `src/services/compact/autoCompact.ts` | `autoCompactIfNeeded`、`getAutoCompactThreshold` |
| 完整压缩 | `src/services/compact/compact.ts` | `compactConversation`、`truncateHeadForPTLRetry` |
| 会话记忆压缩 | `src/services/compact/sessionMemoryCompact.ts` | `trySessionMemoryCompaction` |
| 消息标准化 | `src/utils/messages.ts` | `normalizeMessagesForAPI`、`ensureToolResultPairing` |
| 输入字段清理 | `src/utils/api.ts` | `normalizeToolInputForAPI` |
| API 请求构建 | `src/services/api/claude.ts` | `queryModel`、`buildSystemPromptBlocks`、`addCacheBreakpoints` |
| 缓存破坏检测 | `src/services/api/promptCacheBreakDetection.ts` | 哈希检测 + 告警 |
| 工具 schema 缓存 | `src/services/api/toolSchemaCache.ts` | `toolSchemaCache` |
| MCP 截断 | `src/utils/mcpValidation.ts` | `truncateMcpContent` |
| 系统提示 | `src/constants/prompts.ts` | `SUMMARIZE_TOOL_RESULTS_SECTION`、`getFunctionResultClearingSection` |

---

## 相关文档

- **[消息组装与发送流程深度分析](./message-assembly-analysis.md)** — 完整的消息组装顺序、系统提示结构、附件注入
- **[工具调用输入与结果的完整格式详解](./tool-call-format-analysis.md)** — 从 tool_use 到 tool_result 的完整数据流
