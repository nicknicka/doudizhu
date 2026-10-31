"""手牌分布的逐牌摘要。

最要紧的一条：概率口径必须和 CLI 的 ``ddz infer`` 一致 —— 报 P(至少一张)
与期望张数，而不是「第 k 张副本的累积概率」。
"""

from __future__ import annotations

from ddz.inference import card_summary


class FakeDistribution:
    """手搓一个分布，让概率与期望张数能逐位核对。

    只用到 Distribution 的三个成员（opponents / probability / expected_count），
    所以不必拉起 rlcard 或模型。
    """

    def __init__(self, opponents, particles):
        self.opponents = tuple(opponents)
        self.particles = tuple(particles)

    def probability(self, card, player):
        hit = sum(1 for p in self.particles if card in p[player])
        return hit / len(self.particles)

    def expected_count(self, card, player):
        total = sum(p[player].count(card) for p in self.particles)
        return total / len(self.particles)


OPPONENTS = ("landlord", "landlord_down")

# 4 颗粒子，和产物一样自洽：每颗粒子里各点数出现的次数与牌池一致。
# 「9」一字不差地在地主手上（最确定）；「8」「7」有摇摆。
POOL = ["7", "8", "8", "9"]
PARTICLES = [
    {"landlord": ["9", "8", "8"], "landlord_down": ["7"]},
    {"landlord": ["9", "8", "8"], "landlord_down": ["7"]},
    {"landlord": ["9", "8", "7"], "landlord_down": ["8"]},
    {"landlord": ["9"], "landlord_down": ["8", "8", "7"]},
]


def _dist():
    return FakeDistribution(OPPONENTS, PARTICLES)


def _rows():
    return {r["card"]: r for r in card_summary(_dist(), pool=POOL)}


def test_card_summary_reports_probability_and_expected_count():
    rows = _rows()
    # 9：地主四颗粒子全有 → P(至少一张)=1.0，期望 1.0；下家一张都没有
    assert rows["9"]["by"]["landlord"] == {"p": 1.0, "expected": 1.0}
    assert rows["9"]["by"]["landlord_down"] == {"p": 0.0, "expected": 0.0}
    # 8：地主 3/4 颗有 → P=0.75，期望 (2+2+1+0)/4=1.25
    assert rows["8"]["by"]["landlord"] == {"p": 0.75, "expected": 1.25}
    assert rows["8"]["by"]["landlord_down"] == {"p": 0.5, "expected": 0.75}


def test_card_summary_never_lists_a_card_twice():
    """旧实现把同一张点数拆成多行（3→97% 和 3→5%），这里锁死「一张牌一行」。"""
    cards = [r["card"] for r in card_summary(_dist(), pool=POOL)]
    assert len(cards) == len(set(cards))
    assert set(cards) == set(POOL)


def test_card_summary_expected_counts_are_conserved():
    """两个对手的期望张数之和 == 牌池里这张牌的张数 —— 牌不会凭空多出来。"""
    for row in card_summary(_dist(), pool=POOL):
        total = sum(v["expected"] for v in row["by"].values())
        assert abs(total - POOL.count(row["card"])) < 1e-9


def test_card_summary_puts_the_least_decided_card_first():
    """最贴近 50/50 的牌排前面：7 / 8 有摇摆，比板上钉钉的 9 更靠前。"""
    cards = [r["card"] for r in card_summary(_dist(), pool=POOL)]
    assert cards[-1] == "9"
    assert set(cards[:2]) == {"7", "8"}
