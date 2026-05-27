# Claude Code 消息存储架构分析

## 概述

Claude Code 采用 **基于文件的 JSONL（JSON Lines）追加式存储** 作为对话消息的持久化方案。每个会话（session）对应一个 `.jsonl` 文件，文件名为会话的 UUID。所有文件组织在 `~/.claude/projects/` 目录下，按项目路径分文件夹存放。大型工具输出通过独立的文件系统目录进行溢出存储，JSONL 中仅保留预览引用。

**不使用数据库** —— 没有 SQLite 或其他关系型存储，完全依赖文件系统。

---

## 一、目录结构总览

### 1.1 根路径

```
~/.claude/                          # CLAUDE_CONFIG_DIR 或默认 ~/.claude
├── projects/                       # 所有项目的消息存储根目录
│   └── {sanitized-project-path}/   # 每个项目一个文件夹（路径经过清洗）
│       ├── {sessionId}.jsonl       # 主会话记录文件（文件名=会话UUID）
│       └── {sessionId}/            # 会话关联的附属目录
│           ├── subagents/          # 子代理记录
│           │   ├── agent-{agentId}.jsonl      # 子代理对话记录
│           │   ├── agent-{agentId}.meta.json  # 子代理元数据
│           │   └── workflows/{runId}/         # 工作流分组子目录
│           │       └── agent-{agentId}.jsonl
│           ├── remote-agents/
│           │   └── remote-agent-{taskId}.meta.json
│           └── tool-results/       # 工具大输出溢出存储
│               ├── {toolUseId}.txt
│               └── {toolUseId}.json
├── history.jsonl                   # 命令行输入历史（用于 ↑/Ctrl+R）
├── paste-cache/                    # 大文本粘贴缓存
│   └── {sha256-16}.txt             # 内容寻址
├── image-cache/                    # 粘贴图片缓存
│   └── {sessionId}/
│       └── {id}.{ext}
└── scratchpad/                     # 会话便笺
```

临时目录（大型后台任务输出）：
```
/tmp/claude-{uid}/{sanitized-cwd}/{sessionId}/
└── tasks/
    └── {taskId}.output             # 最大 5GB，后台 Bash 任务输出
```

### 1.2 路径生成逻辑

项目路径的清洗规则定义在 `src/utils/path.ts` 的 `sanitizePath` 函数中：
- 非字母数字字符替换为 `-`
- 过长路径进行哈希处理
- 例如 `/home/user/my-project` → `home-user-my-project`

核心路径函数（`src/utils/sessionStorage.ts`）：

```typescript
// 项目总目录
function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

// 当前会话的记录文件路径
function getTranscriptPath(): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  return join(projectDir, `${getSessionId()}.jsonl`)
}

// 子代理记录路径
function getAgentTranscriptPath(agentId: AgentId): string {
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const sessionId = getSessionId()
  const subdir = agentTranscriptSubdirs.get(agentId)
  const base = subdir
    ? join(projectDir, sessionId, 'subagents', subdir)
    : join(projectDir, sessionId, 'subagents')
  return join(base, `agent-${agentId}.jsonl`)
}
```

### 1.3 不同消息如何分文件夹

| 消息类型 | 存储位置 | 说明 |
|---------|----------|------|
| 主对话消息 | `{projectDir}/{sessionId}.jsonl` | 用户/助手/附件/系统消息 |
| 子代理对话 | `{projectDir}/{sessionId}/subagents/agent-{id}.jsonl` | 通过 `isSidechain=true` 标记 |
| 子代理元数据 | `{projectDir}/{sessionId}/subagents/agent-{id}.meta.json` | 代理类型、worktree 路径等 |
| 工具大输出 | `{projectDir}/{sessionId}/tool-results/{toolUseId}.txt/json` | 超出阈值的工具结果 |
| 后台任务输出 | `/tmp/claude-{uid}/.../tasks/{taskId}.output` | Bash 后台任务 |
| 粘贴文本 | `~/.claude/paste-cache/{hash}.txt` | 内容寻址存储 |
| 图片缓存 | `~/.claude/image-cache/{sessionId}/{id}.{ext}` | 按会话隔离 |
| 命令历史 | `~/.claude/history.jsonl` | 独立于对话记录 |

