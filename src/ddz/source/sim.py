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

from ddz.record.schema import Action, Initial, MatchRecord, Step
from ddz.record.state import replay

# RLCard 的 player_id：0 地主、1 地主下家、2 地主上家（出手顺序也是 0→1→2）
PLAYER_ID_TO_POSITION = {0: "landlord", 1: "landlord_down", 2: "landlord_up"}
POSITIONS_BY_ID = tuple(PLAYER_ID_TO_POSITION[i] for i in range(3))


class SimulationError(RuntimeError):
    """仿真没能产出可用的对局。"""


@dataclass(frozen=True)
class SimulatedGame:
    """一局仿真对局的原始素材。"""

    seed: int
    start_hands: dict[str, tuple[str, ...]]
    three_landlord_cards: tuple[str, ...]
    steps: tuple[Step, ...]


def play_one_game(seed: int, max_steps: int = 500) -> SimulatedGame:
    """跑一局完全随机的自对弈。同一个 seed 必然得到同一局。"""
    env = rlcard.make("doudizhu")
    env.seed(seed)
    random.seed(seed)

    state, player_id = env.reset()
    start_hands = {
        PLAYER_ID_TO_POSITION[i]: tuple(hand)
        for i, hand in enumerate(env.get_perfect_information()["hand_cards"])
    }
    landlord_cards = tuple(state["raw_obs"]["seen_cards"])

    steps: list[Step] = []
    while not env.is_over():
        if len(steps) >= max_steps:
            raise SimulationError(f"seed={seed} 超过 {max_steps} 步仍未结束")
        raw = random.choice(state["raw_legal_actions"])
        action = Action(kind="pass") if raw == "pass" else Action(kind="play", cards=tuple(raw))
        steps.append(
            Step(index=len(steps), player=PLAYER_ID_TO_POSITION[player_id], action=action)
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
    for me in POSITIONS_BY_ID:
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
