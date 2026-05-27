# Claude Code argv0 多工具派发架构分析

> 分析 Claude Code 如何将 ripgrep、bfs、ugrep 静态编译进单体 bun 二进制，并通过 argv[0] 派发机制实现零依赖的高性能文件搜索。

---

## 核心结论

Claude Code 采用了类似 **BusyBox** 的多命令派发模式：将 ripgrep、bfs（breadth-first search）、ugrep 静态编译进 bun 二进制，运行时通过 `argv[0]` 值决定执行哪个工具。这种架构实现了**零外部依赖、零 PATH 解析、零首次启动代码签名开销**的文件搜索能力。

---

## 一、架构全景

```
┌───────────────── bun 编译的单体二进制 ──────────────────┐
│                                                        │
│   Claude Code 主程序（argv[0] = "claude"）               │
│         │                                              │
│         ├─── spawn(self, args, { argv0: "rg" })        │
│         │      → 内嵌 ripgrep 引擎启动                   │
│         │                                              │
│         ├─── spawn(self, args, { argv0: "bfs" })       │
│         │      → 内嵌 bfs 引擎启动                       │
│         │                                              │
│         └─── spawn(self, args, { argv0: "ugrep" })     │
│                → 内嵌 ugrep 引擎启动                     │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 嵌入的三个工具

| 工具 | 用途 | 替代的系统命令 | 替代的专用工具 |
|------|------|--------------|-------------|
| **ripgrep** | 文本内容搜索 + 文件列举 | `rg`（条件替代） | 无（共存） |
| **bfs** | 文件查找 | `find`（无条件替代） | GlobTool |
| **ugrep** | 通用文本搜索 | `grep`（无条件替代） | GrepTool |

---

## 二、派发机制的三层实现

### 2.1 层1：构建时嵌入

在 `scripts/build-with-plugins.ts`（仅 ant-native 构建）中，三个 Rust 工具被静态编译进 bun 二进制。bun 的编译器在链接阶段将这些工具的入口函数注册到 argv0 派发表中。

运行时检测嵌入状态：

```typescript
// src/utils/bundledMode.ts
export function isInBundledMode(): boolean {
  return (
    typeof Bun !== 'undefined' &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  )
}

// src/utils/embeddedTools.ts — bfs/ugrep 可用性（ant-native only）
export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  // SDK/agent 模式下不启用，避免 shell 函数干扰 API 调用
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}
```

两个检测函数的覆盖范围不同：
- `isInBundledMode()` — ripgrep 始终内嵌于所有 bun 编译构建
- `hasEmbeddedSearchTools()` — bfs/ugrep 仅在 ant-native 构建且非 SDK 模式下可用

### 2.2 层2：Node.js API 调用

通过 `child_process.spawn()` 的 `argv0` 选项直接设置子进程的 `argv[0]`：

```typescript
// src/utils/ripgrep.ts — embedded 模式配置
if (isInBundledMode()) {
  return {
    mode: 'embedded',
    command: process.execPath,  // bun 可执行文件自身
    args: ['--no-config'],
    argv0: 'rg',               // 告诉 bun "你现在是 ripgrep"
  }
}

