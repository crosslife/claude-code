# Claude Code 工具调用输入与结果的完整格式详解

> 追踪从 LLM 发出 `tool_use` → 工具执行 → 结果包装为 `tool_result` → 重新组织发回 LLM 的完整数据流。

---

## 1. LLM 响应中 `tool_use` 的接收与存储

### 1.1 流式接收

LLM 以流式返回 assistant 内容。对于 `tool_use` 类型的 content block：

```typescript
// src/services/api/claude.ts ~1995-2050
case 'content_block_start':
  switch (part.content_block.type) {
    case 'tool_use':
      contentBlocks[part.index] = {
        ...part.content_block,     // { type: 'tool_use', id: 'toolu_xxx', name: 'Read' }
        input: '',                 // input 初始为空字符串
      }
      break
  }

// 逐步累加 JSON delta
case 'input_json_delta':
  contentBlock.input += delta.partial_json    // 拼接 JSON 片段字符串

// block 完成时
case 'content_block_stop':
  const m: AssistantMessage = {
    type: 'assistant',
    message: {
      ...partialMessage,
      content: normalizeContentFromAPI([contentBlock], tools, agentId),
    },
  }
  yield m
```

关键：Claude Code **没有使用 SDK 的 `BetaMessageStream`**（因为其 `partialParse()` 有 O(n²) 问题），而是手动累积 `input_json_delta` 字符串。

### 1.2 `normalizeContentFromAPI` — 输入解析与标准化

```typescript
// src/utils/messages.ts ~2659-2719
case 'tool_use': {
  // 1. JSON 字符串 → 对象
  if (typeof contentBlock.input === 'string') {
    normalizedInput = safeParseJSON(contentBlock.input) ?? {}
  } else {
    normalizedInput = contentBlock.input
  }
  
  // 2. 工具级标准化
  const tool = findToolByName(tools, contentBlock.name)
  if (tool) {
    normalizedInput = normalizeToolInput(tool, normalizedInput, agentId)
  }
  
  return { ...contentBlock, input: normalizedInput }
}
```

### 1.3 内部存储的 AssistantMessage 结构

每个流式 content block 生成一条独立的 `AssistantMessage`（相同 `message.id`），后续在 `normalizeMessagesForAPI` 中合并：

```typescript
{
  type: 'assistant',
  uuid: 'uuid-xxx',
  timestamp: '2026-04-21T...',
  message: {
    id: 'msg_xxx',              // 同一 API 响应的所有 block 共享此 id
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    content: [
      // 文本 block
      { type: 'text', text: '让我读取该文件。' },
    ],
    // 或 tool_use block
    content: [
      {
        type: 'tool_use',
        id: 'toolu_abc123',
        name: 'Read',
        input: { file_path: '/path/to/foo.ts' }
      },
    ],
    usage: { input_tokens: 1234, output_tokens: 56, ... },
    stop_reason: 'tool_use',
  },
  costUSD: 0.003,
}
```

---

## 2. 工具执行与结果映射

### 2.1 执行流程

```
tool_use block → runToolUse() → checkPermissionsAndCallTool()
  → tool.call(parsedInput, context, canUseTool, parentMessage)
  → tool.mapToolResultToToolResultBlockParam(result.data, toolUseID)
  → processPreMappedToolResultBlock() / processToolResultBlock()
  → 包装为 UserMessage
```

### 2.2 具体工具的 `mapToolResultToToolResultBlockParam` 实现

**Read 工具 — 文本文件**：

```typescript
// src/tools/FileReadTool/FileReadTool.ts ~652-716
// 输出：
{
  type: 'tool_result',
  tool_use_id: 'toolu_abc123',
  content: '     1|import fs from "fs"\n     2|...\n'   // 带行号格式的文件内容
}
```

**Read 工具 — 图片文件**：

```typescript
{
  type: 'tool_result',
  tool_use_id: 'toolu_abc123',
  content: [
    {
      type: 'image',
      source: {
        type: 'base64',
        data: 'iVBORw0KGgo...',
        media_type: 'image/png'
      }
    }
  ]
}
```

