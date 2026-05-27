# Claude Code 消息组装与发送流程深度分析

> 分析 Claude Code 每次用户发送消息后，发给 LLM 的完整内容、顺序、以及各类压缩/剔除/格式转换机制。

---

## 一、整体流程概览

用户消息从输入到最终 API 调用，经历以下管线：

```
用户输入 → processUserInput() → query() → queryLoop() → queryModel() → anthropic.beta.messages.create()
```

核心文件链路：

| 阶段 | 文件 | 核心函数 |
|------|------|---------|
| 输入处理 | `src/utils/processUserInput/processUserInput.ts` | `processUserInput` |
| SDK入口 | `src/QueryEngine.ts` | `submitMessage` / `ask` |
| 对话循环 | `src/query.ts` | `query` → `queryLoop` |
| API调用 | `src/services/api/claude.ts` | `queryModelWithStreaming` → `queryModel` |
| HTTP客户端 | `src/services/api/client.ts` | `getAnthropicClient` |

---

## 二、发送给 LLM 的三大组成部分

最终 API 请求参数（`anthropic.beta.messages.create`）的结构为：

```typescript
{
  system: TextBlockParam[],    // 系统提示（多段 text block）
  messages: MessageParam[],    // 对话历史（user/assistant 交替）
  tools: BetaToolUnion[],      // 工具定义 schema
  stream: true,
  // ...其他参数（thinking, betas, model 等）
}
```

---

## 三、`system` 系统提示的组装顺序

系统提示是一个 `string[]` 数组，最终通过 `buildSystemPromptBlocks()` 转换为 `TextBlockParam[]` 并附加 `cache_control`。

### 3.1 基础内容

来源：`getSystemPrompt()` in `src/constants/prompts.ts`

分为 **静态段** 和 **动态段**，中间有 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 标记分隔（用于 prompt caching）：

**静态段（可全局缓存）：**

1. `getSimpleIntroSection` — 身份声明 + 网络安全规则 + URL规则
2. `getSimpleSystemSection` — 系统级行为准则（权限、标签、hooks、压缩说明）
3. `getSimpleDoingTasksSection` — 编码任务指南（除非 outputStyle 关闭）
4. `getActionsSection` — 危险操作确认规则
5. `getUsingYourToolsSection` — 各工具使用指南（Read/Edit/Write/Glob/Grep/Bash 等）
6. `getSimpleToneAndStyleSection` — 语气和风格指南
7. `getOutputEfficiencySection` — 输出效率指南

**`SYSTEM_PROMPT_DYNAMIC_BOUNDARY`** — 分隔标记（仅在 `shouldUseGlobalCacheScope()` 时插入）

**动态段（registry 管理、按需重算）：**

8. `session_guidance` — 会话特定指南（AskUserQuestion、Agent/Explore/Skills 等）
9. `memory` — 加载 memory prompt（`loadMemoryPrompt()`）
10. `ant_model_override` — 内部模型覆写（仅 Anthropic 内部）
11. `env_info_simple` — 环境信息（cwd、git、平台、shell、模型、日期等）
12. `language` — 语言设置
13. `output_style` — 输出风格配置
14. `mcp_instructions` — MCP 服务器指南（**危险的非缓存段**，MCP 连接/断开会变化）
15. `scratchpad` — 草稿本指令
16. `frc` — function-result-clearing 段（模型相关门控）
17. `summarize_tool_results` — 提醒模型保留工具结果关键信息
18. 可选：`token_budget`、`brief` 等

对应代码：

```typescript
// src/constants/prompts.ts
return [
  // --- Static content (cacheable) ---
  getSimpleIntroSection(outputStyleConfig),
  getSimpleSystemSection(),
  outputStyleConfig === null || outputStyleConfig.keepCodingInstructions === true
    ? getSimpleDoingTasksSection()
    : null,
  getActionsSection(),
  getUsingYourToolsSection(enabledTools),
  getSimpleToneAndStyleSection(),
  getOutputEfficiencySection(),
  // === BOUNDARY MARKER ===
  ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
  // --- Dynamic content (registry-managed) ---
  ...resolvedDynamicSections,
].filter(s => s !== null)
```

