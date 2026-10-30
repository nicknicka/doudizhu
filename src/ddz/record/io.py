"""记录的读写。round-trip 是硬要求：``load(save(x)) == x``。"""

from __future__ import annotations

import json
from pathlib import Path

from ddz.record.schema import MatchRecord


def dumps(record: MatchRecord) -> str:
    """序列化成 JSON 文本。排序键 + 固定缩进，保证同一记录字节级稳定。"""
    return json.dumps(record.to_json(), ensure_ascii=False, indent=2, sort_keys=True)


def loads(text: str) -> MatchRecord:
    return MatchRecord.from_json(json.loads(text))


def save(record: MatchRecord, path: Path | str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(record) + "\n", encoding="utf-8")


def load(path: Path | str) -> MatchRecord:
    return loads(Path(path).read_text(encoding="utf-8"))
