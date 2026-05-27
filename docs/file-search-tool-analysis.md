# Claude Code 文件查找工具链深度分析

> 分析 Claude Code 中文件查找的底层实现选型（ripgrep vs fd）、Glob 工具的架构、以及 fd 在安全白名单中的角色。

---

## 核心结论

Claude Code 的 **GlobTool** 和 **GrepTool** 统一使用 **ripgrep（rg）** 作为底层引擎。`fd` 没有被用作任何内部工具的底层实现，仅在 BashTool 的只读命令白名单中被注册为允许执行的外部命令。

选型理由：**一个已内嵌的工具（ripgrep）能同时完成内容搜索和文件列举两件事，无需引入额外依赖。**

---

## 一、GlobTool 的底层实现

### 1.1 调用链路

```
GlobTool.call()
  → glob()                    // src/utils/glob.ts
    → ripGrep(args, ...)       // src/utils/ripgrep.ts
      → rg --files --glob <pattern> --sort=modified [--no-ignore] [--hidden]
```

GlobTool（`src/tools/GlobTool/GlobTool.ts`）的 `call` 方法调用 `glob()` 函数，后者构造 ripgrep 参数并调用 `ripGrep()`：

```typescript
// src/utils/glob.ts 核心逻辑
const args = [
  '--files',           // 只列举文件，不搜索内容
  '--glob',            // glob 模式过滤
  searchPattern,
  '--sort=modified',   // 按修改时间排序（最旧在前）
  ...(noIgnore ? ['--no-ignore'] : []),
  ...(hidden ? ['--hidden'] : []),
]
const allPaths = await ripGrep(args, searchDir, abortSignal)
```

### 1.2 ripgrep 的三种运行模式

`src/utils/ripgrep.ts` 中 `getRipgrepConfig()` 定义了三种模式：

| 模式 | 条件 | 实现方式 |
|------|------|---------|
| **embedded** | 打包（bundled）模式 | ripgrep 静态编译进 bun-internal，通过 `argv0='rg'` 派发 |
| **system** | 用户设置 `USE_BUILTIN_RIPGREP=false` 且系统有 `rg` | 直接调用系统 `rg` 命令 |
| **builtin** | 非打包模式的回退 | 使用 `vendor/ripgrep/` 下的预编译二进制 |

```typescript
// embedded 模式 — 零进程启动开销
if (isInBundledMode()) {
  return {
    mode: 'embedded',
    command: process.execPath,  // bun 自身
    args: ['--no-config'],
    argv0: 'rg',               // bun 根据 argv0 派发到内嵌 rg
  }
}
```

### 1.3 glob 模式的关键配置

| 参数 | 默认值 | 环境变量控制 |
|------|--------|-------------|
| `--no-ignore` | 开启（不 respect .gitignore） | `CLAUDE_CODE_GLOB_NO_IGNORE=false` 可关闭 |
| `--hidden` | 开启（包含隐藏文件） | `CLAUDE_CODE_GLOB_HIDDEN=false` 可关闭 |
| 超时 | 20s（WSL 60s） | `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS` |
| 结果上限 | 100 条 | 由 `globLimits?.maxResults` 控制 |

### 1.4 绝对路径处理

当输入为绝对路径时，`extractGlobBaseDirectory()` 会分离静态基目录和相对 glob 模式，因为 ripgrep 的 `--glob` 只接受相对模式：

```typescript
// 输入: "/home/user/src/**/*.ts"
// 输出: { baseDir: "/home/user/src", relativePattern: "**/*.ts" }
```