**Bash 工具**：

```typescript
// src/tools/BashTool/BashTool.tsx ~555-622
// 正常输出：
{
  type: 'tool_result',
  tool_use_id: 'toolu_def456',
  content: 'file1.ts\nfile2.ts\nfile3.ts',      // stdout
  // 或拼接：stdout + '\n' + stderr
}
// 中断输出：
{
  type: 'tool_result',
  tool_use_id: 'toolu_def456',
  content: '...',
  is_error: true
}
// 大输出（已持久化）：
{
  type: 'tool_result',
  tool_use_id: 'toolu_def456',
  content: '<persisted-output>\nOutput too large (125.3 KB). Full output saved to: /path/to/toolu_def456.txt\n\nPreview (first 2.0 KB):\n...\n</persisted-output>'
}
```

**Grep 工具 — 内容模式**：

```typescript
// src/tools/GrepTool/GrepTool.ts ~254-308
{
  type: 'tool_result',
  tool_use_id: 'toolu_ghi789',
  content: 'Found 3 files\npath/to/file1.ts\npath/to/file2.ts\npath/to/file3.ts'
}
```

### 2.3 `processToolResultBlock` — 持久化与空结果处理

```typescript
// src/utils/toolResultStorage.ts ~272-334
async function maybePersistLargeToolResult(toolResultBlock, toolName, threshold) {
  const content = toolResultBlock.content
  
  // 1. 空结果保护
  if (isToolResultContentEmpty(content)) {
    return { ...toolResultBlock, content: `(${toolName} completed with no output)` }
  }
  
  // 2. 图片内容跳过持久化
  if (hasImageBlock(content)) {
    return toolResultBlock
  }
  
  // 3. 检查大小
  const size = contentSize(content)
  if (size <= threshold) {       // 默认阈值 50,000 字符
    return toolResultBlock
  }
  
  // 4. 超过阈值 → 写磁盘 + 返回预览
  const result = await persistToolResult(content, toolResultBlock.tool_use_id)
  const message = buildLargeToolResultMessage(result)
  return { ...toolResultBlock, content: message }
}
```

**持久化后的替换内容格式**：

```
<persisted-output>
Output too large (125.3 KB). Full output saved to: /path/.claude/projects/.../tool-results/toolu_abc123.txt

Preview (first 2.0 KB):
[文件内容的前 2000 字节，在最近的换行符处截断]
...
</persisted-output>
```

---

## 3. 工具结果包装为 UserMessage

### 3.1 单工具结果

```typescript
// src/services/tools/toolExecution.ts ~1403-1474
async function addToolResult(toolUseResult, preMappedBlock?) {
  const toolResultBlock = preMappedBlock
    ? await processPreMappedToolResultBlock(preMappedBlock, tool.name, tool.maxResultSizeChars)
    : await processToolResultBlock(tool, toolUseResult, toolUseID)

  const contentBlocks: ContentBlockParam[] = [toolResultBlock]
  
  // 用户批准时附带的反馈文本
  if (permissionDecision.acceptFeedback) {
    contentBlocks.push({ type: 'text', text: permissionDecision.acceptFeedback })
  }
  
  // 权限决策中的图片（如粘贴的截图）
  if (allowContentBlocks?.length) {
    contentBlocks.push(...allowContentBlocks)
  }
  
  resultingMessages.push({
    message: createUserMessage({ content: contentBlocks, ... }),
  })
}
```

**单工具结果的内部 UserMessage 结构**：

```typescript
{
  type: 'user',
  uuid: 'uuid-yyy',
  timestamp: '2026-04-21T...',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_abc123',
        content: '     1|import fs from "fs"\n     2|...',
        // is_error: false (省略)
      },
      // 可能有的同级 blocks：
      // { type: 'text', text: '用户审批反馈' },
      // { type: 'image', source: { ... } },
    ],
  },
  toolUseResult: { ... },    // 内部保留的原始结果（agent 模式下可能省略）
  sourceToolAssistantUUID: 'uuid-xxx',  // 关联的 assistant 消息
}
```

