# Claude Code 记忆系统架构深度分析

## 1. 概述

Claude Code 的记忆系统**不是一个单一模块**，而是由多个层级、多条数据通路组成的**分布式持久化架构**。它没有专门的 `MemoryTool`，而是通过「文件存储 + 系统提示词指导 + 通用文件工具 + 后台子代理自动提取」的组合实现了一套完整的记忆生命周期管理。

### 核心设计哲学

- **文件即记忆**：所有记忆最终都以 Markdown 文件形式存储在磁盘上
- **无专用工具**：模型通过通用的 `FileWrite`/`FileEdit` 工具写入记忆，而非专用 Memory API
- **提示词驱动**：记忆的写入规范、分类标准、格式要求都通过 system prompt 传达给模型
- **双轨写入**：主代理主动写入 + 后台子代理自动提取，形成互补
- **多层召回**：system prompt 注入 + 查询时相关性召回 + 主动搜索

---

## 2. 记忆层级体系

整个记忆系统分为 **六个层级**，每个层级有不同的作用域、持久性和管理方式：

### 2.1 层级总览

| 层级 | 存储位置 | 管理者 | 跨会话 | 跨项目 | 核心入口文件 |
|------|----------|--------|--------|--------|-------------|
| **托管记忆 (Managed)** | `/etc/claude-code/CLAUDE.md` | 管理员 | 是 | 是 | `claudemd.ts` |
| **用户记忆 (User)** | `~/.claude/CLAUDE.md` + `~/.claude/rules/*.md` | 用户 | 是 | 是 | `claudemd.ts` |
| **项目记忆 (Project)** | `CLAUDE.md` + `.claude/rules/*.md` | 用户/团队 | 是 | 否 | `claudemd.ts` |
| **本地记忆 (Local)** | `CLAUDE.local.md` | 用户 | 是 | 否 | `claudemd.ts` |
| **自动记忆 (AutoMem)** | `~/.claude/projects/<repo>/memory/` | Claude 自动 | 是 | 否 | `memdir.ts` |
| **团队记忆 (TeamMem)** | `<autoMemPath>/team/` + 云端 API | 团队 | 是 | 否 | `teamMemSync/` |

此外还有以下辅助记忆机制：

| 机制 | 存储位置 | 生命周期 | 核心入口 |
|------|----------|----------|----------|
| **会话记忆 (Session Memory)** | `~/.claude/projects/<cwd>/<sessionId>/session-memory/summary.md` | 当前会话 | `SessionMemory/` |
| **Agent 记忆** | `.claude/agent-memory/<type>/` 等 | 按 scope | `agentMemory.ts` |
| **TodoWrite** | 内存 (`AppState.todos`) | 当前会话 | `TodoWriteTool.ts` |
| **Task v2** | `~/.claude/tasks/<id>/*.json` | 跨会话 | `tasks.ts` |

### 2.2 类型枚举定义

指令型记忆的类型枚举定义在 `src/utils/memory/types.ts`：

```typescript
export const MEMORY_TYPE_VALUES = [
  'User',      // 用户全局指令 (~/.claude/CLAUDE.md)
  'Project',   // 项目指令 (CLAUDE.md, .claude/rules/*.md)
  'Local',     // 本地私有指令 (CLAUDE.local.md)
  'Managed',   // 管理员指令 (/etc/claude-code/CLAUDE.md)
  'AutoMem',   // 自动记忆 (MEMORY.md)
  // 'TeamMem' — 仅在 TEAMMEM feature flag 开启时存在
] as const
```

自动记忆的四类分类定义在 `src/memdir/memoryTypes.ts`：

```typescript
export const MEMORY_TYPES = [
  'user',       // 用户角色、目标、偏好
  'feedback',   // 用户对工作方式的反馈指导
  'project',    // 项目上下文（非代码可推导的）
  'reference',  // 外部系统指针、API 参考
] as const
```

---

## 3. 指令型记忆 (CLAUDE.md 体系)

### 3.1 加载优先级

`src/utils/claudemd.ts` 文件头注释明确定义了加载顺序：

