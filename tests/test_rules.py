"""规则核对：仿真器实现的规则是否与标准三人斗地主一致。

这些是**契约探针**，不是业务逻辑测试。它们断言的是标准规则，用来证明仿真器
与真实玩法一致；仿真器一旦改动导致偏离，这里会红。

结论与影响记录在 docs/rules.md。
"""

from __future__ import annotations

import random
from collections import Counter
from types import SimpleNamespace

from rlcard.games.doudizhu.judger import DoudizhuJudger
from rlcard.games.doudizhu.utils import get_gt_cards

# 上游动作词表：RLCard 用这个字符串表示「不出」。
# 注意它不是我们记录格式里的动作表示（我们用 {"type": "pass"}），
# 只是上游 API 的取值，所以在这里集中命名一次，不在正文里散落字面量。
RLCARD_PASS = "pass"


def playable(hand: str) -> set[str]:
    """一手牌在「自由领出」时的全部合法组合。"""
    return DoudizhuJudger.playable_cards_from_hand(hand)


def responses(hand: str, last_played: str) -> list[str]:
    """上家出了 last_played 时，我手上除 pass 之外的所有合法应对。"""
    player = SimpleNamespace(current_hand=[SimpleNamespace(rank=c) for c in hand])
    greater = SimpleNamespace(played_cards=last_played)
    return [c for c in get_gt_cards(player, greater) if c != RLCARD_PASS]


class TestStraightRule:
    """规则 1：顺子最少 5 张，且 2 与大小王不能入顺。"""

    def test_four_consecutive_singles_is_not_a_straight(self):
        assert "3456" not in playable("34567")

    def test_five_consecutive_singles_is_a_straight(self):
        assert "34567" in playable("34567")

    def test_longer_straights_are_allowed(self):
        assert "45678" in playable("456789")

    def test_ace_may_end_a_straight(self):
        assert "TJQKA" in playable("TJQKA")

    def test_two_may_not_appear_in_a_straight(self):
        assert "JQKA2" not in playable("JQKA2")
        assert "23456" not in playable("23456")


class TestPairChainRule:
    """规则 2：连对最少 3 对，且 2 不能入连对。"""

    def test_two_consecutive_pairs_is_not_a_chain(self):
        assert "3344" not in playable("3344")

    def test_three_consecutive_pairs_is_a_chain(self):
        assert "334455" in playable("334455")

    def test_longer_pair_chains_are_allowed(self):
        assert "445566" in playable("445566")

    def test_two_may_not_appear_in_a_pair_chain(self):
        assert "KKAA22" not in playable("KKAA22")
        assert "AA22" not in playable("AA22")


class TestPlaneWithWingsRule:
    """规则 3：飞机（连续三张）带翅膀时，翅膀数量必须等于三张的组数。"""

    def test_bare_plane_of_two_triples(self):
        assert "333444" in playable("333444")

    def test_wings_count_must_match_triple_count(self):
        """两组三张必须带 2 个翅膀，带 1 个不合法。"""
        assert "3334445" not in playable("3334445")
        assert "33344455" in playable("33344455")

    def test_wings_may_be_two_different_singles(self):
        assert "33344456" in playable("33344456")

    def test_wings_may_be_pairs(self):
        assert "3334445566" in playable("3334445566")

    def test_longer_planes_are_allowed(self):
        assert "333444555" in playable("333444555")


class TestBombAndRocketRule:
    """规则 4：炸弹压一切非炸弹，火箭压一切；低炸弹压不过高炸弹。"""

    def test_bomb_beats_non_bomb(self):
        assert responses("3333", "5") == ["3333"]

    def test_lower_bomb_cannot_beat_higher_bomb(self):
        assert responses("3333", "4444") == []

    def test_higher_bomb_beats_lower_bomb(self):
        assert responses("5555", "4444") == ["5555"]

    def test_rocket_beats_any_bomb(self):
        assert responses("3333BR", "4444") == ["BR"]

    def test_nothing_beats_a_rocket(self):
        assert responses("3333BR", "BR") == []


def test_observation_leaks_merged_opponent_hands():
    """已确认的上游信息泄漏：**原始观测与编码观测都含另外两家真实手牌的并集**。

    泄漏有两个面，且全程保持精确：

    1. ``raw_obs["others_hand"]`` —— 直接就是另两家真值手牌的合并
    2. ``state["obs"][54:108]`` —— 同一份信息的编码形态

    第 2 条尤其危险：``state["obs"]`` 是仿真器准备喂给智能体的那个向量，
    看起来"已经过处理"，很容易被当成干净的输入直接使用。

    由此产生硬约束：**可见信息只能从白名单字段取**
    （``current_hand`` / ``played_cards`` / ``num_cards_left`` / ``seen_cards``
    / ``trace`` / ``landlord`` / ``self``），
    **既不能读 ``others_hand``，也不能直接用 ``state["obs"]``**。

    上游若修掉泄漏，这条测试会失败 —— 那是好消息，说明约束可以放宽，
    顺手更新 docs/rules.md 即可。
    """
    import numpy as np
    import rlcard
    from rlcard.envs.doudizhu import _cards2array

    for steps in (0, 15, 35):
        env = rlcard.make("doudizhu")
        env.seed(42)
        random.seed(42)
        state, _ = env.reset()
        for _ in range(steps):
            if env.is_over():
                break
            action = random.choice(state["raw_legal_actions"])
            state, _ = env.step(action, raw_action=True)

        raw = state["raw_obs"]
        me = raw["self"]
        truth_hands = env.get_perfect_information()["hand_cards"]
        others_truth = "".join(truth_hands[i] for i in range(3) if i != me)

        # 面一：原始观测字段
        assert Counter(raw["others_hand"]) == Counter(others_truth), (
            f"第 {steps} 步：raw_obs['others_hand'] 不再是另两家真值的并集"
        )

        # 面二：编码观测中对应的区块
        assert np.array_equal(state["obs"][54:108], _cards2array(others_truth)), (
            f"第 {steps} 步：state['obs'][54:108] 不再是另两家真值的编码"
        )
