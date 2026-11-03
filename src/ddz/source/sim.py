"""仿真数据生成：用 RLCard 自对弈产出带真值的记录。

这批数据是后续评测的**唯一真值来源**：每局都记下三家的开局手牌，而每个决策点
的真实手牌可以由「开局手牌 − 已经出的牌」推出来，不需要逐步另存。

一局产出**三条记录**（三家各一条视角）：评测时要从每个位置分别衡量推断质量，
而记录里的 ``me`` 只能有一个。
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Iterator

import rlcard

from ddz.record.schema import Action, Initial, MatchRecord, Step, TURN_ORDER
from ddz.record.state import replay


class SimulationError(RuntimeError):
    """仿真没能产出可用的对局。"""


@dataclass(frozen=True)
class SimulatedGame:
    """一局仿真对局的原始素材。"""

    seed: int
    start_hands: dict[str, tuple[str, ...]]
    three_landlord_cards: tuple[str, ...]
    steps: tuple[Step, ...]


def _positions_by_player_id(landlord_id: int) -> dict[int, str]:
    """按当局实际地主编号映射 player_id 到地主参照的内部座位名。

    这些 ``landlord_up`` / ``landlord_down`` 是记录格式的内部位置，不是以我方
    为参照的「上家 / 下家」；后者由记录层的 ``relative_seats`` 推导。
    """
    if landlord_id not in range(3):
        raise SimulationError(f"地主编号必须是 0、1、2，收到 {landlord_id}")
    return {
        landlord_id: "landlord",
        (landlord_id + 1) % 3: "landlord_down",
        (landlord_id - 1) % 3: "landlord_up",
    }


def play_one_game(seed: int, max_steps: int = 500) -> SimulatedGame:
    """跑一局完全随机的自对弈。同一个 seed 必然得到同一局。"""
    env = rlcard.make("doudizhu")
    env.seed(seed)
    random.seed(seed)

    state, player_id = env.reset()
    positions = _positions_by_player_id(int(state["raw_obs"]["landlord"]))
    start_hands = {
        positions[i]: tuple(hand)
        for i, hand in enumerate(env.get_perfect_information()["hand_cards"])
    }
    landlord_cards = tuple(state["raw_obs"]["seen_cards"])

    steps: list[Step] = []
    while not env.is_over():
        if len(steps) >= max_steps:
            raise SimulationError(f"seed={seed} 超过 {max_steps} 步仍未结束")
        # 必须先排序：RLCard 的合法动作来自内部的 set，列表顺序随
        # PYTHONHASHSEED 变化，直接 random.choice 会让同一个 seed 在不同进程里
        # 走出不同的对局。
        raw = random.choice(sorted(state["raw_legal_actions"]))
        action = Action(kind="pass") if raw == "pass" else Action(kind="play", cards=tuple(raw))
        steps.append(
            Step(index=len(steps), player=positions[player_id], action=action)
        )
        state, player_id = env.step(raw, raw_action=True)

    return SimulatedGame(
        seed=seed,
        start_hands=start_hands,
        three_landlord_cards=landlord_cards,
        steps=tuple(steps),
    )


def to_records(game: SimulatedGame) -> tuple[MatchRecord, ...]:
    """一局仿真 → 三条记录（三家各一条视角）。"""
    records = []
    for me in TURN_ORDER:
        record = MatchRecord(
            record_id=f"sim-s{game.seed}-{me}",
            source="sim",
            created_at=f"2026-01-01T00:00:{game.seed % 60:02d}+08:00",
            me=me,
            initial=Initial(
                my_hand=game.start_hands[me],
                three_landlord_cards=game.three_landlord_cards,
                # 真值：只有仿真才有。评测靠它
                opponents={
                    pos: hand for pos, hand in game.start_hands.items() if pos != me
                },
            ),
            steps=game.steps,
        )
        # 每一局都必须能回放；回放不出来说明记录不成立，宁可当场炸掉。
        # 不写 outcome：胜负由 steps 就能推出来，写进去等于同一事实两个来源
        list(replay(record))
        records.append(record)
    return tuple(records)


def generate(games: int, seed: int) -> Iterator[MatchRecord]:
    """产出 ``games`` 局 × 3 条视角记录的展开。"""
    if games < 1:
        raise ValueError("局数至少为 1")
    for i in range(games):
        yield from to_records(play_one_game(seed + i))
