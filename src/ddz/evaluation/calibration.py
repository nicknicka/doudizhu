"""校准：模型说 60%，实际真的发生 60% 吗？

DouZero 的输出是 **Q 值（期望回报）**，不是校准过的胜率。这两者不是一回事：
Q 值可以比较动作之间的优劣，但把它直接当概率读，需要有证据说明它校准得住 ——
这里就是去拿这份证据，或者拿不到就说拿不到。

做法：在每个决策点取模型对**最优动作**的估计，跟"我方最后到底赢没赢"分桶对比。
如果校准良好，每个桶里的平均估计应当接近该桶的实际胜率。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

from ddz.policy.douzero import DouZeroPolicy
from ddz.rules import legal_actions
from ddz.record.schema import MatchRecord, TURN_ORDER
from ddz.record.state import derive

# 必须随任何展示一起出现的措辞。模型输出不是概率，别让读者误会。
SCORE_CAVEAT = "模型输出是 Q 值（期望回报），不是校准过的胜率"


class NotCalibratableError(ValueError):
    """没有可用的胜负结果，校准无从谈起。"""


def winner_side(record: MatchRecord) -> str:
    """谁赢了。记录里不存结果（它能推出来），所以在这里推。"""
    final = derive(record)
    for player, left in final.num_cards_left.items():
        if left == 0:
            return "landlord" if player == "landlord" else "peasants"
    raise NotCalibratableError(f"{record.record_id} 打完了都没人出完牌，记录不完整")


def my_side(me: str) -> str:
    return "landlord" if me == "landlord" else "peasants"


@dataclass(frozen=True)
class Bucket:
    low: float
    high: float
    n: int
    mean_estimate: float
    actual_rate: float

    @property
    def gap(self) -> float:
        return self.mean_estimate - self.actual_rate


@dataclass(frozen=True)
class CalibrationReport:
    buckets: tuple[Bucket, ...]
    n_samples: int
    n_skipped: int
    mean_estimate: float
    actual_rate: float

    def as_table(self) -> str:
        lines = [
            "| 估计值区间 | 样本 | 平均估计 | 实际胜率 | 差 |",
            "|---|---|---|---|---|",
        ]
        for b in self.buckets:
            lines.append(
                f"| [{b.low:+.2f}, {b.high:+.2f}) | {b.n} | {b.mean_estimate:+.3f} "
                f"| {b.actual_rate:.3f} | {b.gap:+.3f} |"
            )
        lines.append(
            f"| **合计** | {self.n_samples} | {self.mean_estimate:+.3f} "
            f"| {self.actual_rate:.3f} | {self.mean_estimate - self.actual_rate:+.3f} |"
        )
        return "\n".join(lines)


def calibrate(
    records: Iterable[MatchRecord],
    policy: DouZeroPolicy,
    n_buckets: int = 5,
    step_stride: int = 3,
) -> CalibrationReport:
    """在每个「轮到我方」的决策点上取模型估计，与最终胜负分桶对比。"""
    if n_buckets < 1:
        raise ValueError("分桶数至少为 1")

    samples: list[tuple[float, int]] = []
    skipped = 0

    for record in records:
        try:
            winner = winner_side(record)
        except NotCalibratableError:
            skipped += 1
            continue
        won = 1 if my_side(record.me) == winner else 0

        for step in range(0, len(record.steps) + 1, step_stride):
            snapshot = derive(record, steps=record.steps[:step])
            if snapshot.acting != record.me:
                continue  # 只评估"我方决策"时的估计
            actions = legal_actions(snapshot)
            if not actions:
                continue
            scores = policy.score(snapshot, actions)
            samples.append((float(max(scores)), won))

    if not samples:
        raise NotCalibratableError("没有采到任何可校准的样本")

    values = [s for s, _ in samples]
    lo, hi = min(values), max(values)
    width = (hi - lo) / n_buckets or 1.0

    buckets: list[Bucket] = []
    for i in range(n_buckets):
        low = lo + i * width
        high = low + width
        # 最后一个桶收右端点，避免最大值被漏掉
        picked = [
            (s, w) for s, w in samples
            if (low <= s < high) or (i == n_buckets - 1 and s == hi)
        ]
        if not picked:
            continue
        buckets.append(
            Bucket(
                low=low,
                high=high,
                n=len(picked),
                mean_estimate=sum(s for s, _ in picked) / len(picked),
                actual_rate=sum(w for _, w in picked) / len(picked),
            )
        )

    return CalibrationReport(
        buckets=tuple(buckets),
        n_samples=len(samples),
        n_skipped=skipped,
        mean_estimate=sum(values) / len(values),
        actual_rate=sum(w for _, w in samples) / len(samples),
    )