---

## 二、JSONL 文件的数据结构

### 2.1 文件格式

每个 `.jsonl` 文件由一行一个 JSON 对象组成，追加写入（append-only）：

```
{"type":"user","uuid":"abc-123","parentUuid":null,"content":...,"sessionId":"xxx",...}\n
{"type":"assistant","uuid":"def-456","parentUuid":"abc-123","content":...,...}\n
{"type":"custom-title","sessionId":"xxx","customTitle":"我的对话"}\n
...
```

写入通过 `appendFileSync` 或异步 `appendFile` 完成，文件权限 `0o600`（仅所有者可读写）。

### 2.2 Entry 联合类型

每一行对应 `Entry` 联合类型，定义在 `src/types/logs.ts`：

```typescript
type Entry =
  | TranscriptMessage          // 对话消息（user/assistant/attachment/system）
  | SummaryMessage             // 对话摘要
  | CustomTitleMessage         // 用户设置的标题
  | AiTitleMessage             // AI 生成的标题
  | LastPromptMessage          // 最近一次用户提示
  | TaskSummaryMessage         // 任务摘要（定时 fork 生成）
  | TagMessage                 // 会话标签
  | AgentNameMessage           // 代理名称
  | AgentColorMessage          // 代理颜色
  | AgentSettingMessage        // 代理配置
  | PRLinkMessage              // 关联的 GitHub PR
  | FileHistorySnapshotMessage // 文件历史快照
  | AttributionSnapshotMessage // 归因快照
  | QueueOperationMessage      // 命令队列操作日志
  | SpeculationAcceptMessage   // 推测接受时间
  | ModeEntry                  // 会话模式（coordinator/normal）
  | WorktreeStateEntry         // Worktree 状态
  | ContentReplacementEntry    // 工具结果替换记录
  | ContextCollapseCommitEntry // 上下文折叠提交
  | ContextCollapseSnapshotEntry // 上下文折叠快照
```

### 2.3 对话消息的数据结构（TranscriptMessage）

这是最核心的数据结构，由三层组合构成：

```
Message（运行时内存类型）
  └── SerializedMessage = Message + 会话元数据
       └── TranscriptMessage = SerializedMessage + 链式关系 + 侧链标记
```

#### 层级 1：Message（运行时类型，定义在 `src/types/message.js`）

```typescript
// 用户消息
type UserMessage = {
  type: 'user'
  uuid: UUID
  timestamp: string                    // ISO 8601
  message: {
    role: 'user'
    content: string | ContentBlockParam[]  // 文本或结构化内容块
  }
  isMeta?: true                        // 元信息消息（非用户直接输入）
  isVisibleInTranscriptOnly?: true     // 仅在记录中可见
  isVirtual?: true                     // 虚拟消息（不发送到 API）
  isCompactSummary?: true              // 压缩摘要
  toolUseResult?: unknown              // 工具调用结果
  imagePasteIds?: number[]             // 粘贴图片 ID
  sourceToolAssistantUUID?: UUID       // 关联的助手 tool_use 消息 UUID
  permissionMode?: PermissionMode      // 权限模式
  origin?: MessageOrigin               // 消息来源
}

// 助手消息
type AssistantMessage = {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  message: {
    id: string                         // API 消息 ID
    model: string
    role: 'assistant'
    content: BetaContentBlock[]        // text/thinking/tool_use 等
    usage: Usage                       // token 使用量
    stop_reason: string | null
    context_management: object | null
  }
  requestId?: string                   // API 请求 ID
  isApiErrorMessage?: boolean          // 是否为 API 错误
  isVirtual?: true
}

// 附件消息
type AttachmentMessage = {
  type: 'attachment'
  uuid: UUID
  timestamp: string
  attachment: Attachment               // 100+ 种附件子类型
}

// 系统消息
type SystemMessage = {
  type: 'system'
  subtype: string                      // informational/compact_boundary/...
  uuid: UUID
  timestamp: string
  content?: string
  // ... 各 subtype 特有字段
}
```

