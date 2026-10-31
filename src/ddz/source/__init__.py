"""输入源：把外部的局面变成统一的记录对象。不碰模型、不做推断。"""

from ddz.source import manual, sim
from ddz.source.manual import (
    IllegalEntryError,
    append_step,
    now,
    parse_cards,
    start,
    truncate,
    undo,
)

__all__ = [
    "manual", "sim", "IllegalEntryError", "start", "append_step", "undo", "truncate",
    "parse_cards", "now",
]
