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


FULL_DECK = "3456789TJQKA2" * 4 + "BR"


def test_opponent_hand_pool_is_publicly_derivable():
    """另两家手牌的**并集**是公开信息，不是泄漏。README 级别的纠正：

    它看起来像泄漏 —— 确实精确等于另两家真实手牌的并集。但那是牌的守恒推出来的：

        每张牌只可能在三个地方：我手上 / 别人手上 / 已出的牌堆里

    所以

        另两家并集 = 全牌 − 我的手 − 已出的牌

    任何会数牌的牌手都能算出这个集合。它不透露**分配**，而分配才是真正隐藏的
    信息，也正是本项目要推断的东西。

    这条测试有两个用途：

    1. 证明仿真器给的 ``others_hand``（以及 ``state["obs"]`` 里对应那段编码）
       不含任何超出公开信息的成分 —— 我们的推断问题没有被提前喂答案；
    2. 把「未现身的牌池」该怎么算写成**可执行的定义** —— 真实牌局录入那条路径
       没有仿真器帮我们算，必须自己来。
    """
    import rlcard

    for steps in (0, 10, 25, 45):
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
        played = "".join(raw["played_cards"])

        pool_from_public_info = Counter(FULL_DECK) - Counter(raw["current_hand"]) - Counter(played)

        assert Counter(raw["others_hand"]) == pool_from_public_info, (
            f"第 {steps} 步：others_hand 不等于「全牌 − 我的手 − 已出的牌」"
        )

        # 并集确实等于另两家的真值之和 —— 但这正是守恒，不是特权
        truth_hands = env.get_perfect_information()["hand_cards"]
        others_truth = "".join(truth_hands[i] for i in range(3) if i != me)
        assert Counter(raw["others_hand"]) == Counter(others_truth)


class TestGameOverRule:
    """规则 5：一家出完牌，牌局就结束了 —— 谁都没有合法动作。

    引擎（RLCard）在 ``is_over()`` 之后不再给动作；我们的 ``legal_actions``
    必须一致，否则会给一个已经打完的牌局发候选。
    """

    def test_the_engine_hands_out_no_action_once_the_game_is_over(self):
        import rlcard

        env = rlcard.make("doudizhu")
        env.seed(0)
        random.seed(0)
        state, _ = env.reset()
        while not env.is_over():
            state, _ = env.step(random.choice(state["raw_legal_actions"]), raw_action=True)
        assert state["raw_legal_actions"] == []

    def test_we_hand_out_no_action_once_the_game_is_over(self):
        from ddz.record.state import derive
        from ddz.rules import legal_actions
        from tests.test_record import finished_record

        # 地主出完牌，轮次正好转到他下家 —— 但牌局已经结束，谁也不该再有动作
        snapshot = derive(finished_record(me="landlord_down"))
        assert snapshot.finished
        assert legal_actions(snapshot) == []