#### 层级 2：SerializedMessage（持久化层加盖的元数据）

```typescript
type SerializedMessage = Message & {
  cwd: string           // 消息产生时的工作目录
  userType: string      // 用户类型（ant/external）
  entrypoint?: string   // 入口点（cli/sdk-ts/sdk-py 等）
  sessionId: string     // 会话 ID
  timestamp: string     // ISO 时间戳
  version: string       // Claude Code 版本
  gitBranch?: string    // Git 分支
  slug?: string         // 会话 slug（用于计划文件等）
}
```

#### 层级 3：TranscriptMessage（写入 JSONL 的最终形态）

```typescript
type TranscriptMessage = SerializedMessage & {
  parentUuid: UUID | null           // 父消息 UUID（链式结构的核心）
  logicalParentUuid?: UUID | null   // 逻辑父 UUID（compact 断开后保留原始关系）
  isSidechain: boolean              // 是否为子代理侧链
  gitBranch?: string                // Git 分支
  agentId?: string                  // 子代理 ID
  teamName?: string                 // 团队名称
  agentName?: string                // 代理自定义名称
  agentColor?: string               // 代理颜色
  promptId?: string                 // OTel 关联 ID（仅用户消息）
}
```

### 2.4 parentUuid 链式结构

消息之间通过 `parentUuid` 形成一个**单向链表**（实际上是 DAG），这是对话历史重建的核心：

```
msg1(parentUuid=null) → msg2(parentUuid=msg1.uuid) → msg3(parentUuid=msg2.uuid) → ...
```

特殊情况：
- **compact 边界**：`parentUuid=null`，`logicalParentUuid` 保留逻辑关系
- **tool_result 消息**：`parentUuid` 指向发起 tool_use 的 assistant 消息（而非顺序前驱），通过 `sourceToolAssistantUUID` 实现
- **并行工具调用**：产生 DAG 结构，多个 assistant 消息共享同一个 `message.id`

### 2.5 元数据行示例

除了对话消息，JSONL 中还混杂各种元数据行：

```json
{"type":"summary","leafUuid":"abc","summary":"讨论了项目架构..."}
{"type":"custom-title","sessionId":"xxx","customTitle":"架构讨论"}
{"type":"ai-title","sessionId":"xxx","aiTitle":"Claude Code 源码分析"}
{"type":"tag","sessionId":"xxx","tag":"architecture"}
{"type":"file-history-snapshot","messageId":"abc","snapshot":{...}}
{"type":"content-replacement","sessionId":"xxx","replacements":[...]}
{"type":"worktree-state","sessionId":"xxx","worktreeSession":{...}}
{"type":"marble-origami-commit","sessionId":"xxx","collapseId":"...","summary":"..."}
```

---

## 三、消息写入流程

### 3.1 写入管线总览

```
REPL 消息状态 (Message[])
  → useLogMessages()              // React Hook 触发持久化
  → recordTranscript()            // UUID 去重，清洗日志
  → Project.insertMessageChain()  // 加盖 sessionId/cwd/parentUuid 等戳
  → Project.appendEntry()         // 路由到主文件 or 子代理文件
  → enqueueWrite()                // 进入写入队列
  → drainWriteQueue()             // 100ms 批次刷新
  → appendToFile()                // 实际文件追加
```

### 3.2 消息去重

`recordTranscript` 维护一个已记录 UUID 的 Set，确保同一消息不被重复写入：

