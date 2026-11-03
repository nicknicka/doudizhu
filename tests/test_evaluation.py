"""评测：把推断质量变成可复现的数字。"""

from __future__ import annotations

import math
from dataclasses import replace
from pathlib import Path

import pytest

from ddz.cli.main import main
from ddz.evaluation import MissingGroundTruthError, evaluate
from ddz.evaluation.metrics import _truth_hands_at
from ddz.record.io import load, save
from ddz.record.schema import Initial, MatchRecord
from ddz.record.state import derive
from ddz.source import manual, sim


@pytest.fixture(scope="module")
def records(tmp_path_factory) -> list:
    return list(sim.generate(2, seed=17))


class TestGroundTruthIsMandatory:
    def test_missing_truth_raises_instead_of_guessing(self, records):
        """没有真值就必须明确报错，绝不能当成空手牌算出一个错误指标。"""
        stripped = replace(records[0], initial=replace(records[0].initial, opponents=None))
        with pytest.raises(MissingGroundTruthError, match="不含真值"):
            evaluate([stripped], n_particles=5, seed=0)

    def test_manually_recorded_games_cannot_be_evaluated(self, tmp_path):
        """手录的真实牌局没有真值，同样不能评测。"""
        record = manual.start("landlord_up", "34556789TTJJKK222", "792")
        with pytest.raises(MissingGroundTruthError):
            evaluate([record], n_particles=5, seed=0)