Windows 驱动器根路径（`C:`）也有特殊处理，确保 `C:` 转为 `C:\`（避免"当前驱动器目录"语义）。

---

## 二、fd 在代码中的角色

### 2.1 只读命令白名单注册

`fd` 和 `fdfind`（Debian/Ubuntu 包名）出现在 `src/tools/BashTool/readOnlyValidation.ts` 的 `COMMAND_ALLOWLIST` 中：

```typescript
// fd/fdfind — fast file finder (fd-find). Read-only search tool.
fd: { safeFlags: { ...FD_SAFE_FLAGS } },
fdfind: { safeFlags: { ...FD_SAFE_FLAGS } },
```

这意味着在只读模式下，agent 可以通过 BashTool 执行 `fd` 命令（前提：用户机器上已安装）。

### 2.2 安全限制

`FD_SAFE_FLAGS` 定义了 fd 的安全标志白名单（约 40 个），**以下被故意排除**：

| 被排除的标志 | 原因 |
|-------------|------|
| `-x/--exec` | 对每个搜索结果执行任意命令 |
| `-X/--exec-batch` | 对所有搜索结果批量执行任意命令 |
| `-l/--list-details` | 内部以子进程执行 `ls`，存在 PATH 劫持风险 |

允许的安全标志涵盖：
- 搜索控制：`-H/--hidden`, `-I/--no-ignore`, `-s/-i`（大小写）, `-g/--glob`, `--regex`, `-F/--fixed-strings`
- 过滤：`-d/--max-depth`, `-t/--type`, `-e/--extension`, `-S/--size`, `--changed-within/--changed-before`, `-o/--owner`, `-E/--exclude`
- 输出格式：`-a/--absolute-path`, `-p/--full-path`, `-0/--print0`, `-c/--color`, `--format`, `--strip-cwd-prefix`
- 性能：`-j/--threads`, `--max-results`, `--max-buffer-time`, `-1`, `-q/--quiet`

### 2.3 fd 没有在 prompt 中被推荐

搜索整个 `src/prompts` 目录，没有发现任何对 `fd` 或 `fdfind` 的引用。Agent 不会被主动引导使用 `fd`，它只是一个"被允许执行"的安全命令。

---

## 三、ripgrep vs fd 功能对比

### 3.1 能力矩阵

| 功能 | fd | rg --files | Claude Code 是否需要 |
|------|:--:|:----------:|:---:|
| 文件名 glob 匹配 | ✅ | ✅ `--glob` | ✅ |
| 正则匹配文件名 | ✅ 默认 | ❌ | ❌ |
| 扩展名过滤 | ✅ `-e` | ✅ `--type`/`--glob` | ✅ |
| 隐藏文件 | ✅ `--hidden` | ✅ `--hidden` | ✅ |
| .gitignore 控制 | ✅ `--no-ignore` | ✅ `--no-ignore` | ✅ |
| 深度限制 | ✅ `--max-depth` | ✅ `--max-depth` | ❌ |
| 符号链接跟随 | ✅ `-L` | ✅ `-L` | ❌ |
| 排序输出 | ✅ `--sort` | ✅ `--sort` | ✅ |
| 排除模式 | ✅ `-E` | ✅ `--glob !pat` | ✅ |
| 文件大小过滤 | ✅ `-S` | ❌ | ❌ |
| 修改时间过滤 | ✅ `--changed-within` | ❌ | ❌ |
| 文件所有者过滤 | ✅ `--owner` | ❌ | ❌ |
| 文件系统类型过滤 | ✅ `-t d/f/l` | ❌ | ❌ |
| 执行命令 | ✅ `-x/-X` | ❌ | ❌ |

**结论**：`rg --files` 覆盖了 Glob 工具所需的全部功能。fd 独有的高级过滤能力（大小/时间/类型/所有者）在 Glob 工具场景中不被需要。

### 3.2 性能对比

两者在文件列举场景下**速度几乎相同**，原因：

- **共享同一底层引擎**：ripgrep 和 fd 都使用 Rust 的 `ignore` crate 做目录遍历（该 crate 由 ripgrep 作者 BurntSushi 开发）
- **并行遍历**：两者都使用多线程并行遍历目录树
- **gitignore 处理**：完全相同的实现

`rg --files --glob` 在纯文件列举场景下甚至可能微微快于 `fd`，因为 fd 默认对每个文件名做正则匹配，而 rg 只做 glob 匹配（计算开销更小）。但差异在毫秒级，可忽略。

---

## 四、GrepTool 共享 ripgrep

GrepTool 同样调用 `ripGrep()`，但使用不同参数（搜索内容而非列举文件）。两个工具的关系：

```
GlobTool  → glob()    → ripGrep([--files, --glob, ...])     → rg --files
GrepTool  → ripGrep() → ripGrep([--json, -e <pattern>, ...]) → rg --json
```

共享 ripgrep 带来的好处：
- **统一的错误处理**：EAGAIN 重试、超时控制、macOS 代码签名
- **统一的运行模式**：embedded/system/builtin 三种模式无需各自维护
- **零额外依赖**：不需要用户安装 fd 或其他文件查找工具

---

## 五、性能优化机制

### 5.1 超时与重试

```typescript
// 平台自适应超时
const defaultTimeout = getPlatform() === 'wsl' ? 60_000 : 20_000