```typescript
async function recordTranscript(messages, teamInfo?, startingParentUuidHint?) {
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages)
  const messageSet = await getSessionMessages(sessionId)
  const newMessages = []
  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid)) {
      // 已记录的消息仅用于追踪 parentUuid 链
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid
      }
    } else {
      newMessages.push(m)
    }
  }
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(newMessages, false, undefined, startingParentUuid)
  }
}
```

### 3.3 消息清洗

写入前通过 `cleanMessagesForLogging` 过滤：

| 类型 | 处理方式 |
|------|---------|
| `progress` 消息 | **丢弃**（临时 UI 状态，不持久化） |
| 外部用户的 `attachment` | **大部分丢弃**（数据敏感性） |
| `isVirtual` 消息 | 提升为真实消息 |
| REPL `tool_use/tool_result` 对 | **对外部用户剥离** |

### 3.4 批次写入机制

Project 类内部使用写入队列，100ms 批次刷新：

```typescript
class Project {
  private FLUSH_INTERVAL_MS = 100  // 普通模式
  // CCR/远程模式为 10ms
  private MAX_CHUNK_BYTES = 10 * 1024 * 1024  // 10MB 单次写入上限

  private enqueueWrite(filePath, entry) {
    queue.push({ entry, resolve })
    scheduleDrain()
  }

  private async drainWriteQueue() {
    for (const [filePath, queue] of writeQueues) {
      let content = ''
      for (const { entry, resolve } of batch) {
        const line = jsonStringify(entry) + '\n'
        if (content.length + line.length >= MAX_CHUNK_BYTES) {
          await appendToFile(filePath, content)
          content = ''
        }
        content += line
      }
      if (content.length > 0) await appendToFile(filePath, content)
    }
  }
}
```

### 3.5 延迟文件创建

会话文件**不是在会话开始时创建**，而是在第一条 user/assistant 消息到达时才通过 `materializeSessionFile()` 创建。在此之前，元数据暂存在 `pendingEntries` 中。

---

## 四、工具大输出存储机制

### 4.1 两级预算机制

大输出管理分为两个层级：

| 层级 | 阈值 | 文件 |
|------|------|------|
| 单工具结果 | 50,000 字符（`DEFAULT_MAX_RESULT_SIZE_CHARS`） | `toolResultStorage.ts` |
| 单消息聚合 | 200,000 字符（`MAX_TOOL_RESULTS_PER_MESSAGE_CHARS`） | `toolResultStorage.ts` |

每个工具可通过 GrowthBook 远程配置 override 阈值。

### 4.2 溢出存储流程

当工具结果超过阈值时：

```
工具产生结果
  → processToolResultBlock()
  → maybePersistLargeToolResult()    // 检查大小
  → persistToolResult()              // 写入 tool-results/ 目录
  → buildLargeToolResultMessage()    // 生成预览+引用替换原始内容
```

溢出文件路径：
```
~/.claude/projects/{project}/{sessionId}/tool-results/{toolUseId}.txt  # 纯文本
~/.claude/projects/{project}/{sessionId}/tool-results/{toolUseId}.json # JSON 数组
```

写入使用 `flag: 'wx'` 确保幂等（文件已存在则跳过）。

### 4.3 消息内引用格式

原始的 `tool_result` 内容被替换为预览引用：

```xml
<persisted-output>
Output too large (125.3 KB). Full output saved to: /home/user/.claude/projects/.../tool-results/abc123.txt

Preview (first 2.0 KB):
[前 2000 字节的内容预览]
...
</persisted-output>
```

### 4.4 消息级聚合预算

即使单个工具结果未超过阈值，一条 API 用户消息中多个 `tool_result` 的总大小也有上限（200K 字符）。超出时，系统按从大到小的顺序替换最大的 fresh 结果。

关键数据结构 `ContentReplacementState`：

```typescript
type ContentReplacementState = {
  seenIds: Set<string>                    // 已见过的 toolUseId
  replacements: Map<string, string>       // toolUseId → 替换后的预览文本
}
```

