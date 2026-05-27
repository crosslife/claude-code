# LLM 请求完整文本布局可视化

> 本文档以**完全展开的方式**呈现每次发送给 LLM 的 API 请求的精确布局，包括所有字段、文本内容、及其嵌套结构。重点在于"最终发出去的是什么"，而非中间处理过程。

---

## 一、API 请求的顶层 JSON 结构

```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 16384,
  "stream": true,

  "system": [ /* TextBlockParam[] — 系统提示词 */ ],
  "messages": [ /* MessageParam[] — 对话历史 */ ],
  "tools": [ /* BetaToolUnion[] — 工具定义 */ ],

  "tool_choice": { "type": "auto" },
  "betas": ["tool-search-2025-04-15", "prompt-caching-2024-07-31"],
  "metadata": { "user_id": "{\"device_id\":\"xxx\",\"account_uuid\":\"yyy\",\"session_id\":\"zzz\"}" },
  "thinking": { "type": "adaptive" },
  "temperature": 1
}
```

三大核心字段：`system`、`messages`、`tools`。以下逐一完全展开。

---

## 二、`system` 字段 — 系统提示词完整布局

`system` 是一个 `TextBlockParam[]` 数组。每个元素：

```json
{ "type": "text", "text": "...", "cache_control": { "type": "ephemeral", "scope": "global" } }
```

### 全部文本按顺序拼接后的完整逻辑布局：

