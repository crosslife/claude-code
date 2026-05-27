# Prompt Cache 架构分析

本文档详细分析 Claude Code 项目如何编排系统提示词、工具定义、用户消息等内容，以最大化 Anthropic Prompt Cache 的命中率。

## 1. 核心原理

Anthropic Prompt Cache 基于**前缀匹配**机制：请求中从头开始连续匹配的 token 可以复用已缓存的 KV Cache。因此项目的全局策略是：

> **不变/低频变化的内容置于前方，高频变化的内容置于后方**，最大化每次请求的可复用前缀长度。

## 2. API 请求的整体编排结构

服务端处理的实际 token 顺序为 **Tools → System → Messages**。项目在每个层级分别做了缓存优化：

```
┌─────────────────────────────────────────────────────────────┐
│  位置1: Tools (工具定义)                    ← 最稳定，~11K tokens │
│    - 内置工具 (按name字母序排序)                                 │
│    - MCP工具 (按name字母序排序，拼接在内置工具之后)                  │
│    - Advisor等扩展工具 (追加在最末尾)                             │
├─────────────────────────────────────────────────────────────┤
│  位置2: System Prompt (系统提示词)               ← 分块+分级缓存  │
│    - Attribution Header (cacheScope=null, 不缓存)              │
│    - CLI Prefix (cacheScope=null 或 'org')                    │
│    - 静态内容 (cacheScope='global', 跨组织共享)                  │
│    - 动态内容 (cacheScope=null 或 'org')                       │
├─────────────────────────────────────────────────────────────┤
│  位置3: Messages (对话消息)                      ← 仅一个断点    │
│    - userContext 元消息 (<system-reminder>)                    │
│    - 历史消息...                                              │
│    - 最后一条消息 ← 唯一的 cache_control 标记                    │
└─────────────────────────────────────────────────────────────┘
```

## 3. Tools 层：稳定排序 + 会话级 Schema 锁定

### 3.1 排序策略：内置前缀 + MCP 后缀

**文件**: `src/tools.ts` — `assembleToolPool()`

项目将内置工具和 MCP 工具**分别按 name 字母序排列**，然后以"内置在前、MCP 在后"的方式拼接：

```typescript
const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
return uniqBy(
  [...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)),
  'name',
)
```

**为什么不做全局统一排序？** 服务端的 `claude_code_system_cache_policy` 在最后一个前缀匹配的内置工具之后放置全局缓存断点。如果 MCP 工具插入到内置工具之间，会导致该断点后的所有缓存键失效。

### 3.2 Schema 会话级锁定

**文件**: `src/utils/toolSchemaCache.ts`

工具 schema 在服务端占据"位置 2"（在 system prompt 之前），约 11K tokens。任何字节级变化都会导致该工具块及所有下游内容的缓存全部失效。

项目用一个 `Map<string, CachedSchema>` 在首次渲染后锁定每个工具的序列化结果，会话中 GrowthBook 配置变化、MCP 重连、`tool.prompt()` 内容漂移等都不会改变已锁定的字节：

```typescript
const TOOL_SCHEMA_CACHE = new Map<string, CachedSchema>()
```

**文件**: `src/utils/api.ts` — `toolToAPISchema()`

该函数的 session-stable base（name, description, input_schema, strict, eager_input_streaming）从缓存中取，只有 `defer_loading` 等 per-request 属性在每次请求时叠加。

### 3.3 Advisor 工具追加在末尾

**文件**: `src/services/api/claude.ts` ~1385-1396

Advisor 等服务端工具在 `toolSchemas` 之后追加，确保开关 advisor 只影响尾部小段，不影响前面的缓存前缀：

```typescript
const allTools = [...toolSchemas, ...extraToolSchemas]
```

### 3.4 Deferred Tools

当启用 Tool Search 时，部分工具标记为 `defer_loading: true`，不在初始请求中发送完整 schema，从而减少工具块体积、降低缓存失效的影响面。

## 4. System Prompt 层：静态/动态边界分割

### 4.1 边界标记（Boundary Marker）

**文件**: `src/constants/prompts.ts`

定义了一个关键的边界常量 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`，用于在 system prompt 数组中分隔静态内容和动态内容：

```typescript
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

### 4.2 System Prompt 数组编排

**文件**: `src/constants/prompts.ts` — `getSystemPrompt()`

返回的数组严格遵循"先静态后动态"的顺序：

