# Claude Code EXE 二进制架构分析

## 概述

从 v2.1.148 开始，Claude Code 的 npm 包不再分发 `cli.js`（纯 JavaScript 文件），而是转为分发**平台特定的原生二进制文件（`.exe`）**。该二进制文件由 **Bun 运行时**通过 `bun build --compile --bytecode` 命令编译生成，将 Bun 运行时引擎和应用代码打包为单一可执行文件。

## 版本变迁

| 版本 | 分发形式 | 入口文件 | 大小 | 格式 |
|------|---------|----------|------|------|
| v2.1.112 | `cli.js` | ESM 模块 | 20.1 MB | 压缩后的 JavaScript 源码 |
| v2.1.148 | `claude.exe` | PE32+ 原生二进制 | 222 MB | Bun 单可执行文件 (SEA) |

## npm 包结构

```
@anthropic-ai/claude-code/
├── bin/
│   └── claude.exe              # 最终执行的二进制（硬链接或复制自平台包）
├── cli-wrapper.cjs             # Node.js 回退启动器
├── install.cjs                 # postinstall 脚本
├── package.json                # 主包清单
├── sdk-tools.d.ts              # SDK 类型定义
├── LICENSE.md
├── README.md
└── node_modules/
    └── @anthropic-ai/
        └── claude-code-win32-x64/   # 平台特定的原生二进制包
            ├── claude.exe           # 源二进制
            ├── package.json
            ├── LICENSE.md
            └── README.md
```

## 安装流程

### 1. npm install 阶段

`package.json` 定义了 8 个平台的 `optionalDependencies`：

```json
{
  "optionalDependencies": {
    "@anthropic-ai/claude-code-darwin-arm64": "2.1.148",
    "@anthropic-ai/claude-code-darwin-x64": "2.1.148",
    "@anthropic-ai/claude-code-linux-x64": "2.1.148",
    "@anthropic-ai/claude-code-linux-arm64": "2.1.148",
    "@anthropic-ai/claude-code-linux-x64-musl": "2.1.148",
    "@anthropic-ai/claude-code-linux-arm64-musl": "2.1.148",
    "@anthropic-ai/claude-code-win32-x64": "2.1.148",
    "@anthropic-ai/claude-code-win32-arm64": "2.1.148"
  }
}
```

npm 根据当前平台的 `os` 和 `cpu` 字段自动仅安装匹配的平台包。

### 2. postinstall 阶段（install.cjs）

`install.cjs` 作为 postinstall 脚本执行，核心逻辑：

1. **平台检测**：通过 `process.platform` + `os.arch()` 确定平台键（如 `win32-x64`）
2. **Musl 检测**（Linux）：利用 `process.report.getReport()` 检查 `glibcVersionRuntime` 是否存在
3. **Rosetta 2 检测**（macOS）：调用 `sysctl -n sysctl.proc_translated` 判断是否在 Rosetta 下运行 x64 Node
4. **二进制放置**：将平台包中的 `claude.exe` 通过**硬链接**（优先）或**文件复制**（跨设备回退）放到 `bin/claude.exe`

放置策略的优先级链：
```
hardlink → (EEXIST) unlink + hardlink → copy → (全部失败) 恢复原 stub
          (EXDEV/EPERM) → copy
```

### 3. 回退机制（cli-wrapper.cjs）

当 postinstall 未运行（如 `--ignore-scripts`）时，`cli-wrapper.cjs` 可手动调用：

```bash
node cli-wrapper.cjs [args...]
```

它会通过 `require.resolve` 找到平台包中的二进制并 `spawnSync` 执行，代价是多一个 Node.js 进程的开销。

## 二进制文件分析

### PE 结构

```
格式: PE32+ (64-bit)
Machine: x86-64 (0x8664)
大小: 232,827,552 bytes (222.0 MB)
```

### PE 段表

| 段名 | 虚拟大小 | 原始大小 | 说明 |
|------|---------|---------|------|
| `.text` | 63 MB | 63 MB | Bun 运行时的原生代码（C++/Zig 编译） |
| `.rdata` | 38.8 MB | 38.8 MB | 只读数据（字符串常量、运行时数据表） |
| `.data` | 3.1 MB | 191 KB | 初始化的全局变量 |
| `.pdata` | 1 MB | 1 MB | 异常处理信息 |
| `.fptable` | 256 B | 512 B | 函数指针表 |
| `.tls` | 72.8 KB | 73.2 KB | 线程本地存储 |
| `_RDATA` | 500 B | 512 B | 附加只读数据 |
| `__DATA,_` | 16 KB × 2 | 16 KB × 2 | Bun 自定义数据段 |
| `.rsrc` | 199.9 KB | 200 KB | Windows 资源 |
| `.reloc` | 214.9 KB | 215 KB | 重定位表 |
| **`.bun`** | **129.2 MB** | **129.2 MB** | **Bun 应用容器（核心！）** |

### `.bun` 段布局

