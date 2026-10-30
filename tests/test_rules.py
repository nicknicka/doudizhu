"""规则核对：仿真器实现的规则是否与标准三人斗地主一致。

这些是**契约探针**，不是业务逻辑测试。它们断言的是标准规则，用来证明仿真器
与真实玩法一致；仿真器一旦改动导致偏离，这里会红。

结论与影响记录在 docs/rules.md。
"""

from __future__ import annotations

from collections import Counter
from types import SimpleNamespace

from rlcard.games.doudizhu.judger import DoudizhuJudger
from rlcard.games.doudizhu.utils import get_gt_cards


def playable(hand: str) -> set[str]:
    """一手牌在「自由领出」时的全部合法组合。"""
    return DoudizhuJudger.playable_cards_from_hand(hand)


def responses(hand: str, last_played: str) -> list[str]:
    """上家出了 last_played 时，我手上除 pass 之外的所有合法应对。"""
    player = SimpleNamespace(current_hand=[SimpleNamespace(rank=c) for c in hand])
    greater = SimpleNamespace(played_cards=last_played)
    return [c for c in get_gt_cards(player, greater) if c != "pass"]


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
    """已知的上游信息泄漏：默认观测里含另外两家**真实手牌的并集**。

    这不是我们想要的行为，但它确实成立 —— RLCard 的
    ``raw_obs["others_hand"]`` 恰好等于另外两家真值手牌的合并，且全程保持精确。

    由此产生一条硬约束：**手牌推断绝对不能读这个字段**，否则等于偷看答案，
    后续评测会给出好看但毫无意义的数字。

    如果上游哪天修掉了这个泄漏，这条测试会失败 —— 那是好事，说明约束可以放宽，
    顺手更新 docs/rules.md 即可。
    """
    import rlcard

    env = rlcard.make("doudizhu")
    env.seed(42)
    state, _ = env.reset()

    obs = state["raw_obs"]
    me = obs["self"]
    truth_hands = env.get_perfect_information()["hand_cards"]
    others_truth = "".join(truth_hands[i] for i in range(3) if i != me)

    assert Counter(obs["others_hand"]) == Counter(others_truth)