### 3.2 权限拒绝的工具结果

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
// 图片必须放在 tool_result 外面（is_error 的 tool_result 不接受非文本内容）
if (rejectContentBlocks?.length) {
  messageContent.push(...rejectContentBlocks)
}
```

### 3.3 输入验证失败的工具结果

```typescript
{
  type: 'tool_result',
  tool_use_id: 'toolu_abc123',
  content: '<tool_use_error>InputValidationError: Expected string, received number at "file_path"</tool_use_error>',
  is_error: true,
}
```

---

## 4. 并行工具调用的结果组织

### 4.1 LLM 发出多个 tool_use

一个 assistant 消息可以包含多个 `tool_use` blocks：

```typescript
// assistant 消息的 content 数组
[
  { type: 'text', text: '我来同时读取这两个文件。' },
  { type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: 'a.ts' } },
  { type: 'tool_use', id: 'toolu_002', name: 'Read', input: { file_path: 'b.ts' } },
]
```

### 4.2 执行模式

**流式执行（`StreamingToolExecutor`）**：

- `isConcurrencySafe` 工具可并行（Read、Grep、Glob 等）
- 非并发安全工具独占执行（写入类工具）
- Bash 错误可通过 `siblingAbortController` 中止同级工具

**批量执行（`partitionToolCalls`）**：

- 连续的只读/并发安全工具 → 一个批次，并行执行
- 写入类工具 → 独立批次，串行执行

### 4.3 多个 tool_result 的组织

每个工具执行生成独立的 `UserMessage`（各含一个 `tool_result`）：

```typescript
// 内部状态：多个独立的 UserMessage
[
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_001', content: '...' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_002', content: '...' }] } },
]
```

### 4.4 `normalizeMessagesForAPI` 的合并

连续的 `user` 消息被合并为单条 `user` 消息：

```typescript
// src/utils/messages.ts ~2187-2198
const lastMessage = last(result)
if (lastMessage?.type === 'user') {
  result[result.length - 1] = mergeUserMessages(lastMessage, normalizedMessage)
  return
}
```

合并后 `hoistToolResults` 确保所有 `tool_result` blocks 排在最前面：

```typescript
// src/utils/messages.ts ~2466-2482
function hoistToolResults(content: ContentBlockParam[]): ContentBlockParam[] {
  const toolResults: ContentBlockParam[] = []
  const otherBlocks: ContentBlockParam[] = []
  for (const block of content) {
    if (block.type === 'tool_result') {
      toolResults.push(block)
    } else {
      otherBlocks.push(block)
    }
  }
  return [...toolResults, ...otherBlocks]
}
```

**最终发给 API 的合并用户消息**：

```typescript
{
  role: 'user',
  content: [
    // tool_result blocks 在前
    { type: 'tool_result', tool_use_id: 'toolu_001', content: '文件a的内容...' },
    { type: 'tool_result', tool_use_id: 'toolu_002', content: '文件b的内容...' },
    // 非 tool_result blocks 在后（如用户反馈、图片等）
    // { type: 'text', text: '...' },
  ]
}
```

---

## 5. 消息标准化的完整处理

### 5.1 `normalizeMessagesForAPI` 处理的消息类型

| 消息类型 | 处理方式 |
|---------|---------|
| `user` | 保留，连续的合并，tool_result 提升到前面 |
| `assistant` | 保留，相同 `message.id` 的合并（流式重组） |
| `progress` | **丢弃**（不发送给 API） |
| `system`（`local_command`） | 转换为 user content 合并到相邻 user 消息 |
| `attachment` | 通过 `normalizeAttachmentForAPI` 转为 user 消息 |
| 其他 system | **丢弃** |

### 5.2 assistant 消息中 `tool_use` 的标准化

```typescript
// src/utils/messages.ts ~2201-2240
case 'tool_use': {
  const tool = tools.find(t => toolMatchesName(t, block.name))
  const normalizedInput = tool
    ? normalizeToolInputForAPI(tool, block.input)  // 清理多余字段
    : block.input
  const canonicalName = tool?.name ?? block.name    // 规范工具名
  
  if (toolSearchEnabled) {
    // 保留所有字段（包括 caller 等 tool search 扩展字段）
    return { ...block, name: canonicalName, input: normalizedInput }
  }
  
  // 非 Tool Search 模式：只保留标准 API 字段
  return {
    type: 'tool_use',
    id: block.id,
    name: canonicalName,
    input: normalizedInput,
  }
}
```

### 5.3 `normalizeToolInputForAPI` — 输入字段清理

```typescript
// src/utils/api.ts ~683-717
export function normalizeToolInputForAPI(tool, input) {
  switch (tool.name) {
    case EXIT_PLAN_MODE_V2_TOOL_NAME:
      // 剥离注入的 plan / planFilePath 字段
      const { plan, planFilePath, ...rest } = input
      return rest
    case FileEditTool.name:
      // 剥离旧版的 old_string / new_string / replace_all 字段
      if ('edits' in input) {
        const { old_string, new_string, replace_all, ...rest } = input
        return rest
      }
      return input
    default:
      return input  // 大多数工具直接透传
  }
}
```

### 5.4 `ensureToolResultPairing` — 配对修复

**缺失 tool_result 的处理**（assistant 有 tool_use 但下一条 user 没有对应 tool_result）：

```typescript
// src/utils/messages.ts ~5320-5326
const syntheticBlocks = missingIds.map(id => ({
  type: 'tool_result',
  tool_use_id: id,
  content: '[Tool result missing due to internal error]',
  is_error: true,
}))
// 插入到下一条 user 消息的 content 最前面
```

**孤立 tool_result 的处理**（user 有 tool_result 但前面的 assistant 没有对应 tool_use）：

```typescript
// 直接从 content 数组中过滤掉
content = content.filter(block => {
  if (block.type === 'tool_result') {
    if (orphanedSet.has(block.tool_use_id)) return false  // 孤立的删除
    if (seenTrIds.has(block.tool_use_id)) return false    // 重复的删除
    seenTrIds.add(block.tool_use_id)
  }
  return true
})
```

**不完整的 server_tool_use 处理**：

```typescript
// server_tool_use / mcp_tool_use 没有对应的 *_tool_result → 删除
if ((block.type === 'server_tool_use' || block.type === 'mcp_tool_use')
    && !serverResultIds.has(block.id)) {
  return false  // 从 assistant content 中过滤掉
}
```

---

## 6. 消息转换为 API 参数

### 6.1 `userMessageToMessageParam`

```typescript
// src/services/api/claude.ts ~588-631
function userMessageToMessageParam(message, addCache, enablePromptCaching, querySource) {
  if (addCache) {
    // 字符串内容 → 单 text block + cache_control
    if (typeof message.message.content === 'string') {
      return {
        role: 'user',
        content: [{
          type: 'text',
          text: message.message.content,
          ...(enablePromptCaching && { cache_control: getCacheControl({querySource}) }),
        }],
      }
    }
    // 数组内容 → 最后一个 block 加 cache_control
    return {
      role: 'user',
      content: message.message.content.map((block, i) => ({
        ...block,
        ...(i === message.message.content.length - 1
          ? enablePromptCaching
            ? { cache_control: getCacheControl({querySource}) }
            : {}
          : {}),
      })),
    }
  }
  // 不缓存时：克隆数组防止原地修改
  return {
    role: 'user',
    content: Array.isArray(message.message.content)
      ? [...message.message.content]
      : message.message.content,
  }
}
```

### 6.2 `assistantMessageToMessageParam`

```typescript
// src/services/api/claude.ts ~633-674
// 与 user 类似，但跳过 thinking / redacted_thinking / connector_text 类型的 block
// 这些类型不适合作为缓存断点
```

### 6.3 `addCacheBreakpoints`

只对**一条消息**（通常是最后一条或倒数第二条）应用 `addCache=true`：

```typescript
// src/services/api/claude.ts ~3089-3106
const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
const result = messages.map((msg, index) => {
  const addCache = index === markerIndex
  if (msg.type === 'user') {
    return userMessageToMessageParam(msg, addCache, enablePromptCaching, querySource)
  }
  return assistantMessageToMessageParam(msg, addCache, enablePromptCaching, querySource)
})
```

---

## 7. 并行工具的预算控制（`enforceToolResultBudget`）

### 7.1 分组策略

预算按 **API 级用户消息** 分组（不是按内部 `UserMessage` 分组），因为 `normalizeMessagesForAPI` 会合并连续 user 消息。assistant 消息是唯一的分组边界。

```typescript
// src/utils/toolResultStorage.ts ~600-638
function collectCandidatesByMessage(messages) {
  const groups = []
  let current = []
  const seenAsstIds = new Set()
  
  for (const message of messages) {
    if (message.type === 'user') {
      current.push(...collectCandidatesFromMessage(message))
    } else if (message.type === 'assistant') {
      if (!seenAsstIds.has(message.message.id)) {
        flush()  // assistant 消息创建新组
        seenAsstIds.add(message.message.id)
      }
    }
    // progress / attachment 不创建边界
  }
  flush()
  return groups
}
```

### 7.2 三分区决策

```typescript
// src/utils/toolResultStorage.ts ~649-667
function partitionByPriorDecision(candidates, state) {
  // mustReapply — 之前已替换过 → 重新应用缓存的替换内容（零 I/O，字节相同）
  // frozen — 之前已见过但未替换 → 不可替换（会破坏 prompt cache）
  // fresh — 首次出现 → 可以做新的替换决策
}
```

### 7.3 替换选择策略

```typescript
// src/utils/toolResultStorage.ts ~675-692
function selectFreshToReplace(fresh, frozenSize, limit) {
  // 按大小降序排列
  const sorted = [...fresh].sort((a, b) => b.size - a.size)
  // 从最大的开始替换，直到总量在预算内
  let remaining = frozenSize + fresh.reduce((sum, c) => sum + c.size, 0)
  for (const c of sorted) {
    if (remaining <= limit) break  // 200,000 字符限制
    selected.push(c)
    remaining -= c.size
  }
  return selected
}
```

---

## 8. 完整示例：一次 Read 工具调用的数据流

以 LLM 调用 `Read` 读取 `foo.ts` 为例：

**Stage 1 — LLM 返回的 assistant 内容（流式接收后）**：

```typescript
// 内部存储
{
  type: 'assistant',
  message: {
    id: 'msg_01abc',
    content: [
      { type: 'tool_use', id: 'toolu_01xyz', name: 'Read', input: { file_path: '/project/foo.ts' } }
    ],
    stop_reason: 'tool_use',
  }
}
```

**Stage 2 — `tool.call()` 返回值**：

```typescript
{
  type: 'text',
  file: {
    content: 'import express from "express"\nconst app = express()\n...',
    startLine: 1,
    totalLines: 50,
    filename: 'foo.ts',
    filePath: '/project/foo.ts',
  }
}
```

**Stage 3 — `mapToolResultToToolResultBlockParam()` 输出**：

```typescript
{
  type: 'tool_result',
  tool_use_id: 'toolu_01xyz',
  content: '     1|import express from "express"\n     2|const app = express()\n     3|...'
}
```

**Stage 4 — `processPreMappedToolResultBlock()` 输出**：

- 若内容 ≤ 50,000 字符 → 原样返回
- 若内容 > 50,000 字符 → 持久化到磁盘，返回：
  ```
  <persisted-output>
  Output too large (87.5 KB). Full output saved to: /project/.claude/.../tool-results/toolu_01xyz.txt
  
  Preview (first 2.0 KB):
       1|import express from "express"
       2|const app = express()
  ...
  </persisted-output>
  ```

**Stage 5 — 内部 UserMessage**：

```typescript
{
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01xyz', content: '     1|import ...' }
    ],
  },
  sourceToolAssistantUUID: 'uuid-of-assistant',
}
```

**Stage 6 — `normalizeMessagesForAPI` 后**（与相邻 user 消息合并）：

```typescript
// 如果是并行工具调用，多个 user 消息合并为一个
{
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_01xyz', content: '...' },  // tool_result 在前
      // 其他 tool_result / text / image blocks...
    ],
  },
}
```

**Stage 7 — `addCacheBreakpoints` → 最终 API MessageParam**：

```typescript
{
  role: 'user',
  content: [
    { type: 'tool_result', tool_use_id: 'toolu_01xyz', content: '     1|import ...' },
    // 如果这是最后一条消息，最后一个 block 加上：
    // cache_control: { type: 'ephemeral', ttl: '1h', scope: 'org' }
  ]
}
```

---

## 9. 历史中的工具结果如何被逐步清理

随着对话进行，旧的工具结果会被多层机制逐步清理：

```
新鲜结果                  ┐
  │                       │ 正常大小 → 原样保留
  │ 超过50k字符 → 持久化  │
  ▼                       ┘
