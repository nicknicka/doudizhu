"""我们构造的 DouZero 特征必须与上游**逐位一致**。

黄金向量由 ``scripts/generate_reference_features.py`` 调用**上游 DouZero 自己的
``get_obs()``** 生成，存在 ``tests/data/douzero_reference.npz``。

这是本项目最重要的一道防线：特征错一位，模型收到的就是它训练时没见过的输入，
分数会变成看似合理、实则无意义的数字，而且**所有结构测试都会照样通过**。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from ddz.policy import features
from tests.reference_cases import POSITIONS, build_case

GOLDEN_PATH = Path(__file__).parent / "data" / "douzero_reference.npz"


@pytest.fixture(scope="module")
def golden() -> np.lib.npyio.NpzFile:
    assert GOLDEN_PATH.exists(), (
        f"缺少黄金向量 {GOLDEN_PATH}，"
        "用 scripts/generate_reference_features.py 重新生成"
    )
    return np.load(GOLDEN_PATH)


@pytest.mark.parametrize("position", POSITIONS)
def test_features_match_upstream_bit_for_bit(position, golden):
    """三个位置模型的 x 与 z 都与上游逐位相同。"""
    case = build_case(position)
    x, z = features.build_features(**case)

    assert np.array_equal(x, golden[f"{position}__x"]), f"{position} 的 x_batch 与上游不一致"
    assert np.array_equal(z, golden[f"{position}__z"]), f"{position} 的 z_batch 与上游不一致"


@pytest.mark.parametrize("position", POSITIONS)
def test_batch_dimension_follows_legal_action_count(position):
    """batch 维等于合法动作数，宽度符合该位置的模型。"""
    case = build_case(position)
    x, z = features.build_features(**case)

    n = len(case["legal_actions"])
    assert x.shape == (n, features.X_WIDTH[position])
    assert z.shape == (n, features.ACTION_SEQ_ROWS, features.ACTION_SEQ_FEATURE_DIM)


class TestCardsToArray:
    """牌的编码本身。"""

    def test_empty_is_all_zero(self):
        assert features.cards_to_array([]).tolist() == [0] * 54

    def test_three_copies_fill_three_slots_of_one_column(self):
        arr = features.cards_to_array([3, 3, 3])
        # 前 52 位是 (4 行 × 13 列) 矩阵按列主序展开的结果，还原时 order 要对上
        matrix = arr[:52].reshape(4, 13, order="F")
        assert matrix[:, features.CARD_COLUMN[3]].tolist() == [1, 1, 1, 0]

    def test_jokers_land_in_the_last_two_slots(self):
        arr = features.cards_to_array([20, 30])
        assert arr[52] == 1 and arr[53] == 1

    def test_two_maps_to_the_last_column(self):
        arr = features.cards_to_array([17])
        matrix = arr[:52].reshape(4, 13, order="F")
        assert matrix[:, features.CARD_COLUMN[17]].tolist() == [1, 0, 0, 0]


def test_zero_cards_left_hits_the_last_slot():
    """上游在剩余 0 张时把 one-hot 写到最后一个下标（Python 负索引）。

    看起来是 bug，但上游训练时就是这个行为，所以我们必须原样复刻 ——
    否则到了终局局面，特征会与模型见过的不一致。
    """
    assert features._one_hot(0, 17)[-1] == 1


def test_action_sequence_is_padded_at_the_front():
    """不足 15 手时在**前面**补空手，保证最近一手落在最后。"""
    seq = features._process_action_seq([[3]])
    assert len(seq) == 15
    assert seq[-1] == [3]
    assert all(s == [] for s in seq[:-1])


def test_rejects_empty_legal_actions():
    with pytest.raises(ValueError, match="合法动作为空"):
        features.build_features(**{**build_case("landlord"), "legal_actions": []})


def test_rejects_unknown_position():
    with pytest.raises(ValueError, match="未知位置"):
        features.build_features(**{**build_case("landlord"), "position": "spectator"})
