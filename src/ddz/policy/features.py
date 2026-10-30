"""DouZero 的观测特征构造。

上游 DouZero 用整数编码牌（3–14、2→17、小王→20、大王→30），而我们对外
（记录格式、命令行）统一用 RLCard 的字符表。转换和特征拼装都收在这里。

**这段代码必须与上游逐位一致**，否则模型收到的是它没见过的输入，分数会变成
看似合理实则无意义的数字。`tests/test_policy_features.py` 用上游自己的
`get_obs()` 做逐位对照来守住这件事。

上游依据：DouZero `douzero/env/env.py`（Apache-2.0）。
"""

from __future__ import annotations

from collections import Counter
from typing import Iterable, Mapping, Sequence

import numpy as np

from ddz.cards import FULL_DECK, normalize

# RLCard 字符表 → DouZero 整数编码
CARD_TO_INT: dict[str, int] = {
    "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
    "T": 10, "J": 11, "Q": 12, "K": 13, "A": 14,
    "2": 17, "B": 20, "R": 30,
}
INT_TO_CARD: dict[int, str] = {v: k for k, v in CARD_TO_INT.items()}

# 13 个普通点数的列序（2 排在 A 之后）
CARD_COLUMN: dict[int, int] = {3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6,
                               10: 7, 11: 8, 12: 9, 13: 10, 14: 11, 17: 12}

# 某个点数出现 n 次时，该列 4 个槽位的填充模式
NUM_ONES_2_ARRAY: dict[int, np.ndarray] = {
    0: np.array([0, 0, 0, 0]),
    1: np.array([1, 0, 0, 0]),
    2: np.array([1, 1, 0, 0]),
    3: np.array([1, 1, 1, 0]),
    4: np.array([1, 1, 1, 1]),
}

ACTION_SEQ_LENGTH = 15   # 上游编码最近 15 手
ACTION_SEQ_ROWS = 5      # 每 3 手折成一行，3 * 54 = 162
ACTION_SEQ_FEATURE_DIM = 162

# 各位置模型 x 向量的宽度，用于自检
X_WIDTH = {"landlord": 373, "landlord_up": 484, "landlord_down": 484}

POSITIONS = ("landlord", "landlord_up", "landlord_down")


def to_ints(cards: Iterable[str]) -> list[int]:
    """字符牌 → 整数牌。"""
    return [CARD_TO_INT[c] for c in cards]


def cards_to_array(cards: Sequence[int]) -> np.ndarray:
    """把一手牌编码成 54 维向量（4×13 按列展开，末尾拼接两张王）。"""
    if len(cards) == 0:
        return np.zeros(54, dtype=np.int8)

    matrix = np.zeros([4, 13], dtype=np.int8)
    jokers = np.zeros(2, dtype=np.int8)
    for card, times in Counter(cards).items():
        if card < 20:
            matrix[:, CARD_COLUMN[card]] = NUM_ONES_2_ARRAY[times]
        elif card == 20:
            jokers[0] = 1
        elif card == 30:
            jokers[1] = 1
    return np.concatenate((matrix.flatten("F"), jokers))


def _one_hot(num_left_cards: int, max_num_cards: int) -> np.ndarray:
    """剩余张数的 one-hot。

    注意：上游在 ``num_left_cards == 0`` 时会写到最后一个下标（Python 负数索引）。
    这个行为看起来像 bug，但为了与训练时一致，这里**原样复刻**。
    """
    one_hot = np.zeros(max_num_cards)
    one_hot[num_left_cards - 1] = 1
    return one_hot


def _one_hot_bomb(bomb_num: int) -> np.ndarray:
    one_hot = np.zeros(15)
    one_hot[bomb_num] = 1
    return one_hot


def _process_action_seq(sequence: Sequence[Sequence[int]], length: int = ACTION_SEQ_LENGTH):
    """取最近 length 手，不足则在**前面**补空手（空手编码为全 0）。"""
    sequence = list(sequence)[-length:]
    if len(sequence) < length:
        sequence = [[] for _ in range(length - len(sequence))] + sequence
    return sequence


def action_seq_to_array(action_seq: Sequence[Sequence[int]]) -> np.ndarray:
    """把 15 手历史折成 (5, 162) 的矩阵。"""
    rows = np.zeros((len(action_seq), 54))
    for i, cards in enumerate(action_seq):
        rows[i, :] = cards_to_array(cards)
    return rows.reshape(ACTION_SEQ_ROWS, ACTION_SEQ_FEATURE_DIM)


def _repeat(vec: np.ndarray, n: int) -> np.ndarray:
    return np.repeat(vec[np.newaxis, :], n, axis=0)


def build_features(
    position: str,
    my_hand: Sequence[str],
    legal_actions: Sequence[Sequence[str]],
    other_hand_cards: Sequence[str],
    num_cards_left: Mapping[str, int],
    played_cards: Mapping[str, Sequence[str]],
    last_move: Sequence[str],
    last_move_dict: Mapping[str, Sequence[str]],
    card_play_action_seq: Sequence[Sequence[str]],
    bomb_num: int,
) -> tuple[np.ndarray, np.ndarray]:
    """构造 (x_batch, z_batch)，形状分别是 (n_actions, width) 与 (n_actions, 5, 162)。"""
    if position not in POSITIONS:
        raise ValueError(f"未知位置：{position}")

    n = len(legal_actions)
    if n == 0:
        raise ValueError("合法动作为空，无法构造特征")

    my_handcards = _repeat(cards_to_array(to_ints(my_hand)), n)
    other_handcards = _repeat(cards_to_array(to_ints(other_hand_cards)), n)
    last_action = _repeat(cards_to_array(to_ints(last_move)), n)

    my_action_batch = np.zeros(my_handcards.shape)
    for j, action in enumerate(legal_actions):
        my_action_batch[j, :] = cards_to_array(to_ints(action))

    bomb = _repeat(_one_hot_bomb(bomb_num), n)

    if position == "landlord":
        parts = [
            my_handcards,
            other_handcards,
            last_action,
            _repeat(cards_to_array(to_ints(played_cards["landlord_up"])), n),
            _repeat(cards_to_array(to_ints(played_cards["landlord_down"])), n),
            _repeat(_one_hot(num_cards_left["landlord_up"], 17), n),
            _repeat(_one_hot(num_cards_left["landlord_down"], 17), n),
            bomb,
            my_action_batch,
        ]
    else:
        # 两个农民模型结构相同，只是「队友」指向不同
        teammate = "landlord_down" if position == "landlord_up" else "landlord_up"
        parts = [
            my_handcards,
            other_handcards,
            _repeat(cards_to_array(to_ints(played_cards["landlord"])), n),
            _repeat(cards_to_array(to_ints(played_cards[teammate])), n),
            last_action,
            _repeat(cards_to_array(to_ints(last_move_dict["landlord"])), n),
            _repeat(cards_to_array(to_ints(last_move_dict[teammate])), n),
            _repeat(_one_hot(num_cards_left["landlord"], 20), n),
            _repeat(_one_hot(num_cards_left[teammate], 17), n),
            bomb,
            my_action_batch,
        ]

    x_batch = np.hstack(parts).astype(np.float32)

    z = action_seq_to_array(
        _process_action_seq([to_ints(a) for a in card_play_action_seq])
    )
    z_batch = np.repeat(z[np.newaxis, :, :], n, axis=0).astype(np.float32)

    expected = X_WIDTH[position]
    if x_batch.shape != (n, expected):
        raise AssertionError(
            f"{position} 的 x 宽度应为 {expected}，实际 {x_batch.shape[1]}"
        )
    return x_batch, z_batch
