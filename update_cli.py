#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
提取 Claude Code cli.js 到当前项目根目录并格式化

策略:
1. 检测本地安装的 claude.exe 是否为 Bun SEA 二进制
2. 若是 Bun SEA，调用 extract_from_exe.js 提取源码
3. 若存在旧式 cli.js，直接复制并格式化
4. 若以上都不存在，通过 npm pack 下载指定版本的 tarball 并解压
"""

import subprocess
import shutil
import sys
import tarfile
import tempfile
import json
from pathlib import Path

# ============== 配置参数 ==============
CLAUDE_CODE_PATH = Path(r"C:\Users\ziyang.ge\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code")
PACKAGE_NAME = "@anthropic-ai/claude-code"
LAST_JS_VERSION = "2.1.112"
# =====================================


def run_cmd(args, **kwargs):
    print(f"  > {' '.join(str(a) for a in args)}")
    return subprocess.run(args, shell=True, **kwargs)


def get_installed_version():
    """读取本地安装的 package.json 获取版本号"""
    pkg_json = CLAUDE_CODE_PATH / "package.json"
    if pkg_json.exists():
        data = json.loads(pkg_json.read_text(encoding="utf-8"))
        return data.get("version", "unknown")
    return None


def is_bun_exe(exe_path: Path) -> bool:
    """检查 exe 是否为 Bun SEA 格式（检查 MZ 头 + .bun 段）"""
    if not exe_path.exists() or exe_path.stat().st_size < 1024:
        return False
    with open(exe_path, "rb") as f:
        header = f.read(2)
        if header != b"MZ":
            return False
    # 进一步确认：文件 >50MB 且不是 stub
    return exe_path.stat().st_size > 50 * 1024 * 1024


def extract_from_bun_exe(project_root: Path, version: str) -> bool:
    """调用 extract_from_exe.js 从 Bun SEA 中提取源码到 versions/v<版本号>/"""
    script = project_root / "extract_from_exe.js"
    if not script.exists():
        print(f"错误: 提取脚本不存在: {script}")
        return False

    result = run_cmd(
        ["node", str(script)],
        cwd=project_root,
        capture_output=False,
    )
    if result.returncode != 0:
        print("错误: extract_from_exe.js 执行失败")
        return False

    # 检查输出目录
    version_dir = project_root / "versions" / f"v{version}"
    cli_file = version_dir / "cli.js"
    if cli_file.exists():
        print(f"\n已提取并格式化: {cli_file} ({cli_file.stat().st_size / 1024 / 1024:.1f} MB)")
        return True

    # 尝试查找任何 versions/v*/cli.js
    cli_files = list((project_root / "versions").glob("v*/cli.js"))
    if cli_files:
        latest = max(cli_files, key=lambda f: f.stat().st_mtime)
        print(f"\n已提取并格式化: {latest} ({latest.stat().st_size / 1024 / 1024:.1f} MB)")
        return True

    print("错误: 提取后未找到输出文件")
    return False


def extract_from_npm(version: str, target: Path):
    """通过 npm pack 下载 tarball 并提取 cli.js（仅适用于旧版 <=2.1.112）"""
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        result = run_cmd(
            ["npm", "pack", f"{PACKAGE_NAME}@{version}"],
            cwd=tmp,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(f"错误: npm pack 失败\n{result.stderr}")
            return False

        tgz_files = list(tmp.glob("*.tgz"))
        if not tgz_files:
            print("错误: 未找到下载的 tgz 文件")
            return False

        with tarfile.open(tgz_files[0], "r:gz") as tar:
            cli_member = None
            for member in tar.getmembers():
                if member.name.endswith("cli.js"):
                    cli_member = member
                    break

            if not cli_member:
                print("错误: tarball 中未找到 cli.js (新版已改为原生二进制)")
                print(f"提示: 新版请直接运行 node extract_from_exe.js")
                return False

            f = tar.extractfile(cli_member)
            if f is None:
                print("错误: 无法提取 cli.js")
                return False
            target.write_bytes(f.read())

    return True


def beautify_js(target: Path):
    """使用 prettier 格式化 JS 文件"""
    print("使用 Prettier 格式化...")
    result = run_cmd(
        ["npx", "prettier", "--write", "--parser", "babel", str(target)],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        print("格式化完成")
        return True

    # 回退到 js-beautify
    print("Prettier 失败，尝试 js-beautify...")
    result = run_cmd(["js-beautify", "-r", str(target)])
    if result.returncode == 0:
        print("格式化完成 (js-beautify)")
        return True

    print("警告: 格式化失败，输出未格式化的源码")
    return False


def main():
    project_root = Path(__file__).parent.resolve()

    version = get_installed_version()
    requested_version = sys.argv[1] if len(sys.argv) > 1 else None

    print("=" * 50)
    print("Claude Code 源码提取工具")
    print("=" * 50)
    print()

    if version:
        print(f"本地安装版本: {version}")
    else:
        print("本地未安装 Claude Code")

    exe_path = CLAUDE_CODE_PATH / "bin" / "claude.exe"

    # 策略 1: Bun SEA 二进制提取（新版 >= 2.1.113）
    if is_bun_exe(exe_path):
        print(f"\n检测到 Bun SEA 二进制: {exe_path}")
        print(f"大小: {exe_path.stat().st_size / 1024 / 1024:.1f} MB")
        print()
        print("=" * 50)
        print(f"从 Bun SEA 中提取源码 (v{version})...")
        print("=" * 50)

        if extract_from_bun_exe(project_root, version):
            print()
            print("=" * 50)
            print("完成！")
            print("=" * 50)
            return
        else:
            print("Bun SEA 提取失败，尝试其他方式...")

    # 策略 2: 本地 cli.js（旧版）
    source_cli = CLAUDE_CODE_PATH / "cli.js"
    target_version = requested_version or version or LAST_JS_VERSION
    version_dir = project_root / "versions" / f"v{target_version}"
    version_dir.mkdir(parents=True, exist_ok=True)
    target_cli = version_dir / "cli.js"

    if source_cli.exists():
        print(f"\n从本地安装路径复制 cli.js: {source_cli}")
        shutil.copy2(source_cli, target_cli)
        print(f"已保存: {target_cli} ({target_cli.stat().st_size / 1024 / 1024:.1f} MB)")
        print()
        beautify_js(target_cli)
    else:
        # 策略 3: npm pack 下载旧版
        dl_version = requested_version or LAST_JS_VERSION
        version_dir = project_root / "versions" / f"v{dl_version}"
        version_dir.mkdir(parents=True, exist_ok=True)
        target_cli = version_dir / "cli.js"
        print(f"\n从 npm 下载版本 {dl_version}...")
        if extract_from_npm(dl_version, target_cli):
            print(f"已保存: {target_cli} ({target_cli.stat().st_size / 1024 / 1024:.1f} MB)")
            print()
            beautify_js(target_cli)
        else:
            sys.exit(1)

    print()
    print("=" * 50)
    print("完成！")
    print(f"文件位置: {target_cli}")
    print("=" * 50)


if __name__ == "__main__":
    main()
