"""牌的领域基础：字符表与整副牌。

放在包的最底层，供 record 与 policy 共用 —— 这样 ``record`` 不需要反向依赖
``policy``（见 docs/architecture.md 的单向依赖约定）。
"""

from __future__ import annotations

from collections import Counter

# 与 RLCard / DouZero 一致的字符表。B = 小王，R = 大王。
CARD_ALPHABET = "3456789TJQKA2BR"

CARD_ORDER: dict[str, int] = {card: i for i, card in enumerate(CARD_ALPHABET)}

# 整副牌：13 个点数各 4 张，外加两张王
FULL_DECK: tuple[str, ...] = tuple("3456789TJQKA2" * 4) + ("B", "R")

FULL_DECK_COUNTS: Counter[str] = Counter(FULL_DECK)


def normalize(cards) -> tuple[str, ...]:
    """按字符表顺序规范化一组牌。

    记录里统一用规范顺序，这样同一手牌只有一种写法，round-trip 才是稳定的。
    """
    unknown = sorted(set(cards) - set(CARD_ORDER))
    if unknown:
        raise ValueError(f"出现字符表之外的牌：{unknown!r}")
    return tuple(sorted(cards, key=lambda c: CARD_ORDER[c]))