```
静态区域 (boundary 之前):
  ├── IntroSection          — 模型身份介绍
  ├── SystemSection         — 系统环境信息
  ├── DoingTasksSection     — 编码任务指南
  ├── ActionsSection        — 可执行操作说明
  ├── UsingYourToolsSection — 工具使用说明
  ├── ToneAndStyleSection   — 语调和风格指南
  └── OutputEfficiency      — 输出效率指南

=== BOUNDARY MARKER ===

动态区域 (boundary 之后):
  └── resolvedDynamicSections — 注册表管理的动态段
```

### 4.3 API 时附加内容

**文件**: `src/services/api/claude.ts` — `queryModel()` 中的 systemPrompt 组装

在实际发送 API 请求前，system prompt 数组会被进一步扩展：

```
[Attribution Header]     ← 计费标识指纹
[CLI Sysprompt Prefix]   ← CLI 模式前缀
[...systemPrompt]        ← 来自 getSystemPrompt 的主体
[ADVISOR_INSTRUCTIONS]   ← 可选：advisor 工具说明
[CHROME_INSTRUCTIONS]    ← 可选：浏览器工具说明
```

### 4.4 三种分块策略 (splitSysPromptPrefix)

**文件**: `src/utils/api.ts` — `splitSysPromptPrefix()`

根据场景走三条不同路径，为每个块指定不同的 `cacheScope`：

#### 模式 1: 有 MCP 工具（skipGlobalCacheForSystemPrompt=true）

MCP 工具是用户级（per-user）动态内容，无法使用全局缓存：

| 块 | cacheScope |
|---|---|
| Attribution Header | `null` |
| CLI Prefix | `'org'` |
| 所有其他内容合并 | `'org'` |

#### 模式 2: 全局缓存模式（1P，有 boundary marker）

最优模式，静态内容跨组织共享：

| 块 | cacheScope |
|---|---|
| Attribution Header | `null` |
| CLI Prefix | `null` |
| 边界前的静态内容 | `'global'` |
| 边界后的动态内容 | `null` |

#### 模式 3: 默认模式（3P 或无 boundary）

| 块 | cacheScope |
|---|---|
| Attribution Header | `null` |
| CLI Prefix | `'org'` |
| 所有其他内容合并 | `'org'` |

### 4.5 块 → cache_control 转换

**文件**: `src/services/api/claude.ts` — `buildSystemPromptBlocks()`

每个 `cacheScope !== null` 的块会附加 `cache_control`：

```typescript
return splitSysPromptPrefix(systemPrompt, { ... }).map(block => ({
  type: 'text',
  text: block.text,
  ...(enablePromptCaching && block.cacheScope !== null && {
    cache_control: getCacheControl({
      scope: block.cacheScope,
      querySource: options?.querySource,
    }),
  }),
}))
```

## 5. Messages 层：精确的单断点策略

### 5.1 userContext 前置

**文件**: `src/utils/api.ts` — `prependUserContext()`

在消息数组最前面插入一条 `<system-reminder>` 元消息，包含 `claudeMd`、日期等上下文信息。该消息标记为 `isMeta: true`，在多轮对话中保持稳定。

### 5.2 消息规范化

**文件**: `src/utils/messages.ts` — `normalizeMessagesForAPI()`

发送前的消息经过多道处理：
- 重排附件、移除虚拟/进度/系统消息
- 合并连续 user 消息（Bedrock 兼容）
- 规范化 tool_use 输入
- 过滤尾部 thinking、空白 assistant 消息
- 清理错误 tool_result 内容
- 图片验证

### 5.3 单一 cache_control 断点

**文件**: `src/services/api/claude.ts` — `addCacheBreakpoints()`

整个消息链上只放**恰好一个** `cache_control` 标记，位于**最后一条消息**的最后一个 content block 上：

```typescript
const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
```

**为什么只放一个？** Mycro（服务端 KV Cache 管理器）的 turn-to-turn 淘汰机制：
- 放两个标记时，倒数第二个位置受保护，其 local-attention KV pages 会多存活一轮（即使不会被复用）
- 只放一个标记，无用的 KV pages 立即释放

### 5.4 Fork 场景的 skipCacheWrite

当 `skipCacheWrite=true`（如临时 fork/subagent）时，标记移到**倒数第二条消息**：
- 倒数第二条是共享前缀的最后一个点，写入是 no-op merge
- fork 不会把自己的尾部留在 KVCC 中

## 6. cache_control 的三级 TTL 体系

**文件**: `src/services/api/claude.ts` — `getCacheControl()`