// 调用时必须用 spawn（execFile 不支持 argv0）
const child = spawn(rgPath, fullArgs, {
  argv0,
  signal: abortSignal,
  windowsHide: true,
})
```

为什么不用 `execFile`：Node.js 的 `execFile` API 不支持 `argv0` 选项，只有 `spawn` 支持。这是 embedded 模式的代码分支：

```typescript
// ripGrepRaw() 中的两条路径
if (argv0) {
  // embedded: 必须用 spawn
  const child = spawn(rgPath, fullArgs, { argv0, ... })
} else {
  // system/builtin: 可以用 execFile
  return execFile(rgPath, fullArgs, { ... }, callback)
}
```

### 2.3 层3：Shell 函数封装

在 Claude 的 bash/zsh 环境中，通过 shell 函数实现 argv0 设置，使用户在 BashTool 中输入 `rg`/`find`/`grep` 时自动路由到嵌入版本。

#### shell 函数生成器

```typescript
// src/utils/bash/ShellSnapshot.ts
function createArgv0ShellFunction(
  funcName: string,    // "rg" / "find" / "grep"
  argv0: string,       // "rg" / "bfs" / "ugrep"
  binaryPath: string,  // process.execPath
  prependArgs: string[] = [],
): string
```

生成的 shell 函数针对不同环境选择最佳的 argv0 设置方式：

```bash
function rg {
  if [[ -n $ZSH_VERSION ]]; then
    ARGV0=rg /path/to/bun "$@"                    # zsh: ARGV0 环境变量
  elif [[ "$OSTYPE" == "msys" ]] || ...; then
    ARGV0=rg /path/to/bun "$@"                    # Windows: ARGV0 环境变量
  elif [[ $BASHPID != $$ ]]; then
    exec -a rg /path/to/bun "$@"                  # bash 子 shell: exec -a
  else
    (exec -a rg /path/to/bun "$@")                # bash 主 shell: 子 shell 包裹
  fi
}
```

#### 跨平台 argv0 设置方式

| Shell 环境 | 方式 | 原理 |
|-----------|------|------|
| **Zsh** | `ARGV0=rg binary` | Zsh 原生支持 ARGV0 环境变量设置 argv[0] |
| **Bash 子 shell** | `exec -a rg binary` | `exec -a` 是 POSIX 标准的 argv[0] 设置方式 |
| **Bash 主 shell** | `(exec -a rg binary)` | 额外用 `()` 包裹，防止 exec 替换当前 shell 进程 |
| **Windows (Git Bash)** | `ARGV0=rg binary` | Bun 原生读取 ARGV0 环境变量 |

`$BASHPID != $$` 的检测是为了区分主 shell 和子 shell：在子 shell 中 `exec` 是安全的（替换的是子 shell），而在主 shell 中 `exec` 会替换整个 shell 进程，导致终端关闭。

#### 防 alias 绕过

macOS 上 Homebrew 用户常有 `alias find=gfind` 或 `alias grep=ggrep`。bash 在函数查找之前展开 alias，会导致 shell 函数被绕过：

```bash
# 在函数定义之前清除可能的冲突 alias
unalias find 2>/dev/null || true
unalias grep 2>/dev/null || true
unalias rg 2>/dev/null || true
```

---

## 三、三套工具的激活策略差异

### 3.1 ripgrep — 条件激活

ripgrep 的 shell 函数**仅在系统没有 rg 命令时**才生效：

```bash
# ShellSnapshot 生成的内容
if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then
  function rg {
    # ... 调用嵌入 rg ...
  }
fi
```

原因：用户可能安装了特定版本的 ripgrep 并有自定义配置（`~/.ripgreprc`），嵌入版本使用 `--no-config` 会忽略这些配置。

但在 API 层面（GlobTool/GrepTool 内部），嵌入 ripgrep 始终优先，不受 shell 函数的影响。

### 3.2 bfs/ugrep — 无条件激活

bfs 和 ugrep **始终覆盖**系统的 find 和 grep，没有条件判断：

```typescript
// 无条件覆盖 — 没有 "if ! command -v find" 包裹
createArgv0ShellFunction('find', 'bfs', binaryPath, [...])
createArgv0ShellFunction('grep', 'ugrep', binaryPath, [...])
```

原因：
1. bfs/ugrep 是 find/grep 的 **drop-in 替代品**，行为完全兼容
2. 性能一致且更好，不存在"用户可能更喜欢系统版本"的场景
3. 需要保证 Claude 的 shell 中 find/grep 总是快速版本

### 3.3 工具注册表联动

当 bfs/ugrep 可用时，GlobTool 和 GrepTool 从注册表中移除，避免功能重复：

```typescript
// src/tools.ts
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    // ...
  ]
}
```

同时，prompt 中引导 agent 使用 find/grep 代替 GlobTool/GrepTool：

```typescript
// src/tools/AgentTool/prompt.ts
const fileSearchHint = embedded
  ? '`find` (via Bash)'      // ant-native: 引导用 find
  : `${GLOB_TOOL_NAME}`      // 标准: 引导用 GlobTool
