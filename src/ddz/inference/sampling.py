"""手牌分布：把牌池分成粒子，频率即概率。

**这一版的后验是"在合法分法上均匀分布"。** 只用可靠约束时这是唯一诚实的答案 ——
要偏离均匀，需要引入偏好（比如"能压就压"的经验假设），那已经不属于可靠推断。
它比朴素基线强的地方在于**守住了剩余张数约束**：基线让每张牌独立抛硬币，
会产出"某人 20 张"这种不可能的分法。

粒子的含义：一组"另两家各持哪些牌"的完整假设。频率即概率。
"""

from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Mapping

from ddz.cards import normalize
from ddz.inference.feasibility import opponents_of
from ddz.record.state import Snapshot


@dataclass(frozen=True)
class Particle:
    """一个完整假设：两个对手各持哪些牌。"""

    hands: Mapping[str, tuple[str, ...]]


@dataclass(frozen=True)
class Distribution:
    particles: tuple[Particle, ...]
    opponents: tuple[str, ...]
    diagnostics: Mapping[str, int]

    def probability(self, card: str, player: str) -> float:
        """某张牌**至少有一张**在该玩家手上的概率。"""
        if player not in self.opponents:
            raise ValueError(f"{player} 不是对手之一：{self.opponents}")
        hit = sum(1 for p in self.particles if card in p.hands[player])
        return hit / len(self.particles)

    def expected_count(self, card: str, player: str) -> float:
        """某张牌在该玩家手上的**期望张数**（比"有没有"更细）。"""
        if player not in self.opponents:
            raise ValueError(f"{player} 不是对手之一：{self.opponents}")
        total = sum(p.hands[player].count(card) for p in self.particles)
        return total / len(self.particles)


def sample(snapshot: Snapshot, n_particles: int = 200, seed: int = 0) -> Distribution:
    """从牌池里采样出 ``n_particles`` 个合法的完整假设。"""
    if n_particles < 1:
        raise ValueError("粒子数至少为 1")

    opponents = opponents_of(snapshot)
    sizes = {p: snapshot.num_cards_left[p] for p in opponents}
    if sum(sizes.values()) != len(snapshot.pool):
        raise ValueError(
            f"牌池 {len(snapshot.pool)} 张，而两家手牌合计 {sum(sizes.values())} 张，"
            "记录不自洽"
        )

    first = opponents[0]
    rng = random.Random(seed)

    particles: list[Particle] = []
    seen: set[tuple] = set()

    # 洗牌后切一刀：得到的**必然**满足张数约束，所以这里是"构造即合法"，
    # 不做拒绝采样。因此没有"过滤掉多少非法组合"这种计数 —— 一个恒定为零的
    # 计数器只会误导读者。
    for _ in range(n_particles):
        shuffled = list(snapshot.pool)
        rng.shuffle(shuffled)
        cut = sizes[first]
        candidate = {
            first: normalize(shuffled[:cut]),
            opponents[1]: normalize(shuffled[cut:]),
        }
        particles.append(Particle(hands=candidate))
        seen.add(tuple(sorted(candidate.items())))

    diagnostics = {
        "n_particles": len(particles),
        "n_distinct_partitions": len(seen),
        "pool_size": len(snapshot.pool),
        "opponents": opponents,
    }
    return Distribution(
        particles=tuple(particles), opponents=opponents, diagnostics=diagnostics
    )