// EAGAIN 自动降级到单线程重试
if (!isRetry && isEagainError(stderr)) {
  ripGrepRaw(args, target, abortSignal, callback, true)  // -j 1
}
```

### 5.2 流式计数（大仓库优化）

对于只需要文件数量的场景（遥测），使用 `ripGrepFileCount()` 避免缓冲整个 stdout：

```typescript
// 逐 chunk 计数换行符，峰值内存仅 ~64KB
child.stdout?.on('data', (chunk: Buffer) => {
  lines += countCharInString(chunk, '\n')
})
```

### 5.3 SIGTERM → SIGKILL 升级

ripgrep 可能在不可中断 I/O（深层文件系统遍历）中阻塞，SIGTERM 无法终止：

```typescript
child.kill('SIGTERM')
killTimeoutId = setTimeout(c => c.kill('SIGKILL'), 5_000, child)
```

### 5.4 流式输出（交互优化）

`ripGrepStream()` 函数实现边遍历边输出，首批结果在 rg 仍在遍历时即可呈现（类似 fzf 的 `change:reload` 模式）。

---

## 六、选型总结

| 维度 | 选 ripgrep 的理由 |
|------|------------------|
| **依赖数** | ripgrep 已内嵌，零额外依赖 |
| **跨平台** | embedded 模式随 bun 发布，无需用户安装 |
| **功能覆盖** | `rg --files` 满足 Glob 工具的全部需求 |
| **性能** | 与 fd 共享 `ignore` crate，速度无差异 |
| **维护成本** | 一套错误处理/超时/重试逻辑复用 |
| **安全性** | 统一的安全审计面，不增加攻击面 |

fd 的定位是**可选的用户工具**——如果用户安装了 fd，agent 可以通过 BashTool 在安全白名单内使用它的高级过滤能力（大小/时间/类型过滤），但核心文件查找不依赖它。

---

## 六、argv0 派发机制深度分析

### 6.1 核心原理

Bun 编译的独立可执行文件支持**多身份派发（multi-personality dispatch）**：同一个二进制文件根据 `argv[0]`（进程名）决定执行哪个内嵌工具。

```
bun 二进制文件
├── argv[0] = "claude"  →  运行 Claude Code 主程序
├── argv[0] = "rg"      →  运行内嵌的 ripgrep
├── argv[0] = "bfs"     →  运行内嵌的 bfs（breadth-first search，find 替代品）
└── argv[0] = "ugrep"   →  运行内嵌的 ugrep（通用 grep）
```

### 6.2 实现层次

#### 层1：构建时嵌入

在 `scripts/build-with-plugins.ts` 中（仅 ant-native 构建），ripgrep、bfs、ugrep 被静态编译进 bun 二进制。编译产物是一个包含多个工具的单体可执行文件。

环境变量 `EMBEDDED_SEARCH_TOOLS` 在构建时被设置，运行时通过 `hasEmbeddedSearchTools()` 检测：

```typescript
// src/utils/embeddedTools.ts
export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}
```

SDK/agent 模式下不启用嵌入工具，避免 shell 函数干扰 API 调用。

#### 层2：进程启动时的 argv0 设置

通过 Node.js 的 `child_process.spawn()` 的 `argv0` 选项，可以在创建子进程时将 `argv[0]` 设为任意值：

```typescript
// src/utils/ripgrep.ts — embedded 模式配置
if (isInBundledMode()) {
  return {
    mode: 'embedded',
    command: process.execPath,  // bun 可执行文件自身的路径
    args: ['--no-config'],
    argv0: 'rg',               // 告诉 bun "你现在是 ripgrep"
  }
}
```

调用时：
```typescript
// 使用 spawn 的 argv0 选项（execFile 不支持 argv0）
const child = spawn(rgPath, fullArgs, {
  argv0,                        // 进程名 = "rg"
  signal: abortSignal,
  windowsHide: true,
})
```

#### 层3：Shell 函数封装

在 Claude 的 bash shell 环境中，通过 shell 函数实现 argv0 的设置：

```typescript
// src/utils/bash/ShellSnapshot.ts — createArgv0ShellFunction()
function createArgv0ShellFunction(
  funcName: string,    // "rg" / "find" / "grep"
  argv0: string,       // "rg" / "bfs" / "ugrep"
  binaryPath: string,  // process.execPath (bun 二进制路径)
  prependArgs: string[] = [],
): string {
  // 生成的 shell 函数根据 shell 类型选择不同的 argv0 设置方式
  return [
    `function ${funcName} {`,
    '  if [[ -n $ZSH_VERSION ]]; then',
    `    ARGV0=${argv0} ${quotedPath} ${argSuffix}`,        // zsh: ARGV0 环境变量
    '  elif [[ "$OSTYPE" == "msys" ]] || ...win32...; then',
    `    ARGV0=${argv0} ${quotedPath} ${argSuffix}`,        // Windows: ARGV0 环境变量
    '  elif [[ $BASHPID != $$ ]]; then',
    `    exec -a ${argv0} ${quotedPath} ${argSuffix}`,      // bash 子 shell: exec -a
    '  else',
    `    (exec -a ${argv0} ${quotedPath} ${argSuffix})`,    // bash 主 shell: 子 shell 包裹
    '  fi',
    '}',
  ].join('\n')
}
```

跨平台 argv0 设置方式：

| 环境 | 方式 | 说明 |
|------|------|------|
| Zsh | `ARGV0=rg binary` | Zsh 原生支持 ARGV0 环境变量 |
| Bash 子 shell | `exec -a rg binary` | `exec -a` 直接设置 argv[0] |
| Bash 主 shell | `(exec -a rg binary)` | 用子 shell 包裹避免替换当前 shell |
| Windows (Git Bash) | `ARGV0=rg binary` | Bun 原生读取 ARGV0 环境变量 |

### 6.3 三套嵌入工具的差异策略

| 工具 | 嵌入名 | Shell 函数名 | 激活条件 | 替代的专用工具 |
|------|--------|-------------|---------|--------------|
| ripgrep | `rg` | `rg` | 仅当系统无 `rg` 时 | 无（始终共存） |
| bfs | `bfs` | `find` | **始终激活**（ant-native 构建） | GlobTool |
| ugrep | `ugrep` | `grep` | **始终激活**（ant-native 构建） | GrepTool |

**关键差异**：ripgrep 仅在系统缺失时才通过 shell 函数接管；而 bfs/ugrep **始终覆盖系统的 find/grep**，因为它们是 drop-in 替代品，且性能更好。

```typescript
// ripgrep: 条件激活（仅系统无 rg 时）
content += `
  echo "if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then" >> "$SNAPSHOT_FILE"
  // ... rg 函数定义 ...
  echo "fi" >> "$SNAPSHOT_FILE"
`