替换决策具有**缓存语义稳定性**：
- **已替换的** (mustReapply)：每轮重新应用缓存的替换文本（零 I/O，字节相同）
- **已冻结的** (frozen)：上一轮看到但未替换的，永不再替换（保护 prompt cache）
- **新鲜的** (fresh)：本轮新出现的，可以决策是否替换

替换记录写入 JSONL 作为 `content-replacement` 条目，以支持 resume 时重建相同状态。

### 4.5 其他大输出存储

| 存储位置 | 用途 | 上限 |
|---------|------|------|
| `tool-results/{toolUseId}.txt/json` | 一般工具大输出 | - |
| `tool-results/{persistId}.{ext}` | MCP 二进制输出 | - |
| `/tmp/claude-{uid}/.../tasks/{taskId}.output` | 后台 Bash 任务输出 | 5 GB |
| `paste-cache/{hash}.txt` | 大文本粘贴 | - |
| `image-cache/{sessionId}/{id}.{ext}` | 粘贴图片 | - |

---

## 五、消息读取与对话恢复

### 5.1 恢复入口

`loadConversationForResume`（`src/utils/conversationRecovery.ts`）是核心入口，支持三种恢复来源：

| 来源 | 触发方式 |
|------|---------|
| `undefined` | `--continue` 恢复最近会话 |
| `string`（会话 ID） | `--resume <id>` 恢复指定会话 |
| `LogOption` 对象 | 交互式选择器已加载的会话 |
| `.jsonl` 文件路径 | `--resume <path>` 跨项目恢复 |

### 5.2 读取管线

```
.jsonl 文件
  → loadTranscriptFile()                    // 解析 JSONL，构建 UUID→消息 Map
  → 找到叶节点（最新的非侧链消息）
  → buildConversationChain()                // 从叶节点沿 parentUuid 回溯到根
  → recoverOrphanedParallelToolResults()    // 修复并行 tool_use 的 DAG 孤儿
  → removeExtraFields()                     // 剥离 parentUuid、isSidechain
  → deserializeMessagesWithInterruptDetection()
      • migrateLegacyAttachmentTypes()      // 迁移旧格式附件
      • filterUnresolvedToolUses()          // 过滤未完成的工具调用
      • filterOrphanedThinkingOnlyMessages() // 过滤孤立的 thinking 消息
      • filterWhitespaceOnlyAssistantMessages()
      • detectTurnInterruption()            // 检测中断的对话轮次
      • 注入 "Continue from where you left off." （如果中断）
      • 追加 NO_RESPONSE_REQUESTED 哨兵消息
```

### 5.3 链式重建算法

核心算法 `buildConversationChain`：

```typescript
function buildConversationChain(
  messages: Map<UUID, TranscriptMessage>,
  leafMessage: TranscriptMessage,
): TranscriptMessage[] {
  const transcript: TranscriptMessage[] = []
  const seen = new Set<UUID>()
  let currentMsg = leafMessage
  while (currentMsg) {
    if (seen.has(currentMsg.uuid)) break  // 循环检测
    seen.add(currentMsg.uuid)
    transcript.push(currentMsg)
    currentMsg = currentMsg.parentUuid
      ? messages.get(currentMsg.parentUuid)
      : undefined
  }
  transcript.reverse()
  return recoverOrphanedParallelToolResults(messages, transcript, seen)
}
```

这是一个从叶到根的反向遍历，然后 reverse 得到时间顺序。

### 5.4 并行工具结果恢复

由于流式输出将并行 `tool_use` 拆分为多个 `AssistantMessage`（每个有不同 UUID 但相同 `message.id`），链式遍历只能走一条分支。`recoverOrphanedParallelToolResults` 负责：

1. 收集同一 `message.id` 的所有兄弟 assistant 消息
2. 找到不在主链上的兄弟及其 `tool_result` 子消息
3. 按原始顺序插回主链

### 5.5 大文件优化

