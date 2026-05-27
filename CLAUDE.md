# CLAUDE.md

## 项目说明

本项目用于提取、分析 Claude Code 的源码。源码从 npm 安装的 `@anthropic-ai/claude-code` 包中提取。

## 源码提取流程

从 v2.1.113 起，Claude Code 从纯 JavaScript (`cli.js`) 改为 Bun 单可执行文件 (`claude.exe`) 分发。
exe 中嵌入了完整的压缩 JavaScript 源码，可通过脚本提取。

### 当需要分析最新源码时，按以下步骤执行：

1. **运行提取脚本**，从本地安装的 exe 中提取源码：
   ```
   node extract_from_exe.js
   ```
   脚本会自动：
   - 读取 `%APPDATA%/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`
   - 解析 PE 段表，定位 `.bun` 段中的字节码模块
   - 提取 `cli.js`（主入口）、`image-processor.js`、`audio-capture.js`
   - 从 package.json 检测版本号
   - 使用 Prettier 格式化 cli.js
   - 将 cli.js 按模块边界拆分到 `src/` 子目录（利用 `src/` 参考源码进行路径映射）
   - 输出到 `versions/v<版本号>/` 目录

2. **确认提取结果**在 `versions/` 目录下：
   ```
   versions/
   ├── v2.1.112/
   │   └── cli.js            (旧版 ESM 格式，历史参考)
   └── v2.1.152/
       ├── cli.js            (主入口，格式化后)
       ├── image-processor.js
       ├── audio-capture.js
       └── src/              (拆分后的模块目录)
           ├── utils/
           ├── tools/
           ├── commands/
           ├── components/
           ├── services/
           ├── _unmapped/    (未能映射路径的 CC 模块)
           └── ...
   ```

3. **分析源码**时，优先读取 `src/` 下按路径映射的文件，整体浏览用 `cli.js`。

### 脚本参数

- `node extract_from_exe.js [exe路径]` — 指定 exe 路径（默认自动检测）
- `node extract_from_exe.js --no-format` — 跳过 Prettier 格式化
- `node extract_from_exe.js --no-split` — 跳过模块拆分
- `node extract_from_exe.js --out-dir <dir>` — 指定输出目录（覆盖默认的 `versions/v<版本号>/`）
- `py update_cli.py` — Python 包装脚本，自动检测 exe/旧版 cli.js 并调用合适的提取方式

## 源码分析规则

对于任何源码模块分析，都生成一份文档到 `docs/` 目录下。

生成文档前，再次根据文档信息查看对应代码文件，确保实现和文档内容一致。

## 文档整理规则

文档完成后，执行以下操作：

1. 将文档复制一份到 `C:\Syncthing\Note\_topics\AI\CC`，文件名格式为 `cc源码.<中文名>.md`
2. 在索引文件中添加链接：`C:\Syncthing\Note\_topics\ClaudeCode.源码AI分析.md`
3. 链接格式（Obsidian wikilink，无路径前缀）：`- [[cc源码.<中文名>]]`