动态段通过 `systemPromptSection()` 和 `DANGEROUS_uncachedSystemPromptSection()` 注册，支持 memoize 缓存和按需失效。

### 3.2 API 调用前的最终系统提示拼装

在 `claude.ts` 的 `queryModel` 中，系统提示被进一步包装：

```typescript
// src/services/api/claude.ts ~1358-1368
systemPrompt = asSystemPrompt(
  [
    getAttributionHeader(fingerprint),           // 1. 指纹标识
    getCLISyspromptPrefix({...}),                // 2. CLI 模式前缀
    ...systemPrompt,                             // 3. 上面的完整系统提示
    ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),   // 4. Advisor 指令
    ...(injectChromeHere ? [CHROME_TOOL_SEARCH_INSTRUCTIONS] : []),  // 5. Chrome 工具搜索指令
  ].filter(Boolean),
)
```

**最终系统提示的完整顺序：**

1. **Attribution Header** — 指纹标识
2. **CLI Sysprompt Prefix** — CLI 模式前缀
3. **[静态段 1-7]** — 来自 `getSystemPrompt`
4. **[动态段 8-18]** — 来自 `getSystemPrompt`
5. **Advisor Tool Instructions** — 如果启用 advisor 模型
6. **Chrome Tool Search Instructions** — 如果有 Chrome MCP 工具
7. **System Context** — git status + cacheBreaker（在 `query.ts` 中通过 `appendSystemContext` 追加）

### 3.3 `systemContext` 的追加

在 `query.ts` 中：