对超过 5MB 的 JSONL 文件（`SKIP_PRECOMPACT_THRESHOLD`）：
- **跳过 compact 前的字节**：直接从最后一个 compact 边界开始解析
- **先链式遍历再解析**：`walkChainBeforeParse` 仅解析链上需要的行
- **跳过 attribution-snapshot**：避免 OOM

### 5.6 轻量级元数据读取

列出会话列表时不需要加载全部消息。`readLiteMetadata` 只读取文件的头尾各 128KB（`LITE_READ_BUF_SIZE`），提取 `firstPrompt`、`customTitle` 等元数据字段。会话退出时会通过 `reAppendSessionMetadata` 将元数据追加到文件末尾，确保尾部读取能找到。

### 5.7 content-replacement 状态重建

resume 时，通过 `reconstructContentReplacementState` 从 JSONL 中的 `content-replacement` 条目重建替换状态，确保 prompt cache 的前缀稳定性：

```typescript
function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[],
): ContentReplacementState {
  const state = createContentReplacementState()
  // 收集所有候选 toolUseId
  const candidateIds = collectCandidatesByMessage(messages).flat().map(c => c.toolUseId)
  // 标记所有候选为已见（冻结）
  for (const id of candidateIds) state.seenIds.add(id)
  // 应用已记录的替换
  for (const r of records) {
    if (r.kind === 'tool-result' && candidateIds.has(r.toolUseId)) {
      state.replacements.set(r.toolUseId, r.replacement)
    }
  }
  return state
}
```

---

## 六、架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         写入路径 (Write Path)                        │
│                                                                     │
│  REPL Message[]                                                     │
│       │                                                             │
│       ▼                                                             │
│  useLogMessages()                                                   │
│       │                                                             │
│       ▼                                                             │
│  recordTranscript()  ──── UUID 去重 + cleanMessagesForLogging       │
│       │                                                             │
│       ▼                                                             │
│  insertMessageChain() ── 加盖 parentUuid/sessionId/cwd/version      │
│       │                                                             │
│       ├─── 主链 ───→ appendEntry() ──→ 写入队列(100ms 批次)          │
│       │                    │                                        │
│       │                    ▼                                        │
│       │              {sessionId}.jsonl                               │
│       │                                                             │
│       └─── 侧链 ───→ subagents/agent-{id}.jsonl                    │
│                                                                     │
│  [并行] Session Ingress (远程持久化)                                  │
│  [并行] CCR v2 (内部事件写入器)                                      │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                      大输出溢出 (Large Output Spill)                 │
│                                                                     │
│  工具结果 ─── 超过阈值? ──→ persistToolResult()                      │
│                    │              │                                  │
│                    │              ▼                                  │
│                    │    {sessionId}/tool-results/{toolUseId}.txt     │
│                    │              │                                  │
│                    │              ▼                                  │
│                    │    消息内替换为 <persisted-output> 预览引用       │
│                    │                                                │
│                    └── 未超过 ──→ 保持内联                           │
│                                                                     │
│  后台 Bash ──→ /tmp/.../tasks/{taskId}.output (最大 5GB)             │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         读取路径 (Read Path)                         │
│                                                                     │
│  {sessionId}.jsonl                                                  │
│       │                                                             │
│       ▼                                                             │
│  loadTranscriptFile()  ──── parseJSONL → Map<UUID, TranscriptMsg>   │
│       │                                                             │
│       ▼                                                             │
│  找到叶节点（最新非侧链消息）                                         │
│       │                                                             │
│       ▼                                                             │
│  buildConversationChain() ── parentUuid 反向遍历 → reverse           │
│       │                                                             │
│       ▼                                                             │
│  recoverOrphanedParallelToolResults() ── 修复 DAG 孤儿               │
│       │                                                             │
│       ▼                                                             │
│  removeExtraFields() ── 剥离 parentUuid/isSidechain                 │
│       │                                                             │
│       ▼                                                             │
│  deserializeMessagesWithInterruptDetection()                        │
│       │  • 过滤未完成 tool_use                                      │
│       │  • 过滤孤立 thinking                                        │
│       │  • 检测中断 → 注入 "Continue..."                             │
│       │  • 追加 NO_RESPONSE_REQUESTED 哨兵                          │
│       ▼                                                             │
│  恢复的 Message[] ──→ 送入 REPL                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 七、关键源码文件索引

