"""校准：模型说 60%，实际真的发生 60% 吗？

DouZero 的输出是 **Q 值（期望回报）**，不是校准过的胜率。这两者不是一回事：
Q 值可以比较动作之间的优劣，但把它直接当概率读，需要有证据说明它校准得住 ——
这里就是去拿这份证据，或者拿不到就说拿不到。

做法：在每个决策点取模型对**最优动作**的估计，跟"我方最后到底赢没赢"分桶对比。
如果校准良好，每个桶里的平均估计应当接近该桶的实际胜率。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from ddz.policy.douzero import DouZeroPolicy
from ddz.rules import legal_actions
from ddz.record.schema import MatchRecord
from ddz.record.state import derive, my_turn_steps

# 必须随任何展示一起出现的措辞。模型输出不是概率，别让读者误会。
SCORE_CAVEAT = "模型输出是 Q 值（期望回报），不是校准过的胜率"


class NotCalibratableError(ValueError):
    """没有可用的胜负结果，校准无从谈起。"""


def winner_side(record: MatchRecord) -> str:
    """谁赢了。记录里不存结果（它能推出来），所以在这里推。"""
    winner = derive(record).winner
    if winner is None:
        raise NotCalibratableError(f"{record.record_id} 打完了都没人出完牌，记录不完整")
    return "landlord" if winner == "landlord" else "peasants"


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

    for record in records:
        try:
            winner = winner_side(record)
        except NotCalibratableError:
            continue  # 结果推不出来的记录直接跳过，不污染样本
        won = 1 if my_side(record.me) == winner else 0

        # stride 作用在**我方自己的决策点序列**上，而不是全局步号。
        # 出手顺序每 3 步轮转一次，全局 stride 取 3 的倍数时永远只命中同一个位置 ——
        # 那样采出来的不是"我方决策的样本"，而是"某个座位的样本"。
        for step in my_turn_steps(record)[::step_stride]:
            snapshot = derive(record, steps=record.steps[:step])
            actions = legal_actions(snapshot)
            if not actions:
                continue
            samples.append((float(max(policy.score(snapshot, actions))), won))

    if not samples:
        raise NotCalibratableError("没有采到任何可校准的样本")

    values = [s for s, _ in samples]
    # 桶界固定为 [-1, 1]：DouZero 的胜负目标是这个量纲，固定界让不同数据集之间
    # 的校准表可以直接比较。用 min/max 动态分桶的话，换个数据集桶界就变了。
    lo, hi = -1.0, 1.0
    width = (hi - lo) / n_buckets

    buckets: list[Bucket] = []
    for i in range(n_buckets):
        low = lo + i * width
        high = low + width
        # 首个桶收左边的一切、末个桶收右边的一切：DouZero 是回归头，
        # 输出可能略微越出 [-1, 1]，不加这两条会有样本被静默丢掉。
        first, last = i == 0, i == n_buckets - 1
        picked = [
            (s, w) for s, w in samples
            if (low <= s < high)
            or (first and s < low)
            or (last and s >= high)
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
        mean_estimate=sum(values) / len(values),
        actual_rate=sum(w for _, w in samples) / len(samples),
    )