```
1. Managed memory  (/etc/claude-code/CLAUDE.md)     — 全局指令，所有用户共享
2. User memory     (~/.claude/CLAUDE.md)             — 用户私有全局指令
3. Project memory  (CLAUDE.md, .claude/rules/*.md)   — 项目级指令，签入代码库
4. Local memory    (CLAUDE.local.md)                 — 项目级私有指令
```

**加载顺序与优先级相反**：后加载的文件优先级更高，模型会更关注它们。

### 3.2 路径解析

`src/utils/config.ts` 中的 `getMemoryPath()` 负责路径解析：

```typescript
export function getMemoryPath(memoryType: MemoryType): string {
  switch (memoryType) {
    case 'User':    return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
    case 'Local':   return join(cwd, 'CLAUDE.local.md')
    case 'Project': return join(cwd, 'CLAUDE.md')
    case 'Managed': return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem': return getAutoMemEntrypoint()
  }
}
```

### 3.3 Rules 目录 (条件规则)

除了 `CLAUDE.md` 主文件外，系统还支持 `.claude/rules/*.md` 规则目录。这些规则文件支持 **frontmatter `paths:` 字段**进行条件匹配 — 只有当对话涉及特定文件路径时才会注入：

```typescript
// src/utils/claudemd.ts
export async function processMdRules({
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  conditionalRule,
  visitedDirs,
}: { ... }): Promise<MemoryFileInfo[]>
```

规则目录路径：
- 托管规则：`/etc/claude-code/.claude/rules/`
- 用户规则：`~/.claude/rules/`
- 项目规则：`.claude/rules/`

### 3.4 注入对话上下文

`src/context.ts` 中的 `getUserContext()` 将所有 CLAUDE.md 文件内容格式化后注入：