`.bun` 段是 Bun 的自定义容器格式，包含打包后的 JavaScript 应用：

```
偏移 0:           容器头 (8 bytes, 值 = 容器数据大小)
偏移 0~106.8MB:   Bun 运行时数据 + 预编译资源表
                  (包含模块路径索引、字符串常量池、JSC 字节码缓存等)
偏移 106.8MB:     字节码模块 1 - cli.js (14.5 MB)
偏移 121.3MB:     字节码模块 2 - image-processor.js (2 KB)
偏移 121.3MB:     字节码模块 3 - audio-capture.js (1.5 MB)
偏移 ~123.2MB:    容器尾部 + "---- Bun! ----" 签名
```

### 字节码模块格式

每个模块的格式：

```
[模块路径 (两次)]                       "B:/~BUN/root/src/entrypoints/cli.js"
[格式标记]                               "// @bun @bytecode @bun-cjs"
[CJS 包装器]                             "(function(exports, require, module, __filename, __dirname) {"
[许可声明]                               "// Claude Code is a Beta product..."
[压缩后的 JavaScript 源码]               "var uY4=Object.create;..."
[CJS 包装器闭合]                         "})"
```

三个模块：

| 模块 | 路径 | 大小 | 说明 |
|------|------|------|------|
| cli.js | `B:/~BUN/root/src/entrypoints/cli.js` | 14.5 MB | 主入口，包含全部应用逻辑 |
| image-processor.js | `B:/~BUN/root/image-processor.js` | 2 KB | 图像处理 Worker |
| audio-capture.js | `B:/~BUN/root/audio-capture.js` | 1.5 MB | 音频捕获模块 |

### 构建路径泄露

二进制中残留的 CI 构建路径：
```
file:///D:/a/claude-cli-internal/claude-cli-internal/node_modules/...
```

说明在 GitHub Actions（Windows Runner，D:/a/ 是默认工作区）上构建，仓库名为 `claude-cli-internal`。

## 字节码 vs 源码

### `@bun @bytecode` 标记的含义

Bun 的 `--bytecode` 编译选项将 JavaScript 预编译为 **JavaScriptCore (JSC) 字节码**，用于加速启动。然而，分析发现：

- **源码仍然完整嵌入**：cli.js 模块的 15,187,607 字节中，**99.99% 是可读文本**（仅 2 字节为二进制分隔符）
- Bun 的字节码编译会在 `.bun` 段的前半部分（106.8 MB）存储预编译的 JSC 字节码缓存
- 同时在后半部分保留完整的压缩后 JavaScript 源码作为回退和调试支持

### 源码特征

提取的源码与旧版 `cli.js` 具有相同性质的压缩代码：

| 特征 | 旧 cli.js (v2.1.112) | 新 exe 中的 cli.js (v2.1.148) |
|------|---------------------|-------------------------------|
| 模块格式 | ESM (`import/export`) | CJS (`require/exports`) |
| 大小 | 20.1 MB | 14.5 MB (小 28%) |
| 压缩方式 | Minified（短变量名） | Minified（短变量名） |
| 变量命名 | `vP5`, `MP5`, `t07` 等 | `FY4`, `X6$`, `J6$` 等 |
| 共有标识符 | `CLAUDE_CODE`, `anthropic`, `getSystemPrompt` 等 ✓ | 同 ✓ |

新版更小，可能因为：
1. Bun 的打包器（bundler）比之前用的工具（esbuild）更激进地进行了 tree-shaking
2. 模块格式从 ESM 改为 CJS 减少了一些包装代码
3. 部分依赖的字符串数据被移到了字节码缓存区域

## 反编译可行性分析

### 方法 1：直接提取源码（✅ 可行）

**结论：完全可以从 exe 中提取出与旧版 `cli.js` 等价的压缩 JavaScript 源码。**

提取步骤：
1. 读取 exe 文件
2. 定位 `.bun` PE 段（通过段表解析）
3. 搜索 `@bun @bytecode @bun-cjs` 标记
4. 提取标记后的完整文本到模块末尾

```javascript
const fs = require('fs');
const buf = fs.readFileSync('path/to/claude.exe');

// 定位 cli.js 模块（通过搜索路径字符串）
const marker = Buffer.from('B:/~BUN/root/src/entrypoints/cli.js');
const idx = buf.indexOf(marker);

// 找到源码开始位置
const sourceStart = buf.indexOf(Buffer.from('(function(exports'), idx);

// 找到源码结束位置（下一个模块路径之前）
const nextModule = buf.indexOf(Buffer.from('B:/~BUN/root/image-processor.js'), sourceStart);

// 提取
const source = buf.slice(sourceStart, nextModule).toString('utf8').trimEnd();
fs.writeFileSync('extracted_cli.js', source);
```

### 方法 2：反编译 JSC 字节码（⚠️ 理论可行但无实用工具）

`.bun` 段前 106.8 MB 包含 JSC 字节码缓存。理论上可以反编译，但：