class TestMetrics:
    def test_same_parameters_give_identical_numbers(self, records):
        a = evaluate(records, n_particles=20, seed=3, step_stride=3)
        b = evaluate(records, n_particles=20, seed=3, step_stride=3)
        assert a == b

    def test_numbers_are_identical_across_processes(self, tmp_path):
        """必须在**不同进程**之间也完全一致。

        同一进程内重跑测不出这件事：`set` 的迭代顺序随 PYTHONHASHSEED 变化，
        会让抛硬币的随机流错位，基线数字跟着漂。这里故意用不同的哈希种子跑。
        """
        import os
        import subprocess
        import sys

        out_dir = tmp_path / "sim"
        subprocess.run([sys.executable, "-m", "ddz", "simulate", "--games", "1",
                        "--seed", "9", "--out-dir", str(out_dir)],
                       check=True, capture_output=True)

        outputs = []
        for hash_seed in ("0", "1", "2"):
            result = subprocess.run(
                [sys.executable, "-m", "ddz", "evaluate", "--in-dir", str(out_dir),
                 "--particles", "20", "--seed", "0", "--stride", "9"],
                check=True, capture_output=True, text=True,
                env={**os.environ, "PYTHONHASHSEED": hash_seed},
            )
            body = "\n".join(
                line for line in result.stdout.splitlines()
                if line.startswith("| ") and "方案" not in line
            )
            outputs.append(body)

        assert len(outputs) == 3
        for other in outputs[1:]:
            assert other == outputs[0], "不同进程跑出的指标不一致"

    def test_different_seed_still_lands_close(self, records):
        a, _ = evaluate(records, n_particles=400, seed=1, step_stride=4)
        b, _ = evaluate(records, n_particles=400, seed=2, step_stride=4)
        assert abs(a.top1_accuracy - b.top1_accuracy) < 0.1

    def test_baseline_log_likelihood_is_log_half(self, records):
        """独立抛硬币的对数似然必须正好是 log(0.5) —— 算法跑偏的话这条会红。"""
        _, baseline = evaluate(records, n_particles=20, seed=0, step_stride=4)
        assert baseline.log_likelihood == pytest.approx(math.log(0.5))

    def test_baseline_top1_is_about_a_coin_flip(self, records):
        _, baseline = evaluate(records, n_particles=20, seed=0, step_stride=1)
        assert 0.4 <= baseline.top1_accuracy <= 0.6

    def test_our_inference_beats_the_coin_flip(self, records):
        ours, baseline = evaluate(records, n_particles=300, seed=5, step_stride=2)
        assert ours.log_likelihood > baseline.log_likelihood
        assert ours.top1_accuracy > baseline.top1_accuracy

    def test_metrics_are_bounded(self, records):
        ours, baseline = evaluate(records, n_particles=20, seed=0, step_stride=5)
        for m in (ours, baseline):
            assert 0.0 <= m.top1_accuracy <= 1.0
            assert m.log_likelihood <= 0.0
            assert m.n_positions > 0 and m.n_cards_scored > 0

    def test_top1_only_scores_a_rank_held_by_exactly_one_opponent(self):
        """某点数被两家拆分时归属不唯一，不能因一家只有一张就计入 Top-1。"""
        landlord = tuple("33444477778888KKKKBR")
        landlord_up = tuple("355559999TTTTAAAA")
        me = tuple("36666JJJJQQQQ2222")
        record = MatchRecord(
            record_id="split-rank",
            source="sim",
            created_at="2026-01-01T00:00:00+08:00",
            me="landlord_down",
            initial=Initial(
                my_hand=me,
                three_landlord_cards=("K", "K", "B"),
                opponents={"landlord": landlord, "landlord_up": landlord_up},
            ),
        )

        truth = _truth_hands_at(record, 0)
        assert truth["landlord"]["3"] == 2
        assert truth["landlord_up"]["3"] == 1

        ours, _ = evaluate([record], n_particles=20, seed=0)
        # 两个对手手上、归属唯一的不同点数：4/5/7/8/9/T/K/A/B/R，共 10 个。
        # 3 被两家拆分，6/J/Q/2 只在我方，都不该计入。
        assert ours.top1_n == 10

    def test_documented_dataset_excludes_its_three_terminal_samples(self):
        """README/展示页的 10 局口径：633 个采样点里 3 个终局，只计 630 个。"""
        records = list(sim.generate(10, seed=0))
        sampled = [
            (record, step)
            for record in records
            for step in range(0, len(record.steps) + 1, 3)
        ]
        terminal = [
            (record, step) for record, step in sampled
            if derive(record, steps=record.steps[:step]).finished
        ]
        assert len(sampled) == 633
        assert len(terminal) == 3

        ours, baseline = evaluate(records, n_particles=200, seed=0, step_stride=3)
        assert ours.n_positions == 630
        assert ours.n_cards_scored == baseline.n_cards_scored == 11716
        assert ours.top1_n == baseline.top1_n == 3780

    def test_final_terminal_sample_is_not_a_decision_position(self):
        """最后一个采样点恰好是终局时，整个终局不能贡献任何指标。"""
        record = next(
            r for r in sim.generate(1, seed=6) if r.me == "landlord_down"
        )
        final_step = len(record.steps)
        assert final_step % 3 == 0
        assert derive(record).finished

        full, _ = evaluate([record], n_particles=20, seed=0, step_stride=3)
        before_terminal, _ = evaluate(
            [record.upto(final_step - 1)], n_particles=20, seed=0, step_stride=3
        )
        assert full == before_terminal

    def test_both_sides_are_scored_on_the_same_items(self, records):
        """两行必须覆盖同样的题量，否则没法并列比较。"""
        ours, baseline = evaluate(records, n_particles=20, seed=0, step_stride=5)
        assert ours.n_cards_scored == baseline.n_cards_scored
        assert ours.top1_n == baseline.top1_n


class TestCli:
    def test_prints_the_two_row_table(self, tmp_path, capsys):
        out_dir = tmp_path / "sim"
        main(["simulate", "--games", "1", "--seed", "4", "--out-dir", str(out_dir)])
        capsys.readouterr()

        assert main(["evaluate", "--in-dir", str(out_dir),
                     "--particles", "20", "--seed", "0", "--stride", "9"]) == 0
        out = capsys.readouterr().out
        assert "| 方案 | Top-1 命中率 | 对数似然 | 计分项 |" in out
        assert "我们的推断" in out and "独立抛硬币基线" in out
        assert "参数：" in out and "20 个粒子" in out
        assert "覆盖 " in out and "个决策点（终局不计）" in out
        assert "633" not in out

    def test_rejects_a_directory_without_records(self, tmp_path, capsys):
        assert main(["evaluate", "--in-dir", str(tmp_path)]) == 2
        assert "没有记录文件" in capsys.readouterr().err

    def test_refuses_records_without_truth(self, tmp_path, capsys):
        """目录里放的是手录的真实牌局时，必须明确拒绝。"""
        record = manual.start("landlord_up", "34556789TTJJKK222", "792")
        save(record, tmp_path / "real.json")
        assert main(["evaluate", "--in-dir", str(tmp_path)]) == 2
        assert "不含真值" in capsys.readouterr().err
