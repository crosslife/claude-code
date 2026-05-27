#!/usr/bin/env node
/**
 * Claude Code EXE 源码提取工具
 *
 * 从 Bun SEA 格式的 claude.exe 中提取嵌入的 JavaScript 源码，
 * 自动检测版本号，格式化后输出到 versions/v<版本号>/ 目录。
 * 可选拆分 cli.js 为模块目录结构。
 *
 * 用法:
 *   node extract_from_exe.js [exe路径] [--no-format] [--no-split] [--out-dir <dir>]
 *
 * 默认 exe 路径: npm 全局安装目录下的 @anthropic-ai/claude-code/bin/claude.exe
 * 默认输出目录: versions/v<版本号>/
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_EXE_PATH = path.join(
  process.env.APPDATA || "",
  "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    exePath: DEFAULT_EXE_PATH,
    format: true,
    split: true,
    outDir: null, // will be set after version detection
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--no-format") {
      opts.format = false;
    } else if (args[i] === "--no-split") {
      opts.split = false;
    } else if (args[i] === "--out-dir" && args[i + 1]) {
      opts.outDir = args[++i];
    } else if (!args[i].startsWith("--")) {
      opts.exePath = args[i];
    }
  }

  return opts;
}

function findBunSection(buf) {
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error("不是有效的 PE 文件（缺少 MZ 头）");
  }

  const peOffset = buf.readUInt32LE(0x3c);
  const peSig = buf.readUInt32LE(peOffset);
  if (peSig !== 0x00004550) {
    throw new Error("无效的 PE 签名");
  }

  const numSections = buf.readUInt16LE(peOffset + 6);
  const optHeaderSize = buf.readUInt16LE(peOffset + 20);
  const sectionStart = peOffset + 24 + optHeaderSize;

  for (let i = 0; i < numSections; i++) {
    const off = sectionStart + i * 40;
    const name = buf
      .slice(off, off + 8)
      .toString("ascii")
      .replace(/\0/g, "");
    if (name === ".bun") {
      return {
        virtualSize: buf.readUInt32LE(off + 8),
        rawSize: buf.readUInt32LE(off + 16),
        rawPtr: buf.readUInt32LE(off + 20),
      };
    }
  }

  throw new Error("未找到 .bun 段——这可能不是 Bun 编译的可执行文件");
}

function extractModules(buf, bunSection) {
  const { rawPtr, rawSize } = bunSection;
  const sectionEnd = rawPtr + rawSize;

  const moduleMarker = Buffer.from("// @bun @bytecode @bun-cjs\n");
  const pathPrefix = Buffer.from("B:/~BUN/root/");

  const modules = [];
  let searchStart = rawPtr;

  while (searchStart < sectionEnd) {
    const markerIdx = buf.indexOf(moduleMarker, searchStart);
    if (markerIdx < 0 || markerIdx >= sectionEnd) break;

    // 往回找模块路径
    let pathStart = markerIdx;
    while (pathStart > markerIdx - 500 && pathStart > rawPtr) {
      if (buf.slice(pathStart, pathStart + pathPrefix.length).equals(pathPrefix)) break;
      pathStart--;
    }

    let modulePath = "";
    if (buf.slice(pathStart, pathStart + pathPrefix.length).equals(pathPrefix)) {
      const pathEnd = buf.indexOf(0, pathStart);
      const rawPath = buf
        .slice(pathStart, pathEnd > 0 ? pathEnd : markerIdx)
        .toString("ascii")
        .replace(/[^\x20-\x7e]/g, "");
      modulePath = rawPath.replace("B:/~BUN/root/", "");
    }

    // 源码从 CJS 包装器开始
    const cjsStart = buf.indexOf(
      Buffer.from("(function(exports"),
      markerIdx,
    );
    if (cjsStart < 0 || cjsStart >= sectionEnd) {
      searchStart = markerIdx + 1;
      continue;
    }

    // 找下一个模块或段尾作为结束边界
    const nextMarker = buf.indexOf(moduleMarker, markerIdx + 1);
    let sourceEnd;
    if (nextMarker > 0 && nextMarker < sectionEnd) {
      // 回退到下一个模块路径之前
      let boundary = nextMarker;
      while (boundary > cjsStart && buf[boundary - 1] < 32) boundary--;
      const nextPath = buf.lastIndexOf(pathPrefix, nextMarker);
      if (nextPath > cjsStart) {
        boundary = nextPath;
        while (boundary > cjsStart && buf[boundary - 1] < 32) boundary--;
      }
      sourceEnd = boundary;
    } else {
      // 最后一个模块：找 "---- Bun! ----" 签名
      const bunSig = buf.indexOf(Buffer.from("---- Bun! ----"), cjsStart);
      sourceEnd =
        bunSig > 0 && bunSig < sectionEnd ? bunSig : sectionEnd;
      while (sourceEnd > cjsStart && buf[sourceEnd - 1] < 32)
        sourceEnd--;
    }

    const source = buf.slice(cjsStart, sourceEnd).toString("utf8");

    modules.push({
      path: modulePath,
      name: path.basename(modulePath, ".js"),
      source: source.replace(/\0/g, ""),
      size: sourceEnd - cjsStart,
    });

    searchStart = nextMarker > 0 ? nextMarker : sectionEnd;
  }

  return modules;
}

function detectVersion(buf, modules) {
  // 方法 1: 从 package.json 所在目录读取
  const exeDir = path.dirname(path.dirname(
    typeof buf === "string" ? buf : "",
  ));
  try {
    const pkgPath = path.join(exeDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) return pkg.version;
    }
  } catch {}

  // 方法 2: 从源码中搜索版本字符串
  const mainSource = modules.find((m) => m.name === "cli")?.source || "";
  const versionPatterns = [
    /Version:\s*([\d.]+)/,
    /"version"\s*:\s*"([\d.]+)"/,
    /CLAUDE_CODE_VERSION\s*=\s*"([\d.]+)"/,
    /version\s*=\s*"(\d+\.\d+\.\d+)"/,
  ];
  for (const pat of versionPatterns) {
    const m = mainSource.match(pat);
    if (m) return m[1];
  }

  return "unknown";
}

async function formatSource(source) {
  try {
    const prettier = require("prettier");
    console.log("  使用 Prettier 格式化...");
    const formatted = await prettier.format(source, {
      parser: "babel",
      printWidth: 100,
      tabWidth: 2,
      semi: true,
      singleQuote: false,
      trailingComma: "all",
    });
    return formatted;
  } catch (err) {
    console.warn("  Prettier 格式化失败:", err.message);
    console.warn("  输出未格式化的源码");
    return source;
  }
}

// ===================== Module Splitting =====================

function collectSrcFingerprints(srcDir) {
  const fingerprints = new Map();
  function walk(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.name.match(/\.(ts|tsx|js|jsx)$/)) {
        const content = fs.readFileSync(path.join(dir, entry.name), "utf8");

        // Exported names (strong signal)
        const exports = [];
        for (const m of content.matchAll(/export\s+(?:function|class|const|let|var|async\s+function)\s+(\w+)/g))
          exports.push(m[1]);
        for (const m of content.matchAll(/export\s+default\s+(?:function|class)\s+(\w+)/g))
          exports.push(m[1]);

        // Long string literals
        const strings = [];
        for (const m of content.matchAll(/'([^']{25,120})'/g)) strings.push(m[1]);
        for (const m of content.matchAll(/"([^"]{25,120})"/g)) strings.push(m[1]);
        for (const m of content.matchAll(/`([^`]{25,120})`/g)) {
          if (!m[1].includes("${")) strings.push(m[1]);
        }

        // UPPER_CASE constants (medium signal)
        const constants = [];
        for (const m of content.matchAll(/\b([A-Z][A-Z_]{4,})\b/g)) constants.push(m[1]);

        // PascalCase identifiers >= 8 chars (medium signal)
        const identifiers = [];
        for (const m of content.matchAll(/\b([A-Z][a-z][A-Za-z]{6,})\b/g)) identifiers.push(m[1]);

        // Unique medium strings (10-25 chars, more of them)
        const medStrings = [];
        for (const m of content.matchAll(/"([^"]{10,25})"/g)) {
          if (/[a-z]/.test(m[1]) && !/^[0-9.]+$/.test(m[1])) medStrings.push(m[1]);
        }

        // File basename without extension as additional identifier
        const baseName = entry.name.replace(/\.(ts|tsx|js|jsx)$/, "");

        fingerprints.set(relPath, { exports, strings, constants, identifiers, medStrings, baseName });
      }
    }
  }
  walk(srcDir, "");
  return fingerprints;
}

function splitModules(cliJsPath, outSrcDir) {
  const source = fs.readFileSync(cliJsPath, "utf8");
  const lines = source.split("\n");

  const cjsPattern = /^\s*var\s+(\w+)\s*=\s*i\(\(/;
  const esmPattern = /^\s*var\s+(\w+)\s*=\s*T\(\(\)\s*=>\s*\{/;

  const allModules = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    let m = line.match(cjsPattern);
    if (m) { allModules.push({ id: m[1], type: "cjs", line: lineIdx + 1 }); continue; }
    m = line.match(esmPattern);
    if (m) { allModules.push({ id: m[1], type: "esm", line: lineIdx + 1 }); }
  }

  allModules.sort((a, b) => a.line - b.line);
  for (let idx = 0; idx < allModules.length; idx++) {
    allModules[idx].endLine = idx + 1 < allModules.length ? allModules[idx + 1].line - 1 : lines.length;
    allModules[idx].size = allModules[idx].endLine - allModules[idx].line;
  }

  console.log(`  解析到 ${allModules.length} 个模块`);

  // Build fingerprint index from reference src/
  const refSrcDir = path.join(__dirname, "src");
  let srcFP = new Map();
  if (fs.existsSync(refSrcDir)) {
    srcFP = collectSrcFingerprints(refSrcDir);
    console.log(`  参考 src/ 索引: ${srcFP.size} 文件`);
  } else {
    console.log("  未找到参考 src/ 目录，跳过路径映射");
  }

  function getModuleContent(mod) {
    return lines.slice(mod.line - 1, mod.endLine).join("\n");
  }

  // Build two reverse indexes:
  // 1. Token index: single word/identifier -> [{path, weight}]
  // 2. Phrase index: multi-word strings -> [{path, weight}]
  const tokenIndex = new Map();
  const phraseIndex = new Map();

  function addToken(key, filePath, weight) {
    if (key.length < 5) return;
    let entry = tokenIndex.get(key);
    if (!entry) { entry = []; tokenIndex.set(key, entry); }
    entry.push({ path: filePath, weight });
  }
  function addPhrase(key, filePath, weight) {
    if (key.length < 10) return;
    let entry = phraseIndex.get(key);
    if (!entry) { entry = []; phraseIndex.set(key, entry); }
    entry.push({ path: filePath, weight });
  }

  for (const [relPath, fp] of srcFP) {
    for (const name of fp.exports) addToken(name, relPath, 3);
    for (const c of fp.constants) addToken(c, relPath, 1);
    for (const id of fp.identifiers) addToken(id, relPath, 1);
    for (const str of fp.strings) addPhrase(str, relPath, 2);
    for (const ms of fp.medStrings) {
      // Single-word medium strings go to token index, multi-word to phrase
      if (/^\w+$/.test(ms)) addToken(ms, relPath, 1);
      else addPhrase(ms, relPath, 1);
    }
  }
  console.log(`  词元索引: ${tokenIndex.size}, 短语索引: ${phraseIndex.size}`);

  // Pre-sort phrases by length for early termination
  const phrases = [...phraseIndex.keys()];

  // Flat index for brute-force fallback (all fingerprints as a single list)
  const flatIndex = new Map(); // key -> [{path, weight}]
  for (const [relPath, fp] of srcFP) {
    for (const name of fp.exports) { if (name.length >= 5) { const e = flatIndex.get(name) || []; e.push({ path: relPath, weight: 3 }); flatIndex.set(name, e); } }
    for (const str of fp.strings) { if (str.length >= 5) { const e = flatIndex.get(str) || []; e.push({ path: relPath, weight: 2 }); flatIndex.set(str, e); } }
    for (const c of fp.constants) { if (c.length >= 5) { const e = flatIndex.get(c) || []; e.push({ path: relPath, weight: 1 }); flatIndex.set(c, e); } }
    for (const id of fp.identifiers) { if (id.length >= 5) { const e = flatIndex.get(id) || []; e.push({ path: relPath, weight: 1 }); flatIndex.set(id, e); } }
    for (const ms of fp.medStrings) { if (ms.length >= 5) { const e = flatIndex.get(ms) || []; e.push({ path: relPath, weight: 1 }); flatIndex.set(ms, e); } }
  }
  const flatKeys = [...flatIndex.keys()];
  console.log(`  暴力回退索引: ${flatKeys.length} 条目`);

  function matchModuleFast(content) {
    const scores = new Map();
    const wordPattern = /\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g;
    let wm;
    while ((wm = wordPattern.exec(content)) !== null) {
      const entries = tokenIndex.get(wm[0]);
      if (entries) {
        for (const { path: fp, weight } of entries)
          scores.set(fp, (scores.get(fp) || 0) + weight);
      }
    }
    let bestMatch = null, bestScore = 0;
    for (const [filePath, score] of scores) {
      if (score > bestScore) { bestScore = score; bestMatch = filePath; }
    }
    return bestScore >= 4 ? { path: bestMatch, score: bestScore } : null;
  }

  function matchModuleBrute(content) {
    const scores = new Map();
    for (const key of flatKeys) {
      if (!content.includes(key)) continue;
      for (const { path: fp, weight } of flatIndex.get(key))
        scores.set(fp, (scores.get(fp) || 0) + weight);
    }
    let bestMatch = null, bestScore = 0;
    for (const [filePath, score] of scores) {
      if (score > bestScore) { bestScore = score; bestMatch = filePath; }
    }
    return bestScore >= 4 ? { path: bestMatch, score: bestScore } : null;
  }

  function matchModule(mod) {
    if (tokenIndex.size === 0) return null;
    const content = getModuleContent(mod);
    const fast = matchModuleFast(content);
    if (fast) return fast;
    return matchModuleBrute(content);
  }

  function isLikelyClaudeCode(mod) {
    const content = getModuleContent(mod);
    const signals = ["CLAUDE_CODE", "claude-code", "anthropic", "getSystemPrompt",
      "agentLoop", "toolUse", "slash command", "claudemd", "permissions", "CLAUDE"];
    return signals.filter(s => content.includes(s)).length >= 1;
  }

  let matched = 0, ccUnmatched = 0, written = 0;
  for (const mod of allModules) {
    if (mod.size < 5) continue;
    const match = matchModule(mod);
    let outPath;

    if (match) {
      mod.mappedPath = match.path;
      outPath = path.join(outSrcDir, match.path.replace(/\.tsx?$/, ".js"));
      matched++;
    } else if (isLikelyClaudeCode(mod)) {
      outPath = path.join(outSrcDir, "_unmapped", `${mod.id}.js`);
      ccUnmatched++;
    } else {
      continue;
    }

    const dir = path.dirname(outPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const content = getModuleContent(mod);
    const header = `// Module ID: ${mod.id} (${mod.type})\n// Lines: ${mod.line}-${mod.endLine} (${mod.size} lines)\n`;
    const mapping = mod.mappedPath
      ? `// Mapped to: ${mod.mappedPath} (score: ${match.score})\n`
      : `// Unmapped Claude Code module\n`;
    fs.writeFileSync(outPath, header + mapping + "\n" + content);
    written++;
  }

  console.log(`  已映射: ${matched}, 未映射CC: ${ccUnmatched}, 写入: ${written} 文件`);
  return { total: allModules.length, matched, ccUnmatched, written };
}

// ===================== Main =====================

async function main() {
  const opts = parseArgs();

  console.log("=== Claude Code EXE 源码提取工具 ===\n");

  // 读取 exe
  console.log(`读取: ${opts.exePath}`);
  if (!fs.existsSync(opts.exePath)) {
    console.error(`错误: 文件不存在: ${opts.exePath}`);
    process.exit(1);
  }

  const buf = fs.readFileSync(opts.exePath);
  console.log(`文件大小: ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

  // 读取版本号（从 package.json）
  const pkgJsonPath = path.join(
    path.dirname(path.dirname(opts.exePath)),
    "package.json",
  );
  let version = "unknown";
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    version = pkg.version || "unknown";
  } catch {}

  // 解析 PE 段
  console.log("\n解析 PE 段表...");
  const bunSection = findBunSection(buf);
  console.log(
    `找到 .bun 段: offset=${bunSection.rawPtr}, size=${(bunSection.rawSize / 1024 / 1024).toFixed(1)} MB`,
  );

  // 提取模块
  console.log("\n提取字节码模块...");
  const modules = extractModules(buf, bunSection);
  console.log(`找到 ${modules.length} 个模块:`);
  modules.forEach((m) => {
    console.log(
      `  ${m.path || m.name}: ${(m.size / 1024 / 1024).toFixed(2)} MB`,
    );
  });

  // 版本检测回退
  if (version === "unknown") {
    version = detectVersion("", modules);
  }
  console.log(`\n版本: ${version}`);

  // 确定输出目录: 优先用 --out-dir，否则用 versions/v<版本号>/
  const outDir = opts.outDir || path.join(__dirname, "versions", `v${version}`);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  console.log(`输出目录: ${outDir}`);

  // 输出每个模块
  for (const mod of modules) {
    const baseName = mod.name || "module";
    const outName = `${baseName}.js`;
    const outPath = path.join(outDir, outName);
    console.log(`\n处理 ${baseName}...`);

    let output = mod.source;
    if (opts.format && baseName === "cli") {
      output = await formatSource(output);
    }

    fs.writeFileSync(outPath, output);
    const outSize = fs.statSync(outPath).size;
    console.log(
      `  写入: ${outPath} (${(outSize / 1024 / 1024).toFixed(2)} MB)`,
    );
  }

  // 模块拆分
  if (opts.split) {
    const cliJsPath = path.join(outDir, "cli.js");
    if (fs.existsSync(cliJsPath)) {
      console.log("\n拆分 cli.js 为模块目录...");
      const srcOutDir = path.join(outDir, "src");
      const result = splitModules(cliJsPath, srcOutDir);
      console.log(`  输出目录: ${srcOutDir}`);
    } else {
      console.log("\n跳过模块拆分: cli.js 未找到");
    }
  }

  console.log("\n完成！");
}

main().catch((err) => {
  console.error("致命错误:", err.message);
  process.exit(1);
});
