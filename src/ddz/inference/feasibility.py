"""可能性判定：某张牌可能在谁手上。

只用**公开信息**，一条也不多：

- 牌池（全牌 − 我方手牌 − 已出的牌）
- 各家的剩余张数
- 那一家是否已经出完

既不读真值，也不用「他刚才没压，说明他没有大牌」这类启发式 —— 那种推断在斗地主里
**不成立**：留着大牌不出是合法策略。这里给的是可靠约束，不是猜测。

输出的不是一个是非，而是**张数区间** ``[low, high]``：``high == 0`` 表示不可能，
``low > 0`` 表示必然有。区间比布尔值有用，因为上限和下限来自不同的推理。
"""

from __future__ import annotations

from dataclasses import dataclass

from ddz.cards import CARD_ORDER
from ddz.record.schema import TURN_ORDER
from ddz.record.state import Snapshot


@dataclass(frozen=True)
class Bounds:
    """某个玩家手上这张牌的张数区间。"""

    low: int
    high: int
    reasons: tuple[str, ...]

    @property
    def impossible(self) -> bool:
        return self.high == 0

    @property
    def certain(self) -> bool:
        return self.low > 0


def unseen_copies(snapshot: Snapshot, card: str) -> int:
    """这张牌还有几张没现身 —— 就是它在牌池里的张数。

    牌池已经由记录层推好了（全牌 − 我方手牌 − 已出的牌），这里不重算一遍。
    """
    if card not in CARD_ORDER:
        raise ValueError(f"字符表之外的牌：{card!r}")
    return snapshot.pool.count(card)


def opponents_of(snapshot: Snapshot) -> tuple[str, ...]:
    """除我之外的两家。"""
    return tuple(p for p in TURN_ORDER if p != snapshot.me)


def bounds_for(snapshot: Snapshot, card: str) -> dict[str, Bounds]:
    """**两个对手**手上这张牌的张数区间，附带可读理由。

    不含我自己：我手上有什么我自己知道，再给一段"他可能有多少张"是误导。
    """
    remaining = unseen_copies(snapshot, card)
    hand_size = snapshot.num_cards_left
    opponents = opponents_of(snapshot)

    result: dict[str, Bounds] = {}
    for player in opponents:
        reasons: list[str] = []

        capacity = min(remaining, hand_size[player])
        # 鸽笼：其他玩家最多能容纳的份额之外，剩下的必然落在这个人手上
        others_capacity = sum(
            min(remaining, hand_size[q]) for q in opponents if q != player
        )
        low = max(0, remaining - others_capacity)

        if remaining == 0:
            reasons.append("这张牌已经全部现身（在我手上或已出），谁都不可能有")
        elif hand_size[player] == 0:
            reasons.append("他已经出完了")
        else:
            reasons.append(f"未现身 {remaining} 张，他还有 {hand_size[player]} 张手牌")
            if low > 0:
                reasons.append(
                    f"必然至少有 {low} 张：另一家最多只能容纳 {others_capacity} 张"
                )

        result[player] = Bounds(low=low, high=capacity, reasons=tuple(reasons))
    return result
