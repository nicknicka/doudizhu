#!/usr/bin/env python3
"""下载 DouZero-WP 推理所需的 ONNX 权重。

权重来自公开镜像（免登录直连），默认下载到 models/douzero_WP/。
权重不进 Git 历史，所以新克隆的仓库需要先跑一次本脚本。
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

BASE_URL = (
    "https://huggingface.co/palemoky/douzero-baselines/resolve/main/models_onnx/douzero_WP"
)

# 文件名 -> 字节数。用于检测下载被截断。改动镜像来源时需同步更新。
MODELS: dict[str, int] = {
    "landlord.onnx": 5_834_135,
    "landlord_up.onnx": 6_061_463,
    "landlord_down.onnx": 6_061_463,
}

DEFAULT_DEST = Path("models/douzero_WP")


def download(name: str, expected_size: int, dest_dir: Path) -> None:
    dest = dest_dir / name
    if dest.exists() and dest.stat().st_size == expected_size:
        print(f"  跳过（已存在且大小正确）：{name}")
        return

    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  下载 {name} ... ", end="", flush=True)
    with urllib.request.urlopen(f"{BASE_URL}/{name}") as resp, tmp.open("wb") as fh:
        while chunk := resp.read(1 << 16):
            fh.write(chunk)

    actual = tmp.stat().st_size
    if actual != expected_size:
        tmp.unlink()
        raise SystemExit(f"{name} 大小不符：得到 {actual} 字节，期望 {expected_size} 字节")
    tmp.replace(dest)
    print(f"{actual} 字节")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dest", type=Path, default=DEFAULT_DEST, help=f"目标目录（默认 {DEFAULT_DEST}）"
    )
    args = parser.parse_args()

    args.dest.mkdir(parents=True, exist_ok=True)
    print(f"目标目录：{args.dest.resolve()}")
    for name, size in MODELS.items():
        download(name, size, args.dest)
    print(f"完成，共 {len(MODELS)} 个文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