```
╔══════════════════════════════════════════════════════════════════════╗
║ Block 1: Attribution Header                                         ║
║ cache_control: { type: "ephemeral", scope: "global" }               ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║ Human: <attribution>                                                 ║
║ fingerprint: {"installId":"...","accountUuid":"..."}                 ║
║ </attribution>                                                       ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║ Block 2: CLI Identity + Static Sections (全局缓存)                   ║
║ cache_control: { type: "ephemeral", scope: "global" }               ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║ You are Claude Code, Anthropic's official CLI for Claude.            ║
║                                                                      ║
║ ─── Section 1: Intro ───                                             ║
║                                                                      ║
║ You are an interactive CLI agent specializing in software            ║
║ engineering tasks. You operate in a loop of:                         ║
║ 1. Reading user messages/tool results                                ║
║ 2. Thinking about the best approach                                  ║
║ 3. Using available tools or responding to the user                   ║
║                                                                      ║
║ IMPORTANT: You must never generate, assist with, or provide          ║
║ information that could be used for cyberattacks...                    ║
║                                                                      ║
║ When providing URLs to the user:                                     ║
║ - Default to plain text URLs                                         ║
║ - Only use markdown links [text](url) when...                        ║
║                                                                      ║
║ ─── Section 2: # System ───                                          ║
║                                                                      ║
║ # System                                                             ║
║                                                                      ║
║ ## Markdown usage                                                    ║
║ - Use markdown formatting only in text blocks that are...            ║
║                                                                      ║
║ ## Permissions and safety                                            ║
║ - You may need to ask for user permission (YOLO mode rules...)       ║
║                                                                      ║
║ ## Hooks                                                             ║
║ - Pre/post hook system for tool execution monitoring...              ║
║                                                                      ║
║ ## Context compression                                               ║
║ - Your conversation context may be compressed via...                 ║
║                                                                      ║
║ ─── Section 3: # Doing tasks ───                                     ║
║                                                                      ║
║ # Doing tasks                                                        ║
║                                                                      ║
║ - When coding, follow existing patterns and style                    ║
║ - Never output passwords, API keys, or secrets                       ║
║ - Use Read before Edit to verify current file content                ║
║ - Prefer editing over creating new files                             ║
║ - Search for existing code before writing new implementations        ║
║ ...                                                                  ║
║                                                                      ║
║ ─── Section 4: # Executing actions with care ───                     ║
║                                                                      ║
║ # Executing actions with care                                        ║
║                                                                      ║
║ - Always prefer reversible actions over irreversible ones            ║
║ - If asked to do something potentially destructive, confirm first    ║
║ ...                                                                  ║
║                                                                      ║
║ ─── Section 5: # Using your tools ───                                ║
║                                                                      ║
║ # Using your tools                                                   ║
║                                                                      ║
║ - Use Read to read files, not Bash with cat/head/tail                ║
║ - Use Glob to find files by name, not Bash with find                 ║
║ - Use Grep to search file contents, not Bash with grep/rg            ║
║ - Use Edit/Write tools for file modifications, not Bash with sed     ║
║ - Call multiple tools in parallel when independent                   ║
║ ...                                                                  ║
║                                                                      ║
║ ─── Section 6: # Tone and style ───                                  ║
║                                                                      ║
║ # Tone and style                                                     ║
║                                                                      ║
║ - Don't use emoji unless the user explicitly requests it             ║
║ - Use `file:line` format for code references                         ║
║ - Don't use a colon before tool calls                                ║
║ - Be concise, not verbose                                            ║
║ ...                                                                  ║
║                                                                      ║
║ ─── Section 7: # Output efficiency ───                               ║
║                                                                      ║
║ # Output efficiency                                                  ║
║                                                                      ║
║ - Minimize text output between tool calls                            ║
║ - Avoid repeating information already in context                     ║
║ ...                                                                  ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║ ══ SYSTEM_PROMPT_DYNAMIC_BOUNDARY (缓存分割线) ══                    ║
╠══════════════════════════════════════════════════════════════════════╣
║ Block 3: Dynamic Sections (org 级缓存或不缓存)                        ║
║ cache_control: { type: "ephemeral", scope: "org" }                   ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║ ─── Section 8: Session Guidance ───                                  ║
║                                                                      ║
║ ## AskUser                                                           ║
║ Use the AskUser tool when you need more information...               ║
║                                                                      ║
║ ## Shell hints                                                       ║
║ Prefix shell commands with ! for quick execution...                  ║
║                                                                      ║
║ ## Agent tool                                                        ║
║ Use the Agent tool for parallelizable subtasks...                    ║
║                                                                      ║
║ ─── Section 9: Memory ───                                            ║
║                                                                      ║
║ # Memory                                                             ║
║ You have access to a memory system via memory:// paths...            ║
║                                                                      ║
║ ─── Section 10: # Environment ───                                    ║
║                                                                      ║
║ # Environment                                                        ║
║ CWD: /home/user/project                                              ║
║ Is directory a git repo: Yes                                         ║
║ Platform: linux                                                      ║
║ Shell: /bin/bash                                                     ║
║ OS Version: Linux 5.15.0                                             ║
║ Model: Claude Sonnet 4 (claude-sonnet-4-20250514)                    ║
║ Knowledge cutoff: Early 2025                                         ║
║                                                                      ║
║ ─── Section 11: Language ───                                         ║
║                                                                      ║
║ # Language                                                           ║
║ Respond in: zh-CN                                                    ║
║                                                                      ║
║ ─── Section 12: Output Style (if configured) ───                     ║
║                                                                      ║
║ # Output Style: concise                                              ║
║ ...                                                                  ║
║                                                                      ║
║ ─── Section 13: MCP Instructions (不缓存) ───                        ║
║                                                                      ║
║ # MCP Server Instructions                                            ║
║                                                                      ║
║ ## server-name                                                       ║
║ Description of the MCP server and how to use it...                   ║
║ Available tools: tool1, tool2, tool3                                  ║
║                                                                      ║
║ ─── Section 14: Scratchpad ───                                       ║
║                                                                      ║
║ # Scratchpad                                                         ║
║ You have access to a scratchpad directory at...                       ║
║                                                                      ║
║ ─── Section 15: Function Result Clearing ───                         ║
║                                                                      ║
║ # Function Result Clearing                                           ║
║ Old tool results may be cleared with [Old tool result content        ║
║ cleared]. Always write down important information before this         ║
║ happens...                                                           ║
║                                                                      ║
║ ─── Section 16: Summarize Tool Results ───                           ║
║                                                                      ║
║ IMPORTANT: Before tool results are cleared, write down any           ║
║ important information you need to remember...                        ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║ Block 4: System Context (追加，无缓存)                                ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║ gitStatus: On branch main                                            ║
║ Your branch is up to date with 'origin/main'.                        ║
║ nothing to commit, working tree clean                                ║
║                                                                      ║
║ Recent commits:                                                      ║
║ abc1234 feat: add user auth (2 hours ago)                            ║
║ def5678 fix: resolve null check (1 day ago)                          ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## 三、`messages` 字段 — 对话历史完整布局

### 核心规则

1. **只有两种 role**：`user` 和 `assistant`（没有 `tool`/`function` 角色）
2. **`tool_use`** 是 assistant 消息中的 content block
3. **`tool_result`** 是 user 消息中的 content block
4. **必须严格交替** user → assistant → user → assistant → ...
5. **连续 user 消息会被合并**为单条（多个 content block）

### 完整多轮对话示例

```json
[
  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 0: User Context Injection (meta, 用户不可见)             │
  │ role: "user"                                                     │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "user",
    "content": "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\n\n## User rules\n- Always respond in Chinese\n- Use tabs for indentation\n\n## Project: /home/user/project/.claude/CLAUDE.md\n- This is a TypeScript project using ESM\n- Run tests with: npm test\n- Lint with: npm run lint\n\n# currentDate\nToday's date is Wednesday May 27, 2026.\n\nIMPORTANT: this context may or may not be relevant to your tasks.\nYou should not respond to this context unless it is highly relevant to your task.\n</system-reminder>"
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 1: Deferred Tools List (仅 Tool Search 启用时)           │
  │ role: "user"                                                     │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "user",
    "content": "<available-deferred-tools>\nBash - Execute shell commands\nFileEdit - Edit files using search and replace\nNotebook - Edit Jupyter notebooks\nmcp__server__special_tool - Special MCP tool description\n</available-deferred-tools>"
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 2: 用户真实输入                                          │
  │ role: "user"                                                     │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "user",
    "content": [
      { "type": "text", "text": "帮我修复 auth.ts 中的 bug" }
    ]
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 3: Assistant 回复（含思考 + 文本 + 工具调用）             │
  │ role: "assistant"                                                │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "用户想修复 auth.ts 中的 bug。我需要先读取这个文件来了解当前代码...",
        "signature": "ErUBCkYYAiJA..."
      },
      {
        "type": "text",
        "text": "让我先查看文件内容。"
      },
      {
        "type": "tool_use",
        "id": "toolu_01XaRGLqFz5JwMBPk3mYp8Dv",
        "name": "Read",
        "input": {
          "file_path": "/home/user/project/src/auth.ts"
        }
      }
    ]
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 4: 工具结果                                              │
  │ role: "user"                                                     │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01XaRGLqFz5JwMBPk3mYp8Dv",
        "content": "     1|import { verify } from 'jsonwebtoken'\n     2|import { db } from './database'\n     3|\n     4|export async function authenticate(token: string) {\n     5|  const decoded = verify(token, process.env.SECRET)\n     6|  return db.users.findOne({ id: decoded.id })\n     7|}"
      }
    ]
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 5: Assistant 分析并修改文件                               │
  │ role: "assistant"                                                │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "代码问题：verify() 没有 try-catch，token 无效时会抛出未捕获异常。需要添加错误处理。",
        "signature": "FxYCmQl7..."
      },
      {
        "type": "text",
        "text": "发现问题：`verify` 调用缺少错误处理，token 无效时会导致未捕获异常。"
      },
      {
        "type": "tool_use",
        "id": "toolu_02BkQz3rXpNvM7wYh9sJc4Kf",
        "name": "StrReplace",
        "input": {
          "path": "/home/user/project/src/auth.ts",
          "old_string": "  const decoded = verify(token, process.env.SECRET)\n  return db.users.findOne({ id: decoded.id })",
          "new_string": "  try {\n    const decoded = verify(token, process.env.SECRET)\n    return db.users.findOne({ id: decoded.id })\n  } catch (err) {\n    throw new AuthenticationError('Invalid token')\n  }"
        }
      }
    ]
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 6: 工具结果 + IDE 诊断（合并的 user 消息）               │
  │ role: "user"                                                     │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_02BkQz3rXpNvM7wYh9sJc4Kf",
        "content": "Successfully replaced text in /home/user/project/src/auth.ts"
      },
      {
        "type": "text",
        "text": "<diagnostics>\n/home/user/project/src/auth.ts:8:11 - error TS2304: Cannot find name 'AuthenticationError'.\n</diagnostics>"
      }
    ]
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 7: Assistant 继续修复（并行调用两个工具）                  │
  │ role: "assistant"                                                │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "assistant",
    "content": [
      {
        "type": "text",
        "text": "需要导入 AuthenticationError。让我找到它的定义并添加导入。"
      },
      {
        "type": "tool_use",
        "id": "toolu_03AaBbCcDdEeFf",
        "name": "Grep",
        "input": {
          "pattern": "class AuthenticationError",
          "path": "/home/user/project/src"
        }
      },
      {
        "type": "tool_use",
        "id": "toolu_04GgHhIiJjKkLl",
        "name": "Read",
        "input": {
          "file_path": "/home/user/project/src/errors.ts"
        }
      }
    ]
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 8: 并行工具结果（合并为一条 user 消息）                   │
  │ role: "user"                                                     │
  │ 注意：tool_result 被提前到消息头部(hoist)                         │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_03AaBbCcDdEeFf",
        "content": "/home/user/project/src/errors.ts:5:export class AuthenticationError extends Error {"
      },
      {
        "type": "tool_result",
        "tool_use_id": "toolu_04GgHhIiJjKkLl",
        "content": "     1|export class AppError extends Error {\n     2|  constructor(message: string, public code: number) { super(message) }\n     3|}\n     4|\n     5|export class AuthenticationError extends Error {\n     6|  constructor(message: string) { super(message); this.name = 'AuthenticationError' }\n     7|}"
      }
    ]
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 9: Assistant 完成修复                                     │
  │ role: "assistant"                                                │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_05MmNnOoPpQqRr",
        "name": "StrReplace",
        "input": {
          "path": "/home/user/project/src/auth.ts",
          "old_string": "import { verify } from 'jsonwebtoken'",
          "new_string": "import { verify } from 'jsonwebtoken'\nimport { AuthenticationError } from './errors'"
        }
      }
    ]
  },
  └─────────────────────────────────────────────────────────────────┘

  ┌─────────────────────────────────────────────────────────────────┐
  │ Message 10: 最终工具结果（带 cache_control 标记）                  │
  │ role: "user"                                                     │
  ├─────────────────────────────────────────────────────────────────┤
  {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_05MmNnOoPpQqRr",
        "content": "Successfully replaced text in /home/user/project/src/auth.ts",
        "cache_control": { "type": "ephemeral" }
      }
    ]
  }
  └─────────────────────────────────────────────────────────────────┘
]
```

---

## 四、`tools` 字段 — 工具定义完整布局

工具定义是**独立的顶层字段**，不嵌入 system 或 messages。每次请求发送全部可用工具的完整 schema。

```json
[
  ┌─────────────────────────────────────────────────────────────────┐
  │ 标准工具（按名称字母序排列，保证缓存稳定）                        │
  └─────────────────────────────────────────────────────────────────┘
  {
    "name": "Glob",
    "description": "Tool to search for files matching a glob pattern\n\n- Works fast with codebases of any size\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns...",
    "input_schema": {
      "type": "object",
      "properties": {
        "glob_pattern": {
          "type": "string",
          "description": "The glob pattern to match files against..."
        }
      },
      "required": ["glob_pattern"]
    },
    "cache_control": { "type": "ephemeral", "scope": "global" }
  },
  {
    "name": "Grep",
    "description": "A powerful search tool built on ripgrep...",
    "input_schema": {
      "type": "object",
      "properties": {
        "pattern": { "type": "string", "description": "The regex pattern..." },
        "path": { "type": "string", "description": "File or directory..." },
        "glob": { "type": "string", "description": "Glob filter..." },
        "output_mode": {
          "type": "string",
          "enum": ["content", "files_with_matches", "count"],
          "description": "Output mode..."
        }
      },
      "required": ["pattern"]
    }
  },
  {
    "name": "Read",
    "description": "Reads a file from the local filesystem...",
    "input_schema": {
      "type": "object",
      "properties": {
        "file_path": { "type": "string", "description": "Absolute path..." },
        "offset": { "type": "integer", "description": "Line offset..." },
        "limit": { "type": "integer", "description": "Number of lines..." }
      },
      "required": ["file_path"]
    }
  },
  {
    "name": "Shell",
    "description": "Executes a given command in a shell session...",
    "input_schema": {
      "type": "object",
      "properties": {
        "command": { "type": "string", "description": "The command to execute" },
        "working_directory": { "type": "string", "description": "..." },
        "description": { "type": "string", "description": "..." },
        "block_until_ms": { "type": "number", "description": "..." }
      },
      "required": ["command"]
    }
  },
  {
    "name": "StrReplace",
    "description": "Performs exact string replacements in files...",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "Absolute path..." },
        "old_string": { "type": "string", "description": "Text to replace" },
        "new_string": { "type": "string", "description": "Replacement text" },
        "replace_all": { "type": "boolean", "description": "Replace all..." }
      },
      "required": ["path", "old_string", "new_string"]
    }
  },
  {
    "name": "Write",
    "description": "Writes a file to the local filesystem...",
    "input_schema": {
      "type": "object",
      "properties": {
        "file_path": { "type": "string", "description": "..." },
        "content": { "type": "string", "description": "..." }
      },
      "required": ["file_path", "content"]
    }
  },

  ┌─────────────────────────────────────────────────────────────────┐
  │ 延迟加载工具 (Tool Search 模式下)                                 │
  └─────────────────────────────────────────────────────────────────┘
  {
    "name": "Notebook",
    "description": "Edit Jupyter notebooks...",
    "input_schema": { ... },
    "defer_loading": true
  },

  ┌─────────────────────────────────────────────────────────────────┐
  │ MCP 工具                                                         │
  └─────────────────────────────────────────────────────────────────┘
  {
    "name": "mcp__cursor-app-control__move_agent_to_root",
    "description": "Move the current agent to a new workspace root...",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "..." }
      },
      "required": ["path"]
    }
  },

  ┌─────────────────────────────────────────────────────────────────┐
  │ 服务端工具（特殊类型）                                            │
  └─────────────────────────────────────────────────────────────────┘
  {
    "type": "web_search_20250305",
    "name": "web_search",
    "max_uses": 5
  }
]
```

---

## 五、特殊内容块类型详解

### 5.1 工具结果的各种形态

#### 正常文本结果

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": "命令输出或文件内容..."
}
```