一轮对话后
  │ 并行结果总量>200k → 最大的持久化
  ▼
多轮对话后
  │ Microcompact → 内容替换为 "[Old tool result content cleared]"
  │ 或 Cached MC → cache_edits 在 API 端删除
  ▼
上下文接近限制
  │ Context Collapse → 整段折叠为摘要
  ▼
上下文接近满载
  │ Autocompact → 让模型生成完整对话摘要
  │ 所有历史消息被替换
  ▼
上下文完全溢出
  │ Session Memory Compact → 保留尾部10k-40k token
  │ 或 PTL Retry → 逐步丢弃最老的轮次组
  ▼
```

**关键设计原则**：
- 每一层的决策一旦做出，在后续轮次中保持不变（`ContentReplacementState` 冻结、`seenIds` 锁定）
- 这保证了 prompt cache 的前缀稳定性——API 看到的前缀内容在多轮之间不变
- Microcompact 通过 `tool_use_id` 操作（不检查内容），所以与持久化替换正交、可组合

---

## 关键文件索引

| 关注点 | 文件路径 | 核心符号 |
|--------|---------|---------|
| 流式接收 + 解析 | `src/services/api/claude.ts` | 流式处理循环、`normalizeContentFromAPI` |
| 内容标准化 | `src/utils/messages.ts` | `normalizeContentFromAPI`、`normalizeMessagesForAPI` |
| 工具执行 | `src/services/tools/toolExecution.ts` | `runToolUse`、`checkPermissionsAndCallTool`、`addToolResult` |
| 流式并发执行 | `src/services/tools/StreamingToolExecutor.ts` | `StreamingToolExecutor` |
| 批量编排 | `src/services/tools/toolOrchestration.ts` | `runTools`、`partitionToolCalls` |
| 结果映射（Read） | `src/tools/FileReadTool/FileReadTool.ts` | `mapToolResultToToolResultBlockParam` |
| 结果映射（Bash） | `src/tools/BashTool/BashTool.tsx` | `mapToolResultToToolResultBlockParam` |
| 结果映射（Grep） | `src/tools/GrepTool/GrepTool.ts` | `mapToolResultToToolResultBlockParam` |
| 持久化/预算 | `src/utils/toolResultStorage.ts` | `maybePersistLargeToolResult`、`enforceToolResultBudget`、`ContentReplacementState` |
| 大小限制 | `src/constants/toolLimits.ts` | `DEFAULT_MAX_RESULT_SIZE_CHARS`、`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS` |
| 配对修复 | `src/utils/messages.ts` | `ensureToolResultPairing` |
| 输入字段清理 | `src/utils/api.ts` | `normalizeToolInputForAPI` |
| 消息→API参数 | `src/services/api/claude.ts` | `userMessageToMessageParam`、`assistantMessageToMessageParam`、`addCacheBreakpoints` |
| MCP 输出截断 | `src/utils/mcpValidation.ts` | `truncateMcpContent` |
