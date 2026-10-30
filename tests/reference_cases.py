"""与上游 DouZero 做特征对照用的固定输入。

这些输入**不依赖随机数**，也不用真的开一局：只是把一组前后一致的牌面拼出来，
喂给两个实现（我们的与上游的），比对输出是否逐位相同。

生成黄金向量：``scripts/generate_reference_features.py``
"""

from __future__ import annotations

from ddz.policy.features import FULL_DECK

POSITIONS = ("landlord", "landlord_up", "landlord_down")

_DECK = list(FULL_DECK)


def _legal_actions(hand: list[str]) -> list[list[str]]:
    """一份确定性的合法动作清单：pass + 每个不同点数的一张单牌。"""
    actions: list[list[str]] = [[]]  # 空列表表示「不出」，与上游一致
    seen: set[str] = set()
    for card in hand:
        if card not in seen:
            actions.append([card])
            seen.add(card)
    return actions


def build_case(position: str) -> dict:
    """构造一个前后一致的牌面：三家手牌 + 已出的牌加起来正好 54 张。"""
    landlord_hand = _DECK[0:15]
    landlord_up_hand = _DECK[15:25]
    landlord_down_hand = _DECK[25:35]
    # 已出的 19 张按 5 / 7 / 7 分给三家
    played = {
        "landlord": _DECK[35:40],
        "landlord_up": _DECK[40:47],
        "landlord_down": _DECK[47:54],
    }
    hands = {
        "landlord": landlord_hand,
        "landlord_up": landlord_up_hand,
        "landlord_down": landlord_down_hand,
    }

    my_hand = hands[position]
    other_hand_cards = [
        card for pos, hand in hands.items() if pos != position for card in hand
    ]

    return {
        "position": position,
        "my_hand": my_hand,
        "legal_actions": _legal_actions(my_hand),
        "other_hand_cards": other_hand_cards,
        "num_cards_left": {pos: len(hand) for pos, hand in hands.items()},
        "played_cards": played,
        "last_move": ["5", "5"],
        "last_move_dict": {"landlord": ["5", "5"], "landlord_up": [], "landlord_down": []},
        "card_play_action_seq": [["3"], [], ["4", "4"], [], ["5", "5"]],
        "bomb_num": 1,
    }