#### 错误结果

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": "<tool_use_error>InputValidationError: file_path is required</tool_use_error>",
  "is_error": true
}
```

#### 图片结果（Read 图片文件）

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": [
    {
      "type": "image",
      "source": {
        "type": "base64",
        "media_type": "image/png",
        "data": "iVBORw0KGgo..."
      }
    }
  ]
}
```

#### 大结果（持久化到磁盘）

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": "<persisted-output>\nOutput too large (125.3 KB). Full output saved to: /tmp/.claude/tool-results/abc123.txt\n\nPreview (first 2.0 KB):\nimport { something } from 'somewhere'\n...\n</persisted-output>"
}
```

#### Tool Search 发现结果

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": [
    { "type": "tool_reference", "tool_name": "Notebook" },
    { "type": "tool_reference", "tool_name": "mcp__server__tool" }
  ]
}
```

#### 被 Microcompact 清除的旧结果

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": "[Old tool result content cleared]"
}
```

#### 带缓存引用的结果（Cached Microcompact）

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_xxx",
  "content": "文件内容...",
  "cache_reference": "ref_abc123"
}
```

### 5.2 附件注入的形态

附件转化为 user 消息中的 text block：

```json
{
  "type": "text",
  "text": "<diagnostics>\n/src/auth.ts:8:11 - error TS2304: Cannot find name 'AuthenticationError'.\n</diagnostics>"
}
```

