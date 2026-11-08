"""README 里的数字必须能被仓库里的命令复现（#82）。

漂过一次：校准表写 498 个样本，实跑 490。这里把两张表的**计数**钉在实跑值上 ——
计数是确定的，不像模型估计值那样受浮点实现影响。

不是证明，是一道便宜的门：改了影响计数的代码却不更新 README，这里就会红。
README 里那句「预期结果：N passed」**不设守卫** —— 它每加一条测试就得改，
守起来只会制造来回改两次的churn。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from ddz.evaluation import evaluate
from ddz.evaluation.calibration import calibrate
from ddz.policy.douzero import DEFAULT_MODEL_DIR, DouZeroPolicy
from ddz.source import sim

README = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")

HAS_WEIGHTS = all(
    (DEFAULT_MODEL_DIR / name).exists()
    for name in ("landlord.onnx", "landlord_up.onnx", "landlord_down.onnx")
)


def test_evaluation_table_counts_match_the_readme():
    """README「评测推断质量」那张表：10 局 · 200 粒子 · stride 3。"""
    ours, baseline = evaluate(
        list(sim.generate(10, seed=0)), n_particles=200, seed=0, step_stride=3
    )
    assert ours.n_positions == 630
    assert ours.n_cards_scored == baseline.n_cards_scored == 11716
    assert ours.top1_n == baseline.top1_n == 3780
    for n in (ours.n_cards_scored, ours.top1_n):
        assert str(n) in README, f"README 的评测表里找不到 {n}，该对账了"


@pytest.mark.skipif(not HAS_WEIGHTS, reason="权重未下载")
def test_calibration_total_matches_the_readme():
    """README「校准」那张表：8 局 · 5 桶 · stride 1。"""
    report = calibrate(
        list(sim.generate(8, seed=0)), DouZeroPolicy(), n_buckets=5, step_stride=1
    )
    assert report.n_samples == sum(bucket.n for bucket in report.buckets)
    found = re.search(r"\|\s*\*\*合计\*\*\s*\|\s*(\d+)\s*\|", README)
    assert found, "README 的校准表里找不到「合计」行"
    assert int(found.group(1)) == report.n_samples, "README 的校准样本数该对账了"