```typescript
// src/query.ts ~449-451
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

`appendSystemContext` 将 key-value 对象拼为 `key: value` 格式，追加到系统提示数组尾部。

`systemContext` 包含（来自 `src/context.ts` 的 `getSystemContext`）：

- **gitStatus** — 当前分支、主分支、简短状态、最近提交
- **cacheBreaker** — 缓存打断注入（实验特性，feature `BREAK_CACHE_COMMAND`）

### 3.4 转化为 API 格式

`buildSystemPromptBlocks` 将 `string[]` 按 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 分割，生成多个 `TextBlockParam`，每个 block 可独立带 `cache_control`：

- 静态段用 **`global`** scope
- 动态段用 **`org`** scope 或不缓存
- 支持 `ephemeral` 和 `1h` TTL

---

## 四、`messages` 消息数组的构建

### 4.1 原始消息类型

内部使用 `Message[]` 类型，包含：`user`、`assistant`、`system`、`progress`、`attachment` 等类型。

### 4.2 消息处理管线（在 `queryLoop` 中按顺序执行）

在实际调用 API 之前，`messagesForQuery` 经历以下 **6 层处理**：

```
原始消息 → ① 工具结果预算 → ② Snip → ③ Microcompact → ④ Context Collapse → ⑤ Autocompact → ⑥ Token限制检查
```

#### Step 1 — `applyToolResultBudget`（工具结果预算）

```typescript
// src/query.ts ~379-394
messagesForQuery = await applyToolResultBudget(
  messagesForQuery,
  toolUseContext.contentReplacementState,
  persistReplacements ? records => void recordContentReplacement(...) : undefined,
  new Set(toolUseContext.options.tools.filter(t => !Number.isFinite(t.maxResultSizeChars)).map(t => t.name)),
)
```

- 单条消息（含并行工具结果）上限 **200,000** 字符（`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`）
- 超出的大工具结果会被持久化到磁盘，替换为 `<persisted-output>` + 前 **2000** 字节预览
- `ContentReplacementState` 锁定替换决策，保证 prompt cache 稳定性

#### Step 2 — `snipCompactIfNeeded`（历史裁剪）

```typescript
// src/query.ts ~401-410
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
}
```

- 对历史消息进行投影/裁剪，释放前缀 token
- `snipTokensFreed` 传递给后续 autocompact 用于阈值调整

#### Step 3 — Microcompact（微压缩）

```typescript
// src/query.ts ~414-426
const microcompactResult = await deps.microcompact(
  messagesForQuery, toolUseContext, querySource,
)
messagesForQuery = microcompactResult.messages
```

两种机制：

- **Cached Microcompact**（缓存编辑模式）：通过 `cache_edits` 在 API 端删除旧的工具结果（本地消息不变），需要 `CACHED_MICROCOMPACT` feature flag + 模型支持
- **Time-based Microcompact**（基于时间）：空闲超时后，将旧的可压缩工具结果内容替换为 `[Old tool result content cleared]`

可压缩工具白名单（`COMPACTABLE_TOOLS`）：`Read`、`Grep`、`Glob`、`WebSearch`、`WebFetch`、`Shell`、`FileEdit`、`FileWrite` 等

#### Step 4 — Context Collapse（上下文折叠）

```typescript
// src/query.ts ~440-447
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery, toolUseContext, querySource,
  )
  messagesForQuery = collapseResult.messages
}
```

- 对较早的上下文段进行折叠，用摘要替代
- 折叠是读时投影（read-time projection），不修改 REPL 原始数组

#### Step 5 — Autocompact（自动压缩）

```typescript
// src/query.ts ~454-467
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery, toolUseContext,
  { systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: messagesForQuery },
  querySource, tracking, snipTokensFreed,
)
```

- **触发阈值**：`effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS (13,000)`
- **有效窗口** = 模型上下文窗口 - `min(maxOutputForModel, 20,000)`
- 触发后执行顺序：
  1. 先尝试 **Session Memory Compaction**（保留尾部 10k-40k token）
  2. 不行再执行 **完整 Compact**（让模型生成对话摘要）
- **Prompt-too-long 重试**：`truncateHeadForPTLRetry` 逐步丢弃最老的 API 轮次组（最多 3 次重试）

#### Step 6 — Token 限制检查（blocking limit）

```typescript
// src/query.ts ~637-648
const { isAtBlockingLimit } = calculateTokenWarningState(
  tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
  toolUseContext.options.mainLoopModel,
)
if (isAtBlockingLimit) {
  yield createAssistantAPIErrorMessage({
    content: PROMPT_TOO_LONG_ERROR_MESSAGE,
    error: 'invalid_request',
  })
  return { reason: 'blocking_limit' }
}
```

### 4.3 `prependUserContext` — 注入用户上下文

在所有压缩处理之后，调用 API 之前，在消息数组**最前面**插入一条合成的 meta `user` 消息：

```typescript
// src/query.ts ~659-661
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
```

具体实现：

```typescript
// src/utils/api.ts ~461-473
return [
  createUserMessage({
    content: `<system-reminder>
As you answer the user's questions, you can use the following context:
# claudeMd
[CLAUDE.md 内容]
# currentDate
Today's date is ...

IMPORTANT: this context may or may not be relevant to your tasks.
You should not respond to this context unless it is highly relevant to your task.
</system-reminder>`,
    isMeta: true,
  }),
  ...messages,
]
```

`userContext` 包含（来自 `src/context.ts` 的 `getUserContext` + REPL 增强）：

- **claudeMd** — CLAUDE.md 项目/用户记忆文件的合并内容
- **currentDate** — `Today's date is ...`
- **coordinator context**（协调器模式下）— worker 工具列表 + MCP 名称 + 草稿本路径
- **terminalFocus**（仅 proactive 模式）— 用户是否正在看终端

### 4.4 `normalizeMessagesForAPI` — 消息标准化

在 `claude.ts` 的 `queryModel` 中，消息经过标准化处理：

- **剔除** `progress`、虚拟消息、纯系统消息
- **合并** 连续 `user` 消息（Bedrock 兼容性）
- **合并** 相同 `message.id` 的 `assistant` 片段（流式分片重组）
- **标准化** `tool_use` 块：
  - `normalizeToolInputForAPI` 清理多余字段
  - 使用工具的 canonical name
  - 非 Tool Search 模式下剥离 `caller` 等扩展字段