```json
{
  "type": "text",
  "text": "The user has the following file open in their IDE, which may or may not be relevant:\n\n/home/user/project/src/auth.ts (lines 1-50)\n```\nimport {...}\n...\n```"
}
```

### 5.3 Thinking Block（扩展思维）

```json
{
  "type": "thinking",
  "thinking": "这是模型的内部推理过程，用户不可见但会在 API 消息历史中保留...",
  "signature": "ErUBCkYYAiJAy1GH..."
}
```

```json
{
  "type": "redacted_thinking",
  "data": "base64编码的隐藏推理..."
}
```

### 5.4 Cache Edits Block（缓存编辑）

```json
{
  "type": "cache_edits",
  "edits": [
    { "type": "delete", "cache_reference": "ref_abc123" },
    { "type": "delete", "cache_reference": "ref_def456" }
  ]
}
```

---

## 六、消息合并规则

### 6.1 连续 User 消息合并

内部可能产生多条 user 消息（工具结果 + 附件 + 用户输入），API 要求交替，所以合并：

```
内部:
  UserMessage(tool_result A)
  UserMessage(tool_result B)
  UserMessage(diagnostics attachment)

合并后 API:
  {
    "role": "user",
    "content": [
      { "type": "tool_result", "tool_use_id": "A", "content": "..." },  ← tool_result 提前
      { "type": "tool_result", "tool_use_id": "B", "content": "..." },  ← tool_result 提前
      { "type": "text", "text": "<diagnostics>...</diagnostics>" }       ← 其他 block 在后
    ]
  }
```

