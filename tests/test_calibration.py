"""校准：模型说 60%，实际真的 60% 吗？"""

from __future__ import annotations

import pytest

from ddz.cli.main import main
from ddz.evaluation.calibration import (
    SCORE_CAVEAT,
    NotCalibratableError,
    calibrate,
    my_side,
    winner_side,
)
from ddz.policy.douzero import DEFAULT_MODEL_DIR, DouZeroPolicy
from ddz.source import sim

HAS_WEIGHTS = all(
    (DEFAULT_MODEL_DIR / f).exists()
    for f in ("landlord.onnx", "landlord_up.onnx", "landlord_down.onnx")
)
pytestmark = pytest.mark.skipif(not HAS_WEIGHTS, reason="权重未下载")


@pytest.fixture(scope="module")
def records():
    return list(sim.generate(2, seed=6))


class TestWinnerDerivation:
    def test_winner_is_derived_from_the_record(self, records):
        """记录里不存结果，胜负是推出来的（谁先出完谁赢）。"""
        assert winner_side(records[0]) in ("landlord", "peasants")

    def test_my_side_maps_positions_to_sides(self):
        assert my_side("landlord") == "landlord"
        assert my_side("landlord_up") == "peasants"
        assert my_side("landlord_down") == "peasants"


class TestReport:
    def test_buckets_cover_every_sample(self, records):
        report = calibrate(records, DouZeroPolicy(), n_buckets=4, step_stride=22)
        assert report.n_samples > 0
        assert sum(b.n for b in report.buckets) == report.n_samples

    def test_same_inputs_give_the_same_report(self, records):
        a = calibrate(records, DouZeroPolicy(), n_buckets=3, step_stride=22)
        b = calibrate(records, DouZeroPolicy(), n_buckets=3, step_stride=22)
        assert a == b

    def test_gap_is_estimate_minus_actual(self, records):
        report = calibrate(records, DouZeroPolicy(), n_buckets=3, step_stride=22)
        for b in report.buckets:
            assert b.gap == pytest.approx(b.mean_estimate - b.actual_rate)

    def test_rejects_zero_buckets(self, records):
        with pytest.raises(ValueError, match="分桶数"):
            calibrate(records, DouZeroPolicy(), n_buckets=0)

    def test_raises_when_there_is_nothing_to_calibrate(self):
        empty = sim.to_records(sim.play_one_game(1))[0]
        truncated = empty.__class__(**{**empty.__dict__, "steps": ()})
        # 一步不走、谁都还没出完 —— 胜负推不出来
        with pytest.raises(NotCalibratableError):
            calibrate([truncated], DouZeroPolicy(), step_stride=1)


class TestReproducibility:
    def test_numbers_are_identical_across_processes(self, tmp_path):
        """跨进程也必须完全一致。

        项目里已经栽过两次 —— set 的迭代顺序随 PYTHONHASHSEED 变化会让
        RNG 流或遍历顺序错位。这条链路看起来是确定的（legal_actions 排序后返回），
        但"看起来"不算证据，所以照旧用不同哈希种子各跑一次子进程比对。
        """
        import os
        import subprocess
        import sys

        out_dir = tmp_path / "sim"
        subprocess.run([sys.executable, "-m", "ddz", "simulate", "--games", "1",
                        "--seed", "6", "--out-dir", str(out_dir)],
                       check=True, capture_output=True)

        outputs = []
        for hash_seed in ("0", "1", "2"):
            result = subprocess.run(
                [sys.executable, "-m", "ddz", "calibrate", "--in-dir", str(out_dir),
                 "--buckets", "3", "--stride", "40"],
                check=True, capture_output=True, text=True,
                env={**os.environ, "PYTHONHASHSEED": hash_seed},
            )
            outputs.append("\n".join(
                line for line in result.stdout.splitlines() if line.startswith("|")
            ))
        for other in outputs[1:]:
            assert other == outputs[0], "不同进程跑出的校准表不一致"


class TestCaveat:
    def test_the_caveat_names_the_output_as_q_values(self):
        """措辞必须点名"Q 值"和"不是校准胜率" —— 这是给展示者用的。"""
        assert "Q 值" in SCORE_CAVEAT
        assert "不是校准过的胜率" in SCORE_CAVEAT

    def test_cli_always_prints_the_caveat(self, tmp_path, capsys):
        out_dir = tmp_path / "sim"
        main(["simulate", "--games", "1", "--seed", "6", "--out-dir", str(out_dir)])
        capsys.readouterr()

        assert main(["calibrate", "--in-dir", str(out_dir),
                     "--buckets", "3", "--stride", "40"]) == 0
        out = capsys.readouterr().out
        assert SCORE_CAVEAT in out
        assert "估计值区间" in out


class TestObservedCalibration:
    def test_estimates_are_not_calibrated_as_win_probabilities(self, records):
        """把实测结论钉住：**这些 Q 值不能当胜率读**。

        如果不校准得离谱，这条会红 —— 那说明模型换了、或者我们的管线接错了，
        两种情况都值得有人来看一眼。
        """
        report = calibrate(records, DouZeroPolicy(), n_buckets=4, step_stride=4)
        assert report.n_samples > 20
        # 整体偏差大到远超"能当概率用"的程度
        assert abs(report.mean_estimate - report.actual_rate) > 0.3