```typescript
// src/utils/messages.ts ~2201-2240
case 'assistant': {
  const toolSearchEnabled = isToolSearchEnabledOptimistic()
  const normalizedMessage = {
    ...message,
    message: {
      ...message.message,
      content: message.message.content.map(block => {
        if (block.type === 'tool_use') {
          const tool = tools.find(t => toolMatchesName(t, block.name))
          const normalizedInput = tool
            ? normalizeToolInputForAPI(tool, block.input)
            : block.input
          const canonicalName = tool?.name ?? block.name
          // Tool Search 模式下保留所有字段，否则只保留标准字段
          if (toolSearchEnabled) {
            return { ...block, name: canonicalName, input: normalizedInput }
          }
          return {
            type: 'tool_use', id: block.id,
            name: canonicalName, input: normalizedInput,
          }
        }
        return block
      }),
    },
  }
```

### 4.5 `ensureToolResultPairing` — 工具配对修复

- 为缺少 `tool_result` 的 `tool_use` 插入合成错误响应
- 剥离孤立的 `tool_result`（找不到对应 `tool_use`）
- 去重重复的 `tool_use`/`tool_result` ID
- 清理不完整的 `server_tool_use`

### 4.6 `addCacheBreakpoints` — 缓存断点

将内部消息转为 API `MessageParam`，并在**最后一条**（或倒数第二条，取决于 `skipCacheWrite`）消息的最后一个 content block 上添加 `cache_control`。

对于 Cached Microcompact，还会：
- 重新插入 pinned `cache_edits`
- 插入新的 `cache_edits`
- 在最后一条缓存消息之前的 `tool_result` blocks 上添加 `cache_reference`

### 4.7 最终 `messages` 数组结构

```
[
  { role: "user",      content: "<system-reminder>...claudeMd...date...</system-reminder>" },
  { role: "user",      content: "用户第一条消息" },
  { role: "assistant", content: [text_block, tool_use_block, ...] },
  { role: "user",      content: [tool_result_block, ...] },
  { role: "assistant", content: [...] },
  { role: "user",      content: [tool_result_block, text_block(attachment), ...] },
  ...
  { role: "user",      content: "用户最新消息 + 附件" },   // ← cache_control 标记
]
```

---

## 五、`tools` 工具定义的构建

### 5.1 工具注册与过滤

```
getAllBaseTools() → getTools(filterByDeny/enable) → assembleToolPool(builtIn + MCP, sorted by name)
```

- `getAllBaseTools()` — 所有内置工具的完整列表（Feature flag 门控）
- `getTools()` — 过滤禁用/deny 规则/REPL 模式限制
- `assembleToolPool()` — 内置 + MCP 工具合并，**按名称排序**（保证 prompt cache 稳定），`uniqBy` 内置优先

核心代码：

```typescript
// src/tools.ts
export function assembleToolPool(
  permissionContext: ToolPermissionContext,
  mcpTools: Tools,
): Tools {
  const builtInTools = getTools(permissionContext)
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy(
    [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
    'name',
  )
}
```

### 5.2 Tool Search 机制下的动态过滤

在 `claude.ts` 中，启用 Tool Search 时：

- **非延迟工具** — 始终包含
- **ToolSearch 工具本身** — 始终包含
- **延迟工具** — 仅当历史中已被 "发现"（`extractDiscoveredToolNames`）时才包含
- 未启用 Tool Search 时 — 剥离 ToolSearch 工具

### 5.3 Schema 转换（`toolToAPISchema`）

每个工具通过 `toolToAPISchema()` 转为 `BetaTool` 对象：

- **description**: `tool.prompt()` 返回的自然语言描述
- **input_schema**: 从 Zod schema 通过 `zodToJsonSchema` 转换，或直接使用 `inputJSONSchema`
- 可选字段：
  - `strict: true` — 严格模式（feature + 模型支持）
  - `eager_input_streaming: true` — 工具输入流式传输
  - `defer_loading` — 延迟加载标记
  - `cache_control` — 缓存控制
- `toolSchemaCache` 做会话级缓存，避免每轮重算

### 5.4 最终工具数组

```typescript
const allTools = [...toolSchemas, ...extraToolSchemas]
// extraToolSchemas 包含 advisor 等服务器端工具
```

---

## 六、工具调用结果的格式转换与压缩

### 6.1 工具执行结果 → API 格式

```
tool.call() → tool.mapToolResultToToolResultBlockParam() → processToolResultBlock() → UserMessage
```