```

---

## 四、为什么嵌入派发更快

### 4.1 消除 PATH 解析开销

**传统方式（system 模式）**：
```
调用 rg → findExecutable('rg') → whichSync('rg') → 遍历 PATH 目录查找 → 找到路径 → exec
```

**嵌入方式**：
```
调用 rg → process.execPath（已知路径） → spawn
```

`findExecutable` 需要同步遍历 PATH 中的所有目录（通过 `whichSync`），在 PATH 较长的环境（如 NVM/conda/brew 叠加）中可能包含 10-20 个目录的文件系统查找。嵌入模式**跳过了全部 PATH 解析**。

### 4.2 消除代码签名开销（macOS）

**builtin 模式（macOS）** 需要在首次使用时执行代码签名：

```typescript
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin') return
  // 检查是否已签名（执行 codesign -vv -d）
  // 如果是 linker-signed → 重新签名（执行 codesign --sign -）
  // 移除 quarantine 属性（执行 xattr -d com.apple.quarantine）
}
```

这涉及 3 次外部命令调用（`codesign` × 2 + `xattr`）。**embedded 模式完全跳过**，因为代码签名只对 `builtin` 模式的独立 vendor 二进制生效：

```typescript
async function codesignRipgrepIfNecessary() {
  // ...
  const config = getRipgrepConfig()
  if (config.mode !== 'builtin') {
    return  // embedded 和 system 模式直接返回
  }
  // ...
}
```

### 4.3 页缓存优势

操作系统的页缓存（page cache）机制使嵌入模式获得天然加速：

```
embedded 模式:
  bun 二进制已在内存中运行 → spawn(self) → OS 直接复用页缓存中的代码页
  → 近乎零 I/O 的进程创建

system/builtin 模式:
  外部 rg 二进制在磁盘上 → exec(rg) → OS 可能需要从磁盘读取
  → 首次调用有冷启动 I/O 开销
```

关键：当 `spawn(process.execPath, ...)` 时，OS 发现要执行的二进制与当前进程的二进制**完全相同**，其代码段（text segment）已在页缓存中，可以直接映射到新进程的地址空间，**无需任何磁盘 I/O**。

### 4.4 消除动态链接开销

嵌入工具被**静态编译**进 bun 二进制，没有动态链接库依赖：

```
embedded 模式:
  单体二进制 → 直接跳转到 rg 入口 → 无动态链接器开销

外部二进制:
  rg → ld.so → 加载 libm.so, libpthread.so, libc.so → 符号解析 → 重定位 → 执行