```typescript
export const getUserContext = memoize(
  async (): Promise<{ [k: string]: string }> => {
    const claudeMd = shouldDisableClaudeMd
      ? null
      : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))
    return {
      ...(claudeMd && { claudeMd }),
      currentDate: `Today's date is ${getLocalISODate()}.`,
    }
  },
)
```

注入方式是通过 `prependUserContext()` 在消息流开头插入一条 `<system-reminder>` 消息：

```typescript
// src/utils/api.ts
export function prependUserContext(messages, context): Message[] {
  return [
    createUserMessage({
      content: `<system-reminder>\nAs you answer the user's questions...\n# claudeMd\n${context.claudeMd}\n...`
    }),
    ...messages,
  ]
}
```

### 3.5 格式化显示

`getClaudeMds()` 为不同类型的记忆文件添加描述标签：

| 类型 | 描述标签 |
|------|---------|
| Project | `(project instructions, checked into the codebase)` |
| Local | `(user's private project instructions, not checked in)` |
| AutoMem | `(user's auto-memory, persists across conversations)` |
| User | `(user's private global instructions for all projects)` |

---

## 4. 自动记忆系统 (memdir)

自动记忆是 Claude Code 记忆系统中**最复杂**的子系统，由模型自主管理。

### 4.1 开关与配置

`src/memdir/paths.ts` 定义了开关优先级链：

```
1. CLAUDE_CODE_DISABLE_AUTO_MEMORY 环境变量 (1/true → 关闭)
2. CLAUDE_CODE_SIMPLE (--bare 模式) → 关闭
3. CCR 无持久存储 → 关闭
4. settings.json 中 autoMemoryEnabled → 项目级控制
5. 默认：启用
```

### 4.2 存储结构

自动记忆存储在 `~/.claude/projects/<sanitized-git-root>/memory/` 下：

```
memory/
├── MEMORY.md                    # 索引文件（入口点）
├── user_role.md                 # 用户类型记忆
├── feedback_testing.md          # 反馈类型记忆
├── project_migration.md         # 项目类型记忆
├── reference_api_docs.md        # 引用类型记忆
├── team/                        # 团队记忆子目录 (TEAMMEM)
│   ├── MEMORY.md
│   └── *.md
└── logs/                        # KAIROS 日志模式
    └── YYYY/MM/YYYY-MM-DD.md
```

### 4.3 MEMORY.md 索引机制

`MEMORY.md` 是自动记忆的**索引文件**而非记忆本身。每条记忆存储为独立 `.md` 文件，索引只保留一行链接：

```markdown
- [User Role](user_role.md) — Senior backend engineer, prefers concise responses
- [Testing Policy](feedback_testing.md) — Integration tests must hit real DB, no mocks
```

关键限制（定义在 `src/memdir/memdir.ts`）：

```typescript
export const MAX_ENTRYPOINT_LINES = 200     // 最多 200 行
export const MAX_ENTRYPOINT_BYTES = 25_000   // 最多 ~25KB
```

超出限制时会进行截断并附加警告。

### 4.4 记忆文件 Frontmatter 格式

每个记忆文件使用标准 frontmatter 格式：

```yaml
---
name: User Role
type: user
description: Information about the user's role and preferences
---

实际记忆内容...
```

### 4.5 四类记忆 Taxonomy

| 类型 | 描述 | 典型内容 |
|------|------|----------|
| **user** | 用户角色、目标、知识水平 | "用户是高级后端工程师，偏好简洁回复" |
| **feedback** | 用户对工作方式的纠正和确认 | "不要在测试中 mock 数据库" |
| **project** | 项目上下文（代码/git 不可推导的） | "Q3 迁移截止日期 2026-09-01" |
| **reference** | 外部系统指针和 API 参考 | "部署 PR 需走 #deploy-queue 频道" |

**明确排除**的内容（定义在 `memoryTypes.ts`）：
- 代码模式、架构（可通过 grep/git 获取）
- CLAUDE.md 中已有的内容
- 临时任务细节、进行中的工作状态
- 当前对话的上下文

### 4.6 保存流程 (两步写入)

由于没有专用 MemoryTool，记忆写入通过系统提示词指导模型使用通用文件工具完成：

```
Step 1: FileWrite → 写入独立记忆文件 (如 user_role.md)
Step 2: FileEdit → 在 MEMORY.md 索引中添加一行链接
```

权限放行：`src/utils/permissions/filesystem.ts` 中通过 `isAutoMemPath()` / `isAgentMemoryPath()` 检查，自动记忆目录绕过危险目录限制。

### 4.7 System Prompt 注入

`loadMemoryPrompt()` 是记忆提示词的主入口，按优先级分派：

```typescript
// src/memdir/memdir.ts
export async function loadMemoryPrompt(): Promise<string | null> {
  // 1. KAIROS 日志模式（长会话助手）
  if (feature('KAIROS') && autoEnabled && getKairosActive()) {
    return buildAssistantDailyLogPrompt(skipIndex)
  }
  // 2. 团队记忆模式 (auto + team 双目录)
  if (feature('TEAMMEM') && teamMemPaths.isTeamMemoryEnabled()) {
    return teamMemPrompts.buildCombinedMemoryPrompt(...)
  }
  // 3. 普通自动记忆模式
  if (autoEnabled) {
    return buildMemoryLines('auto memory', autoDir, ...).join('\n')
  }
  // 4. 禁用状态
  return null
}
```

在 `src/constants/prompts.ts` 中作为 system prompt 的一个 section 注册：

```typescript
const dynamicSections = [
  systemPromptSection('session_guidance', () => ...),
  systemPromptSection('memory', () => loadMemoryPrompt()),  // ← 记忆 section
  systemPromptSection('ant_model_override', () => ...),
  // ...
]
```

---

## 5. 记忆召回机制

记忆的读取有三条并行路径：

### 5.1 路径一：System Prompt 注入

每次对话开始时，`loadMemoryPrompt()` 将记忆行为说明注入 system prompt，`getUserContext()` 将 CLAUDE.md / MEMORY.md 内容注入 user context 消息。这些信息在**每轮对话**中都可见。

### 5.2 路径二：查询时相关性召回

`src/memdir/findRelevantMemories.ts` 实现了基于查询的记忆召回：

```typescript
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[],
  alreadySurfaced: ReadonlySet<string>,
): Promise<RelevantMemory[]>
```

**工作流程：**
1. `scanMemoryFiles()` 扫描记忆目录所有 `.md` 文件的 frontmatter
2. 过滤掉已经展示过的文件（`alreadySurfaced`）
3. 调用 Sonnet 模型（`sideQuery`）对记忆列表做相关性选择
4. 返回最多 **5 个**最相关的记忆文件路径

**选择提示词：**
```
You are selecting memories that will be useful to Claude Code as it processes 
a user's query. Return a list of filenames for the memories that will clearly 
be useful (up to 5). Only include memories that you are certain will be helpful.
```

**注入方式：** 通过 `src/utils/attachments.ts` 中的 `getRelevantMemoryAttachments()` 作为 attachment 注入消息流。

**Compact 后重置：** 压缩后旧的 attachment 被移除，允许记忆重新被召回：

```typescript
// Scanning messages rather than tracking in toolUseContext means compact 
// naturally resets both — old attachments are gone from the compacted 
// transcript, so re-surfacing is valid again.
```

### 5.3 路径三：主动搜索

模型可以使用 `Grep` / `Glob` / `FileRead` 工具主动搜索记忆目录。system prompt 中的 `buildSearchingPastContextSection()` 提供了搜索指引：

```
## Searching past context
1. Search topic files in your memory directory:
   Grep with pattern="<search term>" path="<memoryDir>" glob="*.md"
2. Session transcript logs (last resort — large files, slow):
   Grep with pattern="<search term>" path="<projectDir>/" glob="*.jsonl"
```

---

## 6. 记忆写入三条通路

### 6.1 通路一：主代理主动写入

当用户明确要求"记住某事"或模型判断需要保存记忆时，主代理直接调用 `FileWrite`/`FileEdit` 写入记忆文件。system prompt 中提供了完整的格式规范和分类指引。

### 6.2 通路二：后台自动提取 (extractMemories)

`src/services/extractMemories/extractMemories.ts` 实现了后台记忆提取：

**触发时机：** 每次 query loop 结束时（模型产生无 tool call 的最终回复），通过 `stopHooks.ts` 中的 `handleStopHooks` 触发。

**运行方式：** 使用 `runForkedAgent` 创建一个 forked 子代理，它共享父代理的 prompt cache，以极低成本运行。

**互斥机制：** 如果主代理在同一回合中已经写入了记忆（通过 `hasMemoryWritesSince()` 检测），则跳过后台提取，避免重复。

```typescript
/**
 * Returns true if any assistant message after the cursor UUID contains a
 * Write/Edit tool_use block targeting an auto-memory path.
 * The main agent's prompt has full save instructions — when it writes
 * memories, the forked extraction is redundant.
 */
```

**工具权限：** 子代理仅允许使用 Read、Grep、Glob、只读 Bash、FileEdit/FileWrite（仅限 memoryDir 内），确保安全隔离。

### 6.3 通路三：夜间记忆整合 (autoDream)

`src/services/autoDream/autoDream.ts` 实现了定期记忆整合：

**触发条件（按成本排序）：**
1. **时间门控**：距上次整合 ≥ `minHours`（默认 24 小时）
2. **会话门控**：自上次整合以来的 transcript 数量 ≥ `minSessions`（默认 5 个）
3. **锁门控**：没有其他进程正在整合

**整合内容：** 将日志（`logs/YYYY/MM/YYYY-MM-DD.md`）蒸馏为结构化的 topic 文件和 `MEMORY.md` 索引。

**KAIROS 模式：** 长会话助手模式下，记忆采用追加写入日志文件的方式（而非维护 MEMORY.md），由 `/dream` 命令或夜间自动整合进行蒸馏。

---

## 7. 会话记忆 (Session Memory)

### 7.1 概述

`src/services/SessionMemory/sessionMemory.ts` 实现了**会话级别**的记忆提取。它不是跨会话持久化的记忆，而是在**同一会话内**维护一份摘要笔记，主要用于 compact（上下文压缩）时保留关键信息。

### 7.2 存储路径

```
~/.claude/projects/<cwd>/<sessionId>/session-memory/summary.md
```

### 7.3 触发条件

```typescript
export function shouldExtractMemory(messages: Message[]): boolean {
  const currentTokenCount = tokenCountWithEstimation(messages)
  // 初始化阈值 + 更新阈值（基于 tokens 和 tool calls 数量）
  const shouldExtract =
    (hasMetTokenThreshold && hasMetToolCallThreshold) ||
    (hasMetTokenThreshold && !hasToolCallsInLastTurn)
}
```

### 7.4 与 Compact 的关系

会话记忆的核心用途是在 compact 时注入，防止重要的会话上下文在压缩中丢失：

```typescript
// src/services/compact/sessionMemoryCompact.ts
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokens: 10_000,
  maxTokens: 40_000,
  minTextBlockMessages: 5,
}
```

### 7.5 初始化

```typescript
// src/services/SessionMemory/sessionMemory.ts
export function initSessionMemory(): void {
  if (getIsRemoteMode()) return
  const autoCompactEnabled = isAutoCompactEnabled()
  if (!autoCompactEnabled) return
  registerPostSamplingHook(extractSessionMemory)
}
```

会话记忆与 auto-compact 绑定：只有启用了自动压缩时，才会初始化会话记忆提取。

---

## 8. Agent 记忆

### 8.1 三种 Scope

`src/tools/AgentTool/agentMemory.ts` 定义了 Agent 记忆的三种作用域：

```typescript
export type AgentMemoryScope = 'user' | 'project' | 'local'

export function getAgentMemoryDir(agentType: string, scope: AgentMemoryScope): string {
  switch (scope) {
    case 'project': return join(getCwd(), '.claude', 'agent-memory', dirName) + sep
    case 'local':   return getLocalAgentMemoryDir(dirName)    // .claude/agent-memory-local/
    case 'user':    return join(getMemoryBaseDir(), 'agent-memory', dirName) + sep
  }
}
```

| Scope | 路径 | 说明 |
|-------|------|------|
| user | `~/.claude/agent-memory/<type>/` | 用户级，所有项目共享 |
| project | `.claude/agent-memory/<type>/` | 项目级，可提交到 VCS |
| local | `.claude/agent-memory-local/<type>/` | 本地，不提交到 VCS |

### 8.2 记忆加载

Agent 记忆使用独立的 `loadAgentMemoryPrompt()` 加载，区别于主代理的 `loadMemoryPrompt()`。它调用 `buildMemoryPrompt()` 读取 MEMORY.md 内容并内联到提示词中（因为 Agent 没有 `getClaudeMds()` 等效机制）。

### 8.3 记忆快照

`src/tools/AgentTool/agentMemorySnapshot.ts` 提供了 Agent 记忆快照机制，路径为 `.claude/agent-memory-snapshots/<type>/`。

---

## 9. 记忆与上下文压缩的交互

### 9.1 三层压缩体系

| 层级 | 实现文件 | 触发条件 | 作用 |
|------|----------|----------|------|
| **微压缩 (microcompact)** | `microCompact.ts` | 每次查询前 | 清理旧 tool result（文件读取、搜索结果等） |
| **自动压缩 (autocompact)** | `autoCompact.ts` | token 超阈值 | 生成对话摘要，截断旧消息 |
| **会话记忆压缩** | `sessionMemoryCompact.ts` | compact 时 | 将 session memory 注入压缩摘要 |

### 9.2 压缩与记忆的关键交互

**Compact 后重载记忆：**
```typescript
// claudemd.ts
resetGetMemoryFilesCache('compact')  // compact 后清除缓存，重载 CLAUDE.md
```

**Compact 后记忆召回重置：** 旧的 `relevant_memories` attachment 随压缩消失，允许记忆重新被召回。

**微压缩可压缩的工具：**
```typescript
const COMPACTABLE_TOOLS = new Set([
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

---

## 10. 记忆文件检测与权限

### 10.1 用户管理 vs Claude 管理

`src/utils/memoryFileDetection.ts` 区分两类记忆文件：

| 分类 | 包含 | 管理者 |
|------|------|--------|
| **用户管理** | `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/*.md` | 用户 |
| **Claude 管理** | auto-memory、agent memory、session memory | Claude 自动 |

```typescript
/**
 * Check if a file is a Claude-managed memory file (NOT user-managed instruction files).
 * Includes: auto-memory (memdir), agent memory, session memory/transcripts.
 * Excludes: CLAUDE.md, CLAUDE.local.md, .claude/rules/*.md (user-managed).
 */
export function isAutoManagedMemoryFile(filePath: string): boolean
```

### 10.2 文件系统权限放行

`src/utils/permissions/filesystem.ts` 对记忆路径有特殊放行：自动记忆文件被允许读写，无需用户确认。

---

## 11. 团队记忆同步

### 11.1 概述

`src/services/teamMemorySync/` 实现了团队记忆的云端同步（需要 `TEAMMEM` feature flag）。

### 11.2 同步语义

```typescript
/**
 * Sync semantics:
 *   - Pull overwrites local files with server content (server wins per-key).
 *   - Push uploads only keys whose content hash differs from serverChecksums.
 */
```

### 11.3 路径

团队记忆存储在自动记忆目录的 `team/` 子目录下：`<autoMemPath>/team/`。

按 repo 维度隔离（通过 git remote hash 标识）。

---

## 12. 辅助命令与技能

### 12.1 `/memory` 命令

`src/commands/memory/memory.tsx` — 打开记忆文件选择器，允许用户编辑各层记忆文件。

### 12.2 `/remember` 技能

`src/skills/bundled/remember.ts` — 审查自动记忆并提议晋升到更高层级：

| 目标 | 适合内容 | 示例 |
|------|----------|------|
| **CLAUDE.md** | 项目约定、构建规则 | "use bun not npm" |
| **CLAUDE.local.md** | 个人指令、偏好 | "I prefer concise responses" |
| **Team memory** | 组织知识、流程 | "deploy PRs go through #deploy-queue" |
| **Stay in auto-memory** | 工作笔记、临时观察 | 会话特定的观察 |

### 12.3 `/dream` 技能

手动触发记忆整合（等同于 `autoDream` 的手动版本），将日志蒸馏为结构化记忆。

---

## 13. 初始化与生命周期

### 13.1 启动链

```
main.tsx
  └─ setup.ts
       ├─ initSessionMemory()           // 注册 post-sampling hook
       └─ clearMemoryFileCaches()       // worktree 切换时清缓存

backgroundHousekeeping.ts
  ├─ initExtractMemories()             // 初始化后台记忆提取
  └─ initAutoDream()                   // 初始化夜间整合

constants/prompts.ts
  └─ systemPromptSection('memory', loadMemoryPrompt)  // 注册记忆 system prompt section

context.ts
  └─ getUserContext() → getClaudeMds(getMemoryFiles())  // 加载 CLAUDE.md 内容

attachments.ts
  └─ getRelevantMemoryAttachments()    // 每轮用户输入时召回相关记忆

stopHooks.ts
  ├─ executeExtractMemories()          // 回合结束后台提取
  └─ executeAutoDream()                // 检查是否需要夜间整合
```

### 13.2 每轮对话数据流

```
用户输入
  ↓
getRelevantMemoryAttachments()    ← 查询相关记忆
  ↓
getMessagesAfterCompactBoundary   ← 取 compact 边界后的消息
  ↓
microcompactMessages              ← 微压缩旧 tool result
  ↓
autoCompactIfNeeded               ← 必要时自动压缩
  ↓
appendSystemContext(loadMemoryPrompt())  ← 注入记忆 system prompt
  ↓
prependUserContext(getClaudeMds())       ← 注入 CLAUDE.md 内容
  ↓
callModel → normalizeMessagesForAPI     ← 发送给模型
  ↓
模型回复（可能包含 FileWrite 写入记忆）
  ↓
handleStopHooks
  ├─ executeExtractMemories()    ← 后台记忆提取
  └─ executeAutoDream()          ← 夜间整合检查
```

---

## 14. 配置项汇总

| 设置/环境变量 | 作用 | 默认值 |
|---------------|------|--------|
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | 关闭自动记忆 | `false` |
| `CLAUDE_CODE_SIMPLE` | --bare 极简模式，关闭记忆 | `false` |
| `CLAUDE_CODE_DISABLE_CLAUDE_MDS` | 禁用 CLAUDE.md 加载 | `false` |
| `CLAUDE_CODE_REMOTE_MEMORY_DIR` | 远程/CCR 记忆挂载路径 | 未设置 |
| `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` | Cowork 全路径覆盖 | 未设置 |
| `CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES` | Cowork 额外记忆策略 | 未设置 |
| `autoMemoryEnabled` (settings.json) | 项目级自动记忆开关 | `true` |
| `autoMemoryDirectory` (settings.json) | 自定义记忆存储路径 | 默认路径 |
| `claudeMdExcludes` (settings.json) | 排除特定 CLAUDE.md | 空 |
| `autoDreamEnabled` (settings.json) | 夜间整合开关 | `true` |

---

## 15. 关键源文件索引

| 文件路径 | 职责 |
|----------|------|
| `src/memdir/memdir.ts` | 自动记忆 prompt 构建核心，`loadMemoryPrompt()` |
| `src/memdir/paths.ts` | 路径解析、开关检测 |
| `src/memdir/memoryTypes.ts` | 四类记忆 taxonomy 和 prompt 段落 |
| `src/memdir/memoryScan.ts` | 扫描记忆目录 frontmatter |
| `src/memdir/findRelevantMemories.ts` | 查询时相关性召回 |
| `src/memdir/memoryAge.ts` | 记忆新鲜度计算 |
| `src/memdir/teamMemPaths.ts` | 团队记忆路径 |
| `src/memdir/teamMemPrompts.ts` | 团队+私有组合 prompt |
| `src/utils/claudemd.ts` | CLAUDE.md 发现、加载、@include、rules |
| `src/utils/config.ts` | `getMemoryPath()` 路径解析 |
| `src/utils/memory/types.ts` | `MemoryType` 枚举 |
| `src/utils/memoryFileDetection.ts` | 用户管理 vs Claude 管理文件检测 |
| `src/utils/teamMemoryOps.ts` | 团队记忆操作 |
| `src/context.ts` | `getUserContext()` 注入 CLAUDE.md |
| `src/constants/prompts.ts` | system prompt 组装，记忆 section 注册 |
| `src/services/SessionMemory/sessionMemory.ts` | 会话记忆后台提取 |
| `src/services/SessionMemory/prompts.ts` | 会话记忆提取 prompt |
| `src/services/extractMemories/extractMemories.ts` | 自动记忆后台提取 |
| `src/services/extractMemories/prompts.ts` | 提取 prompt |
| `src/services/autoDream/autoDream.ts` | 夜间记忆整合 |
| `src/services/autoDream/consolidationPrompt.ts` | 整合 prompt |
| `src/services/teamMemorySync/index.ts` | 团队记忆云端同步 |
| `src/services/compact/sessionMemoryCompact.ts` | compact 时引用会话记忆 |
| `src/tools/AgentTool/agentMemory.ts` | Agent 持久记忆 |
| `src/tools/AgentTool/agentMemorySnapshot.ts` | Agent 记忆快照 |
| `src/tools/TodoWriteTool/TodoWriteTool.ts` | 会话内 Todo（内存） |
| `src/utils/attachments.ts` | 相关记忆 attachment 注入 |
| `src/commands/memory/memory.tsx` | `/memory` 命令 |
| `src/skills/bundled/remember.ts` | `/remember` 技能 |

---

## 16. 架构总结

Claude Code 的记忆系统体现了以下设计理念：

1. **分层解耦**：指令记忆（用户控制）与自动记忆（AI 控制）完全分离，各有独立的存储、加载、管理路径
2. **提示词即接口**：没有专用 Memory API，而是通过详尽的 system prompt 告知模型记忆的存储位置、格式、分类标准
3. **双轨保障**：主代理主动写入 + 后台子代理兜底提取，确保重要信息不遗漏
4. **渐进式召回**：索引全量注入 + 查询相关性按需加载 + 主动搜索三级召回
5. **生命周期管理**：从创建、更新、召回到整合（/dream）形成完整循环
6. **安全隔离**：记忆文件权限放行与文件检测相结合，区分用户管理和 AI 管理的文件
