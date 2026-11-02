"""规则判定：某手牌认不认得、压不压得住、我方有哪些合法动作。

放在包的最底层（与 ``cards`` 同级），因为 **source 与 policy 都要用它**：
录入时要校验每一手，决策时要枚举合法动作。它属于领域规则，不属于决策模型。

用 RLCard 的判定器，因为它已经被 ``tests/test_rules.py`` 的 20 条探针核对过。

一个坑：RLCard 判定器的接口要的是**牌对象**（带 ``.rank``），而且它内部按组合串
查表，串的写法必须是它自己的规范顺序（``88822`` 而不是 ``22888``）。
所以这里把已知组合串建成一张"牌面计数 → 规范串"的索引，用来还原写法。
"""

from __future__ import annotations

from collections import Counter

from rlcard.games.doudizhu.judger import DoudizhuJudger
from rlcard.games.doudizhu.utils import CARD_TYPE, get_gt_cards

from ddz.record.schema import Action
from ddz.record.state import Snapshot

# RLCard 自己的动作词表：空串以外的 'pass'
RLCARD_PASS = "pass"


class _Card:
    __slots__ = ("rank",)

    def __init__(self, rank: str) -> None:
        self.rank = rank


class _HandHolder:
    __slots__ = ("current_hand",)

    def __init__(self, hand: str) -> None:
        self.current_hand = [_Card(c) for c in hand]


class _PlayedHolder:
    __slots__ = ("played_cards",)

    def __init__(self, combo: str) -> None:
        self.played_cards = combo


def _build_combo_index() -> dict[frozenset, str]:
    """牌面计数 → RLCard 的规范组合串。"""
    index: dict[frozenset, str] = {}
    for combo in CARD_TYPE[0]:
        index.setdefault(frozenset(Counter(combo).items()), combo)
    return index


_COMBO_INDEX = _build_combo_index()


def canonical_combo(cards) -> str:
    """把一组牌还原成 RLCard 认得的那种写法。

    例如 ``["2","2","8","8","8"]`` → ``"88822"``（三张在前）。
    """
    key = frozenset(Counter(cards).items())
    try:
        return _COMBO_INDEX[key]
    except KeyError:
        raise ValueError(f"不是合法牌型：{sorted(cards)!r}") from None


def beat_options(hand_cards, last_move) -> set[str]:
    """已知「某人的手牌」与上一手时，能压上去的组合串集合。

    注意：这里传的手牌不一定是真的——校验别人的出牌时，我们会把整个牌池当手牌传，
    因为对手具体怎么分我们不知道。这样只能验证「这手牌型压得住」，
    验证不了「他确实拿得出」。
    """
    target = canonical_combo(last_move)
    raw = get_gt_cards(_HandHolder("".join(hand_cards)), _PlayedHolder(target))
    return {combo for combo in raw if combo != RLCARD_PASS}


def legal_actions(snapshot: Snapshot) -> list[Action]:
    """我方在当前局面下的全部合法动作。

    自由领出时不能 pass；需要压牌时 pass 总是合法。
    """
    hand = "".join(snapshot.my_hand)

    # 牌局已经结束就没有"合法动作"这回事了 —— RLCard 判完胜负之后同样返回空。
    # 这是给调用方兜底：正常情况下他们该先看 ``snapshot.finished``。
    if snapshot.finished:
        return []

    if not snapshot.last_move:
        combos = sorted(DoudizhuJudger.playable_cards_from_hand(hand))
        return [Action(kind="play", cards=tuple(c)) for c in combos]

    options = beat_options(snapshot.my_hand, snapshot.last_move)
    return [Action(kind="pass")] + [
        Action(kind="play", cards=tuple(combo)) for combo in sorted(options)
    ]
