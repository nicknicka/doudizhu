"""从记录推导局面。

记录里只存推不出来的东西，其余都在这里算出来：已出的牌、各家剩余张数、
最近的出牌、按顺序的出牌历史、炸弹数。

推导规则与 DouZero 引擎保持一致（见 docs/rules.md 与上游 ``douzero/env/game.py``），
否则模型会收到语义不同的输入。
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Iterator

from ddz.cards import FULL_DECK
from ddz.record.schema import (
    INITIAL_HAND_SIZE,
    TURN_ORDER,
    MatchRecord,
    Step,
)


@dataclass(frozen=True)
class Snapshot:
    """某个决策点的**可见**状态。"""

    acting: str
    my_hand: tuple[str, ...]
    pool: tuple[str, ...]
    """未现身的牌 —— 另两家手牌的并集。公开可推导：全牌 − 我方手牌 − 已出的牌。"""

    played_cards: dict[str, tuple[str, ...]]
    num_cards_left: dict[str, int]
    last_move: tuple[str, ...]
    last_move_dict: dict[str, tuple[str, ...]]
    card_play_action_seq: tuple[tuple[str, ...], ...]
    bomb_num: int


def _acting_player(steps: tuple[Step, ...]) -> str:
    """下一步该谁动。

    规则：出牌后按顺序轮转；连续两家 pass 之后回到最后出牌的那家，由他自由领出。
    """
    if not steps:
        return TURN_ORDER[0]

    last_play_index = None
    for i, step in enumerate(steps):
        if step.action.is_play:
            last_play_index = i
    if last_play_index is None:
        raise ValueError("记录里一次出牌都没有，第一手必须是有人领出")

    last_player = steps[last_play_index].player
    passes_after = len(steps) - last_play_index - 1
    position = TURN_ORDER.index(last_player)

    if passes_after >= 2:
        return last_player  # 两家都过，回到他自由领出
    return TURN_ORDER[(position + 1 + passes_after) % len(TURN_ORDER)]


def _is_bomb(cards: tuple[str, ...]) -> bool:
    """炸弹或火箭。"""
    if len(cards) == 4 and len(set(cards)) == 1:
        return True
    return set(cards) == {"B", "R"} and len(cards) == 2


def derive(record: MatchRecord, steps: tuple[Step, ...] | None = None) -> Snapshot:
    """推导某个时刻的局面。``steps`` 缺省用记录里的全部步骤。"""
    steps = record.steps if steps is None else steps

    played: dict[str, list[str]] = {p: [] for p in TURN_ORDER}
    move_dict: dict[str, tuple[str, ...]] = {p: () for p in TURN_ORDER}
    sequence: list[tuple[str, ...]] = []
    bomb_num = 0

    for step in steps:
        cards = step.action.cards
        sequence.append(cards)
        move_dict[step.player] = cards
        if step.action.is_play:
            played[step.player].extend(cards)
            if _is_bomb(cards):
                bomb_num += 1

    my_hand = list(record.initial.my_hand)
    for card in played[record.me]:
        if card not in my_hand:
            raise ValueError(f"记录不自洽：我方出了手上没有的牌 {card!r}")
        my_hand.remove(card)

    # 未现身的牌 = 全牌 − 我方手牌 − 已出的牌（牌是守恒的）
    pool = Counter(FULL_DECK) - Counter(my_hand) - Counter(
        [c for cards in played.values() for c in cards]
    )
    if any(v < 0 for v in pool.values()):
        raise ValueError("记录不自洽：已出的牌超过了全牌数量")

    # 末手是 pass 就再往前一手；两次 pass 后正好得到空，代表"可自由领出"
    if sequence and not sequence[-1]:
        last_move = sequence[-2] if len(sequence) >= 2 else ()
    else:
        last_move = sequence[-1] if sequence else ()

    return Snapshot(
        acting=_acting_player(steps),
        my_hand=tuple(my_hand),
        pool=tuple(sorted(c for c, n in pool.items() for _ in range(n))),
        played_cards={p: tuple(v) for p, v in played.items()},
        num_cards_left={
            p: INITIAL_HAND_SIZE[p] - len(played[p]) for p in TURN_ORDER
        },
        last_move=tuple(last_move),
        last_move_dict=move_dict,
        card_play_action_seq=tuple(sequence),
        bomb_num=bomb_num,
    )


def replay(record: MatchRecord) -> Iterator[Snapshot]:
    """逐步回放：产出每个决策点的局面（第 0 个是开局）。"""
    yield derive(record, steps=())
    for i in range(1, len(record.steps) + 1):
        yield derive(record, steps=record.steps[:i])