// bfs/ugrep: 无条件激活（始终覆盖）
content += `
  echo "# Shadow find/grep with embedded bfs/ugrep" >> "$SNAPSHOT_FILE"
  // ... find/grep 函数定义（无 if 条件）...
`
```

### 6.4 bfs/ugrep 的兼容性调优

当嵌入工具激活时，专用的 GlobTool/GrepTool 被**从工具注册表中移除**：

```typescript
// src/tools.ts
export function getAllBaseTools(): Tools {
  return [
    // ...
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    // ...
  ]
}
```

为保持行为一致性，嵌入工具注入了与 GlobTool/GrepTool 语义匹配的默认参数：

**find (bfs) 的注入参数**：
| 注入参数 | 原因 |
|---------|------|
| `-regextype findutils-default` | bfs 默认 POSIX BRE，GNU find 默认 emacs-flavor；注入此参数使 `\|` 交替模式正常工作 |

**grep (ugrep) 的注入参数**：
| 注入参数 | 原因 |
|---------|------|
| `-G` | 强制 BRE 模式（ugrep 默认 ERE），使 `\|` 为交替而非字面管道 |
| `--ignore-files` | respect .gitignore（匹配 GrepTool 通过 rg 的默认行为） |
| `--hidden` | 包含隐藏文件（匹配 GrepTool 的 `--hidden`） |
| `-I` | 跳过二进制文件（rg 默认跳过，ugrep 不跳过） |
| `--exclude-dir=.git` 等 | 排除 VCS 目录（匹配 GrepTool 的 `--glob '!.git'`） |

### 6.5 防 alias 绕过

用户的 shell 配置可能定义 alias（如 macOS Homebrew 的 `alias find=gfind`），这会绕过 shell 函数。因此在定义函数前先清除相关 alias：

```bash
unalias find 2>/dev/null || true
unalias grep 2>/dev/null || true
```

### 6.6 沙盒集成

sandbox-adapter 也传递 argv0 配置，确保沙盒环境中的 ripgrep 调用正确使用嵌入版本：

```typescript
// src/utils/sandbox/sandbox-adapter.ts
const { rgPath, rgArgs, argv0 } = ripgrepCommand()
const ripgrepConfig = settings.sandbox?.ripgrep ?? {
  command: rgPath,
  args: rgArgs,
  argv0,  // 传递给 sandbox-runtime，使沙盒内也能使用 embedded rg
}
```

---

## 七、架构全景图

```
┌─────────────────────── Claude Code 进程 ───────────────────────┐
│                                                                │
│  ┌─ 专用工具（标准构建）──────────────────────────┐              │
│  │  GlobTool  → glob()  → ripGrep([--files]) ─┐  │              │
│  │  GrepTool  → ripGrep([--json, -e]) ────────┤  │              │
│  └────────────────────────────────────────────┘  │              │
│                                                  ▼              │
│                              ┌─── ripgrep 调用层 ───┐           │
│                              │  embedded: spawn      │           │
│                              │    argv0='rg'         │           │
│                              │  system: execFile     │           │
│                              │    command='rg'       │           │
│                              │  builtin: execFile    │           │
│                              │    vendor/ripgrep/rg  │           │
│                              └───────────────────────┘           │
│                                                                  │
│  ┌─ BashTool Shell 环境 ─────────────────────────────────┐      │
│  │  Shell 函数（embedded 模式）：                          │      │
│  │    rg()   → exec -a rg   $BUN_BINARY  ──── ripgrep    │      │
│  │    find() → exec -a bfs  $BUN_BINARY  ──── bfs        │      │
│  │    grep() → exec -a ugrep $BUN_BINARY ──── ugrep      │      │
│  │                                                        │      │
│  │  只读白名单允许的外部命令：                              │      │
│  │    fd/fdfind ─── 用户需自行安装                          │      │
│  └────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
```

---

## 涉及源文件

| 文件 | 角色 |
|------|------|
| `src/tools/GlobTool/GlobTool.ts` | Glob 工具定义与调用入口 |
| `src/utils/glob.ts` | glob 函数实现，构造 rg 参数 |
| `src/utils/ripgrep.ts` | ripgrep 调用封装（三种模式、超时、重试） |
| `src/utils/bundledMode.ts` | 检测是否为 Bun 编译的独立可执行文件 |
| `src/utils/embeddedTools.ts` | 检测 bfs/ugrep 嵌入可用性 |
| `src/utils/bash/ShellSnapshot.ts` | argv0 shell 函数生成、rg/find/grep 集成 |
| `src/tools/BashTool/readOnlyValidation.ts` | fd/fdfind 只读白名单注册 |
| `src/utils/sandbox/sandbox-adapter.ts` | 沙盒环境的 ripgrep 配置传递 |
| `src/tools.ts` | 工具注册表（根据嵌入状态决定是否注册 Glob/Grep） |
| `src/tools/GlobTool/prompt.ts` | Glob 工具的 prompt 描述 |