### 核心存储

| 文件 | 职责 |
|------|------|
| `src/utils/sessionStorage.ts` | 主存储引擎（~5K 行），JSONL 读写、链式重建、元数据管理 |
| `src/utils/sessionStoragePortable.ts` | 路径清洗、轻量元数据读取、precompact 跳过 |
| `src/utils/conversationRecovery.ts` | Resume 加载 + 反序列化 |
| `src/utils/sessionRestore.ts` | Resume 后恢复文件历史、todo、worktree 等 |
| `src/types/logs.ts` | `Entry`、`TranscriptMessage`、`SerializedMessage`、`LogOption` 类型定义 |
| `src/types/message.js` | `Message`、`UserMessage`、`AssistantMessage` 等核心类型 |
| `src/hooks/useLogMessages.ts` | REPL Hook，每轮触发持久化 |

### 大输出存储

| 文件 | 职责 |
|------|------|
| `src/utils/toolResultStorage.ts` | 工具结果溢出存储、两级预算、替换状态管理 |
| `src/utils/mcpOutputStorage.ts` | MCP 二进制输出存储 |
| `src/utils/task/diskOutput.ts` | 后台任务磁盘输出（DiskTaskOutput） |
| `src/constants/toolLimits.ts` | 阈值常量定义 |

### 辅助存储

| 文件 | 职责 |
|------|------|
| `src/history.ts` | 命令行历史 (`~/.claude/history.jsonl`) |
| `src/utils/pasteStore.ts` | 粘贴文本缓存（内容寻址） |
| `src/utils/imageStore.ts` | 图片缓存 |
| `src/utils/fileHistory.ts` | 文件历史跟踪 |

### 远程/同步

| 文件 | 职责 |
|------|------|
| `src/services/api/sessionIngress.ts` | 远程会话持久化（HTTP PUT） |
| `src/assistant/sessionHistory.ts` | 云端会话事件分页 |

### Resume UI/CLI

| 文件 | 职责 |
|------|------|
| `src/main.tsx` | `--continue`、`--resume` CLI 入口 |
| `src/screens/ResumeConversation.tsx` | 交互式 resume 选择器 |
| `src/commands/resume/resume.tsx` | `/resume` 命令 |
| `src/utils/crossProjectResume.ts` | 跨项目 resume 检测 |

---

## 八、设计要点总结

1. **JSONL 追加式写入**：以会话 UUID 为文件名，按清洗后的项目路径组织目录。简单可靠，天然支持并发追加。

2. **parentUuid 链表 + DAG 恢复**：消息之间通过 parentUuid 形成链表，compact 边界处断开（`parentUuid: null`）。并行工具调用形成 DAG，读取时通过 `recoverOrphanedParallelToolResults` 修复。

3. **惰性文件创建**：会话文件在第一条真实消息到达时才创建，元数据暂存于 `pendingEntries`。

4. **大输出不内联**：超过阈值的工具结果写入 `tool-results/` 独立文件，JSONL 中仅保留 `<persisted-output>` 预览引用。prompt cache 语义稳定性通过 `ContentReplacementState` 保障。

5. **多阶段 Resume 管线**：解析 → 链式遍历 → DAG 修复 → 过滤 → 中断检测 → 恢复侧状态（文件历史、替换记录、worktree、技能等）。

6. **轻量级会话列表**：通过读取文件头尾 128KB 快速提取元数据，避免加载整个 JSONL。

7. **持久化可禁用**：测试环境、`cleanupPeriodDays=0`、`CLAUDE_CODE_SKIP_PROMPT_HISTORY` 等条件下跳过写入。