### 6.2 Assistant 流式分片合并

流式响应中，同一 `message.id` 的多个内容块被合并为单条 assistant 消息：

```
流式接收:
  content_block_start(thinking) → thinking_delta → content_block_stop
  content_block_start(text) → text_delta → content_block_stop
  content_block_start(tool_use) → input_json_delta → content_block_stop

合并后:
  {
    "role": "assistant",
    "content": [thinking_block, text_block, tool_use_block]
  }
```

---

## 七、工具配对修复 (ensureToolResultPairing)

在发送前执行修复：

| 情况 | 修复 |
|------|------|
| `tool_use` 没有对应 `tool_result` | 插入合成错误: `"Error: tool result not found"` |
| `tool_result` 没有对应 `tool_use` | 静默移除该 block |
| 重复的 `tool_use` ID | 保留第一个，移除后续 |
| 不完整的 `server_tool_use` | 移除（未完成的服务端工具） |

---

## 八、完整请求生命周期（代码路径）

```
用户输入
  │
  ▼
processUserInput()
  ├─ 解析 slash 命令、@mentions、图片
  ├─ getAttachments() → 诊断、IDE 选择、打开文件
  └─ 产出: UserMessage + AttachmentMessage[]
  │
  ▼
query() → queryLoop()  [src/query.ts]
  │
  │ ══ 上下文压缩管线 ══
  ├─① applyToolResultBudget()      单轮并行结果 ≤ 200k 字符
  ├─② snipCompactIfNeeded()        历史前缀裁剪
  ├─③ microcompact()               旧工具结果清除
  ├─④ contextCollapse()            早期上下文折叠为摘要
  ├─⑤ autocompact()                接近窗口限制 → 全文摘要
  ├─⑥ isAtBlockingLimit?           硬限制检查
  │
  │ ══ 上下文注入 ══
  ├─ appendSystemContext(systemPrompt, gitStatus)
  ├─ prependUserContext(messages, claudeMd + date)
  │
  ▼
queryModel()  [src/services/api/claude.ts]
  │
  │ ══ System 组装 ══
  ├─ [attribution + CLI prefix + base sections + dynamic sections]
  ├─ buildSystemPromptBlocks() → TextBlockParam[] (带 cache_control)
  │
  │ ══ Messages 标准化 ══
  ├─ normalizeMessagesForAPI()
  │   ├─ 丢弃 progress/system/virtual
  │   ├─ attachment → user content
  │   ├─ 合并连续 user (hoist tool_results)
  │   ├─ 合并同 message.id 的 assistant 块
  │   └─ 标准化 tool_use input
  ├─ ensureToolResultPairing()
  ├─ addCacheBreakpoints() → 最后一条 +cache_control
  │
  │ ══ Tools 构建 ══
  ├─ filteredTools.map(toolToAPISchema)
  ├─ + extraToolSchemas (advisor 等)
  │
  ▼
anthropic.beta.messages.create({
  model, max_tokens, stream: true,
  system,    ← TextBlockParam[]
  messages,  ← MessageParam[]
  tools,     ← BetaToolUnion[]
  thinking, betas, metadata, ...
})
  │
  ▼
流式响应 → 解析 content blocks → 执行 tool_use → 产生 tool_result → 循环
```

