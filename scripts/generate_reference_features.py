#!/usr/bin/env python3
"""用上游 DouZero 生成特征黄金向量，供 tests/test_policy_features.py 比对。

需要 DouZero 源码（无需安装、无需 torch）：

    git clone --depth 1 https://github.com/kwai/DouZero /tmp/douzero
    .venv/bin/python scripts/generate_reference_features.py --upstream /tmp/douzero

DouZero 的 PyPI 包把 torch 声明为必需依赖，所以这里走源码路径，不动项目环境。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT))

from ddz.policy.features import CARD_TO_INT  # noqa: E402
from tests.reference_cases import POSITIONS, build_case  # noqa: E402


def to_upstream_infoset(case: dict) -> SimpleNamespace:
    """把我们的用例翻成上游 InfoSet 的形状（整数牌编码）。"""
    as_ints = lambda cards: [CARD_TO_INT[c] for c in cards]  # noqa: E731
    return SimpleNamespace(
        player_position=case["position"],
        player_hand_cards=as_ints(case["my_hand"]),
        legal_actions=[as_ints(a) for a in case["legal_actions"]],
        other_hand_cards=as_ints(case["other_hand_cards"]),
        three_landlord_cards=[],
        num_cards_left_dict=dict(case["num_cards_left"]),
        played_cards={k: as_ints(v) for k, v in case["played_cards"].items()},
        card_play_action_seq=[as_ints(a) for a in case["card_play_action_seq"]],
        last_move=as_ints(case["last_move"]),
        last_move_dict={k: as_ints(v) for k, v in case["last_move_dict"].items()},
        bomb_num=case["bomb_num"],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True, help="DouZero 仓库根目录")
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "tests" / "data" / "douzero_reference.npz")
    args = parser.parse_args()

    sys.path.insert(0, str(args.upstream.resolve()))
    from douzero.env.env import get_obs  # noqa: E402  （只在这里依赖上游）

    arrays = {}
    for position in POSITIONS:
        obs = get_obs(to_upstream_infoset(build_case(position)))
        arrays[f"{position}__x"] = obs["x_batch"]
        arrays[f"{position}__z"] = obs["z_batch"]
        print(f"  {position}: x={obs['x_batch'].shape} z={obs['z_batch'].shape}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(args.out, **arrays)
    print(f"已写入 {args.out}（{args.out.stat().st_size} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