1. **`mapToolResultToToolResultBlockParam`** — 每个工具自定义的结果映射，输出 `ToolResultBlockParam`
2. **空结果保护** — 替换为 `(toolName completed with no output)`
3. **大结果持久化** — 超过阈值（默认 **50,000** 字符）的结果写入磁盘，替换为 `<persisted-output>` + 前 **2000** 字节预览
4. **图片结果** — 跳过持久化，保持多模态 content block 原样

### 6.2 错误格式化

- **验证失败**：`<tool_use_error>InputValidationError: ...</tool_use_error>` + `is_error: true`
- **权限拒绝**：纯文本 `tool_result` + `is_error: true`
- **附带图片**：放在**同级顶层**（因为 `is_error` 的 `tool_result` 不允许非文本内容）

```typescript
// src/services/tools/toolExecution.ts ~1029-1046
const messageContent: ContentBlockParam[] = [
  {
    type: 'tool_result',
    content: errorMessage,
    is_error: true,
    tool_use_id: toolUseID,
  },
]
// 图片 blocks 放在 tool_result 同级
if (rejectContentBlocks?.length) {
  messageContent.push(...rejectContentBlocks)
}
```

### 6.3 工具结果在历史中的多层压缩

| 层级 | 时机 | 处理方式 | 阈值/条件 |
|------|------|---------|----------|
| **单结果限制** | 工具执行后立即 | 超限 → 持久化到磁盘 + 预览 | 50,000 字符（`DEFAULT_MAX_RESULT_SIZE_CHARS`） |
| **并行结果预算** | `queryLoop` 最前 | 单轮并行工具总量超限 → 最大的先持久化 | 200,000 字符（`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`） |
| **Microcompact** | `queryLoop` 中 | 旧的可压缩工具结果 → 清除或 `cache_edits` 删除 | 基于时间/数量策略 |
| **Context Collapse** | `queryLoop` 中 | 较早上下文段 → 摘要替代 | feature-gated |
| **Autocompact** | `queryLoop` 中 | 接近上下文窗口限制 → 模型生成整体摘要 | effectiveWindow - 13,000 tokens |
| **MCP 输出截断** | MCP 工具执行后 | 超限 → 按 `tokens*4` 字符截断 | 25,000 token（`MAX_MCP_OUTPUT_TOKENS`） |
| **图片压缩** | FileRead/MCP | `compressImageBufferWithTokenLimit` 调整尺寸 | 基于 token 预算 |

### 6.4 工具结果的流式执行

- **StreamingToolExecutor**：工具在流式接收 `tool_use` blocks 时即可开始执行
- **并发控制**：`isConcurrencySafe` 工具可并行，非安全工具独占执行
- **结果按接收顺序** yield
- **Bash 错误中止**：Bash 工具错误会通过 `siblingAbortController` 中止同级工具

---

## 七、附件（Attachments）注入

每次用户发送消息时，`getAttachments()` 收集各类上下文附件，通过 `attachmentMessagesToUserMessages` 转为 `UserMessage`：

| 附件类型 | 内容 | 包装方式 |
|---------|------|---------|
| `ide_selection` | IDE 中选中的代码 | `"The user selected the lines..."` |
| `ide_opened_file` | 当前打开的文件 + 嵌套记忆文件 | 文件内容 + CLAUDE.md 层级规则 |
| `diagnostics` | IDE linter 错误 | `<new-diagnostics>...</new-diagnostics>` |
| `lsp_diagnostics` | LSP 诊断信息 | 同上 |
| `@` mentions | 用户 `@` 引用的文件/目录 | 文件内容读取 |
| `nested_memory` | 嵌套记忆文件 | CLAUDE.md 内容 |
| MCP deltas | MCP 服务器变更增量 | 服务器连接/断开信息 |
| skill discovery | 技能发现结果 | 可用技能列表 |
| plan mode | 计划模式上下文 | 当前计划状态 |
| todos | 待办事项 | 当前 TODO 列表 |

### 附件大小限制

- **IDE 选中代码**：超过 **2000** 字符截断 + `... (truncated)`
- **大文件**：`MAX_LINES_TO_READ` 行限制 + truncated 标记
- **compact_file_reference**：内容替换为 "read before summarize, too large"