- **无公开反编译器**：Bun 使用的 JSC 字节码格式是 WebKit/JavaScriptCore 的内部格式，没有成熟的公开反编译工具
- **无必要**：既然完整源码已经嵌入二进制，反编译字节码没有额外收益
- **字节码版本绑定**：JSC 字节码与 Bun/JSC 版本强绑定，跨版本不兼容

### 方法 3：反混淆压缩代码（⚠️ 有限可行）

提取出的源码是压缩后的单文件代码，可以通过以下工具改善可读性：

1. **Prettier / js-beautify**：格式化缩进和换行
2. **人工分析**：通过字符串常量和 API 调用点还原模块边界
3. **与旧版对比**：利用 v2.1.112 的 cli.js（已有）作为参照

限制：
- 变量名不可逆地丢失（`H`, `q`, `$`, `K` 等单字母名）
- 模块边界在打包时被消除
- 不含 source map

## `.bun` 容器格式总结

```
┌──────────────────────────────────────────────────┐
│  Container Header (8 bytes)                       │
│  value = total container data size                │
├──────────────────────────────────────────────────┤
│                                                    │
│  Bun Runtime Data Region (~106.8 MB)              │
│  - Module path index / string table               │
│  - JSC bytecode cache (pre-compiled)              │
│  - Native addon references                        │
│  - Resource metadata                              │
│                                                    │
├──────────────────────────────────────────────────┤
│                                                    │
│  Bytecode Module 1: cli.js (14.5 MB)             │
│  [path][path][@bun @bytecode @bun-cjs]           │
│  [(function(exports,require,module,...){          │
│     // license header                             │
│     // minified JavaScript source                 │
│  })]                                              │
│                                                    │
├──────────────────────────────────────────────────┤
│  Bytecode Module 2: image-processor.js (2 KB)    │
├──────────────────────────────────────────────────┤
│  Bytecode Module 3: audio-capture.js (1.5 MB)    │
├──────────────────────────────────────────────────┤
│  Footer metadata                                  │
│  "---- Bun! ----\n" signature                     │
│  Padding to section alignment                     │
└──────────────────────────────────────────────────┘
```

## 与旧架构的对比

### 旧架构（v2.1.112 及之前）

```
npm install → 下载 cli.js (20 MB ESM) → Node.js 直接执行
```

- 依赖系统 Node.js 运行时
- 启动慢（需解析 20 MB JavaScript）
- 源码可直接阅读

### 新架构（v2.1.148+）

```
npm install → 下载平台 exe (222 MB) → postinstall 硬链接到 bin/ → 直接执行
```

- 自带 Bun 运行时，不依赖 Node.js
- 启动快（字节码缓存 + 原生执行）
- 源码嵌入在二进制中（可提取但不可直接读取）

### 迁移动机

1. **启动性能**：JSC 字节码缓存消除了 JS 解析开销
2. **运行时一致性**：自带 Bun 运行时，避免用户 Node.js 版本差异
3. **分发简化**：单一二进制，减少依赖问题
4. **代码保护**：虽非目的，但 exe 格式客观上增加了源码访问门槛

## 关键代码引用

### install.cjs - 二进制放置逻辑

核心函数 `placeBinary` 实现硬链接优先、复制回退的策略：

```javascript
// install.cjs 第 101-141 行
function placeBinary(src, dest) {
  try {
    linkSync(src, dest);
  } catch (err) {
    if (err.code === 'EEXIST') {
      const stub = statSync(dest).size < 4096 ? readFileSync(dest) : null;
      unlinkSync(dest);
      try { linkSync(src, dest); }
      catch { 
        try { copyFileSync(src, dest); }
        catch (copyErr) {
          if (stub) { try { writeFileSync(dest, stub, { mode: 0o755 }); } catch {} }
          throw copyErr;
        }
      }
    } else if (err.code === 'EXDEV' || err.code === 'EPERM') {
      copyFileSync(src, dest);
    } else { throw err; }
  }
}
```

### cli-wrapper.cjs - 回退启动器

当 postinstall 未运行时，作为 Node.js 桥接：

```javascript
// cli-wrapper.cjs 第 128-149 行
function main() {
  const binaryPath = getBinaryPath();
  const result = spawnSync(binaryPath, process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_CODE_INSTALLED_VIA_NPM_WRAPPER: '1' },
  });
  // ... 错误处理和退出码传播
}
```

## 总结

1. Claude Code 已从纯 JavaScript 分发迁移到 **Bun 单可执行文件 (SEA)** 分发
2. exe 使用了 `--bytecode` 选项预编译 JSC 字节码以加速启动
3. **完整的压缩 JavaScript 源码仍然嵌入在二进制中**，可以提取
4. 提取的源码与旧版 `cli.js` 同质——都是压缩后的单文件，变量名被混淆
5. 不存在专门的 Bun/JSC 字节码反编译器，但也无需使用——源码直接可提取