```typescript
return {
  type: 'ephemeral',                                    // 默认 5 分钟
  ...(should1hCacheTTL(querySource) && { ttl: '1h' }),  // 合格用户 1 小时
  ...(scope === 'global' && { scope }),                  // 跨组织共享
}
```

| 层级 | TTL | 适用范围 |
|---|---|---|
| `ephemeral` (默认) | 5 分钟 | 所有用户 |
| `ttl: '1h'` | 1 小时 | Anthropic 员工或未超额的订阅用户 |
| `scope: 'global'` | — | 1P 静态系统提示词，跨组织共享 |

### 1h TTL 资格判定

**文件**: `src/services/api/claude.ts` — `should1hCacheTTL()`

资格判定结果**锁存**到 bootstrap state，防止中途限额变化改变 TTL（每次变化约导致 ~20K tokens 缓存失效）：

1. Bedrock 用户：通过 `ENABLE_PROMPT_CACHING_1H_BEDROCK` 环境变量开启
2. 其他用户：`ant` 用户类型 或 (订阅用户 且 未使用超额)
3. 查询源必须在 GrowthBook 允许列表中（allowlist 也锁存到 state）

## 7. 会话稳定性保障机制

项目通过多种锁存（latch）机制防止缓存意外失效：

| 机制 | 文件 | 作用 |
|---|---|---|
| Tool Schema 会话锁定 | `src/utils/toolSchemaCache.ts` | GrowthBook 配置变化不影响工具序列化字节 |
| 1h TTL 资格锁存 | `src/services/api/claude.ts` | 防止中途限额变化改变 cache_control TTL |
| Allowlist 锁存 | `src/services/api/claude.ts` | 防止 GrowthBook 磁盘缓存更新导致 TTL 混用 |
| Beta Header 粘滞 | `src/services/api/claude.ts` | fast mode / AFK / cache editing 等 toggle 不改变缓存键 |
| 消息克隆后再变更 | `src/query.ts` | 确保下一轮 API 请求的消息字节与发送时一致 |

## 8. Prompt Cache Break Detection

**文件**: `src/services/api/promptCacheBreakDetection.ts`

项目具备缓存失效诊断能力。当 `PROMPT_CACHE_BREAK_DETECTION` 开启时，会记录每次请求的哈希状态（system, tools, betas, model, effort 等），`defer_loading` 工具从哈希中排除（因为 API 会剥离它们）。当哈希变化时可以定位是哪个部分导致了缓存失效。

## 9. Cached MicroCompact (cache_edits / cache_reference)

当启用 cached microcompact 时，`addCacheBreakpoints` 会：
1. 插入 `cache_edits` 块（描述上下文压缩的编辑操作）
2. 在 cache 标记之前的 `tool_result` 块上添加 `cache_reference`

这使得上下文压缩（compaction）操作能利用缓存中已有的内容，避免重新传输完整的压缩后上下文。

## 10. 设计哲学总结

```
稳定度高 ──────────────────────────────────────────→ 稳定度低

[Tools]          → [System静态] → [System动态] → [消息历史] → [最后一条]
  ↑                    ↑              ↑              ↑            ↑
会话级锁定         global共享      org级缓存    前缀匹配复用   单一cache断点
~11K tokens      跨组织不变       组织内稳定    逐轮递增      每轮仅此处变化
```

核心策略四字诀：

1. **前缀稳定**：不变内容（工具定义、静态提示词）排最前，每次请求都命中缓存
2. **分层缓存**：global → org → ephemeral，按共享范围递减分配缓存粒度
3. **最小断点**：整个消息链只打一个 `cache_control`，避免 KV page 泄漏
4. **会话锁存**：所有可能中途变化的配置在首次确定后锁定，防止字节抖动导致缓存失效

## 关键文件索引

| 关注点 | 文件路径 |
|---|---|
| 系统提示词构建 | `src/constants/prompts.ts` |
| 有效提示词组装 | `src/utils/systemPrompt.ts` |
| 查询上下文（缓存键前缀） | `src/utils/queryContext.ts` |
| System Prompt 分块 | `src/utils/api.ts` — `splitSysPromptPrefix()` |
| 工具 Schema 会话缓存 | `src/utils/toolSchemaCache.ts` |
| 工具排序组装 | `src/tools.ts` — `assembleToolPool()` |
| API 请求组装与缓存标记 | `src/services/api/claude.ts` |
| 消息规范化 | `src/utils/messages.ts` |
| 缓存失效诊断 | `src/services/api/promptCacheBreakDetection.ts` |
| Fork 缓存语义 | `src/utils/forkedAgent.ts` |
| 主查询循环 | `src/query.ts` |