---

## 八、Prompt Caching 策略

### 8.1 缓存位置

- **系统提示** — `buildSystemPromptBlocks` 按 `DYNAMIC_BOUNDARY` 分段
  - 静态段 → `global` scope
  - 动态段 → `org` scope 或不缓存
- **消息** — `addCacheBreakpoints` 在最后一条消息的最后一个 content block 加 `cache_control`
- **工具结果** — Cached Microcompact 用 `cache_reference` 标记可删除的 block，`cache_edits` 执行删除

### 8.2 缓存 TTL

- **`getCacheControl`** 返回 `{ type: 'ephemeral', ttl?: '1h', scope?: ... }`
- `1h` TTL 需满足：Bedrock 环境 或（订阅者资格 + GrowthBook 允许列表）
- TTL 在会话内保持稳定，避免缓存失效

### 8.3 缓存稳定性保障

- 工具按名称排序（`assembleToolPool`）— 保证工具列表顺序一致
- 工具 schema 会话级缓存（`toolSchemaCache`）— 避免 prompt 文案漂移
- 工具结果替换决策锁定（`ContentReplacementState`）— 同一 tool_use_id 的替换决策不变
- Beta header "sticky-on latch" 模式 — 一旦发送过某个 beta header，后续始终发送
- 缓存破坏检测（`promptCacheBreakDetection.ts`）— 哈希系统/工具内容，记录缓存命中率

---

## 九、Token 计数策略

### 9.1 Canonical 计数函数

```typescript
// src/utils/tokens.ts
export function tokenCountWithEstimation(messages: readonly Message[]): number
```

- 找到最后一条有 `usage` 数据的 assistant 消息
- 使用其 `input_tokens + cache_creation + cache_read + output_tokens` 作为基础
- 对其后的新消息使用 `roughTokenCountEstimation` 估算
- 估算公式：`content.length / 4`（约 4 字符 = 1 token）

### 9.2 精确计数（按需）

- `countTokensWithAPI` — 调用 Anthropic 的 `beta.messages.countTokens`
- `countTokensViaHaikuFallback` — 使用小模型作为后备
- 主要用于上下文可视化和分析，非每轮调用

---

## 十、完整数据流时序图

```
用户输入
  │
  ▼
processUserInput() ─→ 构建 UserMessage + 附件（slash command, @mentions, IDE context）
  │
  ▼
query() / queryLoop() 入口
  │
  ├─ ① applyToolResultBudget()     大工具结果→磁盘+预览，单轮总量≤200k字符
  ├─ ② snipCompactIfNeeded()       历史前缀裁剪（feature-gated）
  ├─ ③ microcompact()              旧工具结果→清除/cache_edits
  ├─ ④ contextCollapse()           早期上下文→摘要折叠
  ├─ ⑤ autocompact()               接近窗口限制→完整摘要
  ├─ ⑥ blocking limit check        超硬限制→报错退出
  │
  ▼
appendSystemContext(systemPrompt, {gitStatus, cacheBreaker})  ─→ 系统提示尾部追加
  │
  ▼
prependUserContext(messages, {claudeMd, date, ...})           ─→ 消息头部插入 <system-reminder>
  │
  ▼
queryModel() in claude.ts
  │
  ├─ 系统提示组装:
  │   [attribution + CLI prefix + 基础段 + 动态段 + advisor/chrome]
  │     └─ buildSystemPromptBlocks() → TextBlockParam[] + cache_control
  │
  ├─ 消息标准化:
  │   normalizeMessagesForAPI() → ensureToolResultPairing() → addCacheBreakpoints()
  │     └─ user/assistant 交替的 MessageParam[]
  │
  ├─ 工具构建:
  │   filteredTools.map(toolToAPISchema) + extraToolSchemas
  │     └─ BetaToolUnion[]
  │
  ▼
anthropic.beta.messages.create({ system, messages, tools, stream: true })
  │
  ▼
流式接收 assistant response（text + tool_use blocks）
  │
  ├─ StreamingToolExecutor 并发执行工具
  ├─ tool.call() → mapToolResultToToolResultBlockParam() → processToolResultBlock()
  ├─ 工具结果作为 user 消息追加到历史
  │
  ▼
如果有 tool_use → 继续 queryLoop 循环
如果无 tool_use → 返回最终响应
```

