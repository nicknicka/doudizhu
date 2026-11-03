"""评测：推断质量的可复现数字。

对照的基线是**独立抛硬币**：每张未现身的牌，各自以 1/2 判给两家之一。
它无视剩余张数，因此会产出「某人 20 张」这种不可能的分法 —— 这正是它该输的地方。

注意基线**不能是**「在所有合法分法上均匀」：那正是我们自己的采样器（见 #9），
拿它当基线等于自己跟自己比。
"""

from __future__ import annotations

import math
import random
from collections import Counter
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

from ddz.cards import normalize
from ddz.inference import opponents_of, sample
from ddz.record.schema import MatchRecord
from ddz.record.state import derive


class MissingGroundTruthError(ValueError):
    """记录里没有真值，评测无法进行。

    绝不把缺失的真值当成空手牌 —— 那样会算出一个看着像样、实则毫无意义的分数。
    """


@dataclass(frozen=True)
class Metrics:
    """一组指标。两者用**同一套算法**算，才能并列比较。"""

    top1_accuracy: float
    top1_n: int
    """单张牌的 Top-1 命中率：这张独一无二的牌在谁手上，选概率高的那位对不对。"""

    log_likelihood: float
    """逐 (牌, 玩家) 的二元对数似然均值。上限是 0，越接近 0 越好。"""

    n_positions: int
    n_cards_scored: int

    def as_row(self, name: str) -> str:
        return (
            f"| {name} | {self.top1_accuracy:.1%} ({self.top1_n}) "
            f"| {self.log_likelihood:.4f} | {self.n_cards_scored} |"
        )


def _truth_hands(record: MatchRecord) -> Mapping[str, Counter[str]]:
    if record.initial.opponents is None:
        raise MissingGroundTruthError(
            f"{record.record_id} 不含真值（initial.opponents 缺失），无法评测。"
            "评测数据集必须用 ddz simulate 生成。"
        )
    return {p: Counter(hand) for p, hand in record.initial.opponents.items()}


def _truth_hands_at(record: MatchRecord, step: int) -> Mapping[str, Counter[str]]:
    """某个决策点上，两个对手的真实手牌 = 开局手牌 − 他们已出的牌。"""
    truth = _truth_hands(record)
    played: dict[str, list[str]] = {p: [] for p in truth}
    for s in record.steps[:step]:
        if s.action.is_play and s.player in played:
            played[s.player].extend(s.action.cards)
    # 用 Counter 做差：真实手牌 = 开局手牌 − 已出的牌，重复牌要保留张数
    return {p: hand - Counter(played[p]) for p, hand in truth.items()}


def evaluate(
    records: Iterable[MatchRecord],
    n_particles: int = 200,
    seed: int = 0,
    step_stride: int = 1,
) -> tuple[Metrics, Metrics]:
    """返回 (我们的推断, 独立抛硬币基线) 两组指标。"""
    rng = random.Random(seed)
    top1_ours_hits = top1_base_hits = top1_total = 0
    ll_ours: list[float] = []
    ll_base: list[float] = []
    n_positions = n_cards = 0

    for record in records:
        truth = _truth_hands(record)  # 缺真值在这里就炸
        for step in range(0, len(record.steps) + 1, step_stride):
            snapshot = derive(record, steps=record.steps[:step])
            # 终局不是决策点：没有「该谁出牌」，也不该进入位置数或任何计分项。
            if snapshot.finished:
                continue
            truth_at = _truth_hands_at(record, step)
            distribution = sample(snapshot, n_particles=n_particles, seed=seed + step)

            # Top-1 只在「这个点数恰好由一家持有」时定义清晰；两家都有或都不有，
            # 归属不唯一，不计入 Top-1（仍计入对数似然）
            # 先规范化排序再遍历：set 的迭代顺序随 PYTHONHASHSEED 变化，
            # 会让抛硬币的随机流在不同进程里错位 —— 数字就不可复现了。
            for card in normalize(set(snapshot.pool)):
                holders = [p for p, hand in truth_at.items() if hand[card] > 0]
                if len(holders) != 1:
                    continue

                probs = {p: distribution.probability(card, p) for p in distribution.opponents}
                picked = max(probs, key=lambda p: probs[p])
                top1_total += 1
                if card in truth_at[picked]:
                    top1_ours_hits += 1
                # 基线：真的抛硬币（固定种子，保证可复现）。
                # 不能"永远挑第一家"——那报出来的是先验偏差，不是随机猜测。
                picked_base = rng.choice(distribution.opponents)
                if card in truth_at[picked_base]:
                    top1_base_hits += 1

            # 先规范化排序再遍历：set 的迭代顺序随 PYTHONHASHSEED 变化，
            # 会让抛硬币的随机流在不同进程里错位 —— 数字就不可复现了。
            for card in normalize(set(snapshot.pool)):
                for player in distribution.opponents:
                    n_cards += 1
                    ours = min(max(distribution.probability(card, player), 1e-9), 1 - 1e-9)
                    actual = card in truth_at[player]
                    ll_ours.append(math.log(ours if actual else 1 - ours))
                    ll_base.append(math.log(0.5))

            n_positions += 1

    ours = Metrics(
        top1_accuracy=top1_ours_hits / top1_total if top1_total else 0.0,
        top1_n=top1_total,
        log_likelihood=sum(ll_ours) / len(ll_ours) if ll_ours else 0.0,
        n_positions=n_positions,
        n_cards_scored=n_cards,
    )
    baseline = Metrics(
        top1_accuracy=top1_base_hits / top1_total if top1_total else 0.0,
        top1_n=top1_total,
        log_likelihood=sum(ll_base) / len(ll_base) if ll_base else 0.0,
        n_positions=n_positions,
        n_cards_scored=n_cards,
    )
    return ours, baseline
