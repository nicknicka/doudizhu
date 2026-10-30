#!/usr/bin/env python3
"""从仿真对局里裁出决策点，存成测试用的局面记录。

局面必须自洽（三家手牌 + 已出的牌 = 54 张），所以不能手写——从真实对局里裁。
"""

from __future__ import annotations

import random
import sys
from pathlib import Path

import rlcard

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from ddz.record.io import save  # noqa: E402
from ddz.record.schema import Action, Initial, MatchRecord, Step  # noqa: E402

PLAYER_ID_TO_POSITION = {0: "landlord", 1: "landlord_down", 2: "landlord_up"}
OUT_DIR = REPO_ROOT / "tests" / "data"


def cut_position(seed: int, target_player_id: int, max_steps: int = 60):
    """跑到指定玩家该动为止，返回该决策点的记录。"""
    env = rlcard.make("doudizhu")
    env.seed(seed)
    random.seed(seed)
    state, player_id = env.reset()

    start_hands = env.get_perfect_information()["hand_cards"]
    landlord_cards = state["raw_obs"]["seen_cards"]

    steps: list[Step] = []
    while player_id != target_player_id:
        if env.is_over() or len(steps) >= max_steps:
            raise RuntimeError(f"seed={seed} 跑到上限也没轮到 player {target_player_id}")
        action = random.choice(state["raw_legal_actions"])
        acting = PLAYER_ID_TO_POSITION[player_id]
        if action == "pass":
            parsed = Action(kind="pass")
        else:
            parsed = Action(kind="play", cards=tuple(action))
        steps.append(Step(index=len(steps), player=acting, action=parsed))
        state, player_id = env.step(action, raw_action=True)

    me = PLAYER_ID_TO_POSITION[target_player_id]
    record = MatchRecord(
        record_id=f"fixture-seed{seed}-{me}",
        source="sim",
        created_at="2026-10-31T00:00:00+08:00",  # 固定值，保证测试可复现
        me=me,
        initial=Initial(
            my_hand=tuple(start_hands[target_player_id]),
            three_landlord_cards=tuple(landlord_cards),
        ),
        steps=tuple(steps),
    )
    return record


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, seed, target in (("landlord", 7, 0), ("landlord_up", 7, 2), ("landlord_down", 7, 1)):
        record = cut_position(seed, target)
        path = OUT_DIR / f"position_{name}.json"
        save(record, path)
        print(f"  {path.name}: {len(record.steps)} 步，我方 {record.me}，"
              f"手牌 {len(record.initial.my_hand)} 张")
    return 0


if __name__ == "__main__":
    sys.exit(main())