---

## 十一、关键文件索引

| 关注点 | 文件路径 | 核心符号 |
|--------|---------|---------|
| 用户输入处理 | `src/utils/processUserInput/processUserInput.ts` | `processUserInput` |
| SDK 轮次编排 | `src/QueryEngine.ts` | `submitMessage`, `ask` |
| 主循环 | `src/query.ts` | `query`, `queryLoop` |
| 系统提示段 | `src/constants/prompts.ts` | `getSystemPrompt`, `computeSimpleEnvInfo` |
| 段缓存 | `src/constants/systemPromptSections.ts` | `systemPromptSection`, `resolveSystemPromptSections` |
| Agent/Override 合并 | `src/utils/systemPrompt.ts` | `buildEffectiveSystemPrompt` |
| SDK prompt 获取 | `src/utils/queryContext.ts` | `fetchSystemPromptParts` |
| Git + CLAUDE.md | `src/context.ts` | `getUserContext`, `getSystemContext` |
| 上下文注入 | `src/utils/api.ts` | `prependUserContext`, `appendSystemContext`, `toolToAPISchema` |
| 消息标准化 | `src/utils/messages.ts` | `normalizeMessagesForAPI`, `ensureToolResultPairing` |
| API 请求构建 | `src/services/api/claude.ts` | `queryModel`, `buildSystemPromptBlocks`, `addCacheBreakpoints` |
| HTTP 客户端 | `src/services/api/client.ts` | `getAnthropicClient` |
| Token 管理 | `src/utils/tokens.ts` | `tokenCountWithEstimation` |
| Token 估算 | `src/services/tokenEstimation.ts` | `roughTokenCountEstimation`, `countTokensWithAPI` |
| 自动压缩 | `src/services/compact/autoCompact.ts` | `autoCompactIfNeeded`, `getEffectiveContextWindowSize` |
| 完整压缩 | `src/services/compact/compact.ts` | `compactConversation`, `truncateHeadForPTLRetry` |
| 微压缩 | `src/services/compact/microCompact.ts` | `maybeTimeBasedMicrocompact` |
| 会话记忆压缩 | `src/services/compact/sessionMemoryCompact.ts` | `trySessionMemoryCompaction` |
| 工具注册 | `src/tools.ts` | `getAllBaseTools`, `getTools`, `assembleToolPool` |
| 工具接口 | `src/Tool.ts` | `Tool`, `buildTool` |
| 工具执行 | `src/services/tools/toolExecution.ts` | `runToolUse`, `checkPermissionsAndCallTool` |
| 流式执行 | `src/services/tools/StreamingToolExecutor.ts` | `StreamingToolExecutor` |
| 批量编排 | `src/services/tools/toolOrchestration.ts` | `runTools`, `partitionToolCalls` |
| 结果持久化/预算 | `src/utils/toolResultStorage.ts` | `enforceToolResultBudget`, `ContentReplacementState` |
| 结果大小限制 | `src/constants/toolLimits.ts` | `DEFAULT_MAX_RESULT_SIZE_CHARS`, `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` |
| MCP 截断 | `src/utils/mcpValidation.ts` | `truncateMcpContent`, `getMaxMcpOutputTokens` |
| 附件系统 | `src/utils/attachments.ts` | `getAttachments`, `getAttachmentMessages` |
| 缓存检测 | `src/services/api/promptCacheBreakDetection.ts` | 哈希检测 + 通知 |

---

## 相关文档

- **[工具调用输入与结果的完整格式详解](./tool-call-format-analysis.md)** — 追踪从 LLM 发出 `tool_use` → 工具执行 → 结果包装为 `tool_result` → 重新组织发回 LLM 的完整数据流，包含具体工具的 `mapToolResultToToolResultBlockParam` 实现示例、并行工具的预算控制机制、消息标准化逻辑、以及完整的 Read 工具调用数据流示例。