```

在 Linux 上，动态链接器（ld.so）的启动开销约 1-3ms，对于频繁调用的搜索操作可累积显著。

### 4.5 消除首次使用测试开销

system/builtin 模式在首次使用时会触发可用性测试：

```typescript
const testRipgrepOnFirstUse = memoize(async (): Promise<void> => {
  // 执行 rg --version 验证可用性
  // embedded 模式用 Bun.spawn，其他用 execFileNoThrow
  // 记录遥测数据
})
```

这是一个额外的进程创建和销毁周期。虽然结果被 memoize 缓存，但首次调用仍有额外开销。

### 4.6 性能对比总结

| 开销项 | embedded | system | builtin |
|--------|:--------:|:------:|:-------:|
| PATH 解析 | ❌ 无 | ✅ whichSync | ❌ 无 |
| 代码签名 (macOS) | ❌ 无 | ❌ 无 | ✅ 最多 3 次外部命令 |
| 页缓存命中率 | 极高（同一二进制） | 取决于使用频率 | 取决于使用频率 |
| 动态链接 | ❌ 无 | 取决于构建方式 | ❌ 无（预编译） |
| spawn 方式 | spawn（支持 argv0） | execFile | execFile |
| 首次测试 | ✅ 有 | ✅ 有 | ✅ 有 |

**实际测量的性能差异**主要体现在：
- **首次调用**：embedded 比 builtin（macOS）快约 50-200ms（省去代码签名）
- **每次调用**：embedded 比 system 快约 1-5ms（省去 PATH 解析和动态链接）
- **搜索本身**：三种模式使用相同的 ripgrep 搜索引擎，**搜索速度完全相同**

---

## 五、bfs/ugrep 的兼容性调优

### 5.1 find → bfs 的注入参数

```typescript
createArgv0ShellFunction('find', 'bfs', binaryPath, [
  '-regextype', 'findutils-default',
])
```

| 注入参数 | 原因 |
|---------|------|
| `-regextype findutils-default` | bfs 默认 POSIX BRE 正则；GNU find 默认 emacs-flavor 正则（支持 `\|`）；不注入此参数会导致 `find . -regex '.*\.\(js\|ts\)'` 返回空结果 |

**已知兼容性问题**：Oniguruma（bfs 的正则引擎）使用 leftmost-first 交替匹配，而 GNU find 使用 POSIX leftmost-longest。当一个选项是另一个的前缀时（如 `\(ts\|tsx\)`），bfs 可能漏匹配。解决方法：把长选项放前面 `\(tsx\|ts\)`。

### 5.2 grep → ugrep 的注入参数

```typescript
createArgv0ShellFunction('grep', 'ugrep', binaryPath, [
  '-G',
  '--ignore-files',
  '--hidden',
  '-I',
  ...VCS_DIRECTORIES_TO_EXCLUDE.map(d => `--exclude-dir=${d}`),
])
```

| 注入参数 | 原因 | 对标 GrepTool 行为 |
|---------|------|-------------------|
| `-G` | 强制 BRE 模式（ugrep 默认 ERE），使 `\|` 为交替语法 | GNU grep 默认行为 |
| `--ignore-files` | respect .gitignore | rg 的默认行为 |
| `--hidden` | 包含隐藏文件 | GrepTool 传 `--hidden` 给 rg |
| `-I` | 跳过二进制文件 | rg 默认跳过 |
| `--exclude-dir=.git` 等 | 排除 VCS 目录 | GrepTool 传 `--glob '!.git'` |

### 5.3 未复制的 GrepTool 行为

| GrepTool 特性 | 未复制原因 |
|-------------|----------|
| `--max-columns 500` | ugrep 的 `--width` 会硬截断输出，可能破坏管道操作 |
| 读取拒绝规则 / 插件缓存排除 | 需要 toolPermissionContext，Shell snapshot 创建时不可用 |

---

## 六、沙盒环境集成

sandbox-adapter 也传递 argv0 配置，确保沙盒内的 ripgrep 调用使用正确的嵌入版本：

```typescript
// src/utils/sandbox/sandbox-adapter.ts
const { rgPath, rgArgs, argv0 } = ripgrepCommand()
const ripgrepConfig = settings.sandbox?.ripgrep ?? {
  command: rgPath,
  args: rgArgs,
  argv0,  // 传递给 sandbox-runtime
}
```

---

## 七、安全考量

### 7.1 防 PATH 劫持

system 模式使用命令名 `'rg'` 而非 `findExecutable` 返回的完整路径：

```typescript
if (userWantsSystemRipgrep) {
  const { cmd: systemPath } = findExecutable('rg', [])
  if (systemPath !== 'rg') {
    // SECURITY: Use command name 'rg' instead of systemPath
    // to prevent PATH hijacking (malicious ./rg.exe)
    return { mode: 'system', command: 'rg', args: [] }
  }
}
```

embedded 模式天然免疫 PATH 劫持：`command` 是 `process.execPath`（当前进程的绝对路径），不经过 PATH 解析。

### 7.2 Windows 安全

在 Windows 上，如果使用 `systemPath`（如 `./rg.exe`），当前目录下的恶意 `rg.exe` 可能被执行。使用命令名 `'rg'` 配合 Windows 的 `NoDefaultCurrentDirectoryInExePath` 保护可以避免此问题。

---

## 涉及源文件

| 文件 | 角色 |
|------|------|
| `src/utils/ripgrep.ts` | ripgrep 三种模式配置、调用封装、代码签名 |
| `src/utils/bundledMode.ts` | 检测是否为 Bun 编译的独立可执行文件 |
| `src/utils/embeddedTools.ts` | 检测 bfs/ugrep 嵌入可用性 |
| `src/utils/bash/ShellSnapshot.ts` | argv0 shell 函数生成器、rg/find/grep 集成 |
| `src/utils/findExecutable.ts` | PATH 解析（whichSync 封装） |
| `src/utils/sandbox/sandbox-adapter.ts` | 沙盒环境的 ripgrep 配置传递 |
| `src/tools.ts` | 工具注册表（根据嵌入状态移除 Glob/Grep） |
| `src/tools/AgentTool/prompt.ts` | Prompt 引导（嵌入时指向 find/grep） |
| `src/tools/BashTool/prompt.ts` | BashTool prompt（嵌入时不抑制 find/grep） |
| `src/constants/prompts.ts` | 系统 prompt（嵌入时跳过 Glob/Grep 指引） |