---

## 九、关键设计总结

| 设计决策 | 说明 |
|---------|------|
| 工具不是独立角色 | `tool_use` 在 assistant 中，`tool_result` 在 user 中 |
| System 是数组不是字符串 | 支持分段缓存控制 |
| CLAUDE.md 在 messages 中 | 作为第一条 meta user 消息注入，不在 system 里 |
| 每轮重新处理全部历史 | 压缩 + 标准化 + 配对修复 |
| 工具按名称排序 | 保证 prompt cache 稳定性 |
| 连续 user 消息合并 | Bedrock 兼容 + API 要求交替 |
| tool_result 提前到头部 | 合并时 hoist 到 content 数组前面 |
| 大结果持久化 | 超 50k 字符 → 磁盘 + 预览 |
| thinking 保留在历史中 | 供后续轮次使用，但不设 cache_control |

---

## 相关文档

- [消息组装与发送流程深度分析](./message-assembly-analysis.md) — 完整的处理管线代码级分析
- [工具调用格式详解](./tool-call-format-analysis.md) — tool_use/tool_result 的完整数据流
- [Prompt Cache 架构分析](./prompt-cache-architecture-analysis.md) — 缓存策略的完整实现
- [Microcompact 架构分析](./microcompact-architecture-analysis.md) — 工具结果压缩机制
- [Context Collapse 架构分析](./context-collapse-architecture-analysis.md) — 上下文折叠机制
