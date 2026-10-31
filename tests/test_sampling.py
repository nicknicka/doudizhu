"""手牌分布：粒子采样。"""

from __future__ import annotations

from collections import Counter
from dataclasses import replace
from pathlib import Path

import pytest

from ddz.cli.main import main
from ddz.inference import opponents_of, sample
from ddz.record.io import load
from ddz.record.state import derive
from ddz.source import sim

FIXTURES = ("landlord", "landlord_up", "landlord_down")


def fixture_path(name: str) -> Path:
    return Path(__file__).parent / "data" / f"position_{name}.json"


@pytest.fixture(params=FIXTURES)
def snapshot(request):
    return derive(load(fixture_path(request.param)))


class TestInvariants:
    def test_particles_never_contain_played_cards(self, snapshot):
        pool = Counter(snapshot.pool)
        for particle in sample(snapshot, n_particles=30, seed=1).particles:
            for hand in particle.hands.values():
                assert not (Counter(hand) - pool), "粒子里出现了池子外的牌"

    def test_hand_sizes_equal_remaining_counts(self, snapshot):
        for particle in sample(snapshot, n_particles=30, seed=1).particles:
            for player, hand in particle.hands.items():
                assert len(hand) == snapshot.num_cards_left[player]

    def test_particles_cover_the_whole_pool(self, snapshot):
        for particle in sample(snapshot, n_particles=30, seed=1).particles:
            all_cards = [c for hand in particle.hands.values() for c in hand]
            assert Counter(all_cards) == Counter(snapshot.pool)

    def test_only_opponents_are_modelled(self, snapshot):
        dist = sample(snapshot, n_particles=10, seed=1)
        assert set(dist.opponents) == set(opponents_of(snapshot))
        assert snapshot.me not in dist.opponents

    def test_rejects_an_inconsistent_record(self, snapshot):
        # 要改就改**对手**的张数：我自己那张改多少都不影响两家的合计
        opponent = opponents_of(snapshot)[0]
        broken = replace(snapshot, num_cards_left={**snapshot.num_cards_left, opponent: 99})
        with pytest.raises(ValueError, match="不自洽"):
            sample(broken, n_particles=5, seed=1)


class TestDeterminism:
    def test_same_seed_gives_the_same_distribution(self, snapshot):
        a = sample(snapshot, n_particles=40, seed=7)
        b = sample(snapshot, n_particles=40, seed=7)
        assert a.particles == b.particles

    def test_different_seeds_give_different_distributions(self, snapshot):
        a = sample(snapshot, n_particles=40, seed=7)
        b = sample(snapshot, n_particles=40, seed=8)
        assert a.particles != b.particles

    def test_rejects_zero_particles(self, snapshot):
        with pytest.raises(ValueError, match="至少为 1"):
            sample(snapshot, n_particles=0, seed=1)


class TestProbabilities:
    def test_single_card_probability_matches_the_analytic_value(self):
        """开局时，某张独一无二的牌落在某家的概率就是「他的手牌数 / 牌池大小」。

        这是唯一能在纯约束下解析算出的对照 —— 用来说明采样没跑偏。
        """
        record = sim.to_records(sim.play_one_game(3))[0]
        snapshot = derive(record)  # 开局
        dist = sample(snapshot, n_particles=4000, seed=11)

        player = dist.opponents[0]
        pool = Counter(snapshot.pool)
        unique = next(c for c, n in pool.items() if n == 1 and c not in snapshot.my_hand)
        expected = snapshot.num_cards_left[player] / len(snapshot.pool)

        assert dist.probability(unique, player) == pytest.approx(expected, abs=0.05)

    def test_probabilities_are_bounded(self, snapshot):
        dist = sample(snapshot, n_particles=50, seed=2)
        for card in set(snapshot.pool):
            for player in dist.opponents:
                assert 0.0 <= dist.probability(card, player) <= 1.0
                assert 0.0 <= dist.expected_count(card, player) <= snapshot.num_cards_left[player]

    def test_expected_counts_sum_to_the_pool(self, snapshot):
        """每张牌在两家的期望张数加起来，必须等于它在池子里的张数。"""
        dist = sample(snapshot, n_particles=50, seed=2)
        for card, copies in Counter(snapshot.pool).items():
            total = sum(dist.expected_count(card, p) for p in dist.opponents)
            assert total == pytest.approx(copies)

    def test_unknown_player_is_rejected(self, snapshot):
        dist = sample(snapshot, n_particles=10, seed=1)
        with pytest.raises(ValueError, match="不是对手之一"):
            dist.probability("K", snapshot.me)


class TestNoSingleAnswer:
    def test_ambiguous_positions_do_not_collapse_to_one_answer(self, snapshot):
        """多个可能并存时，不能只输出一个"确定"的答案。"""
        dist = sample(snapshot, n_particles=100, seed=5)
        ambiguous = [
            c for c in set(snapshot.pool)
            if any(0.0 < dist.probability(c, p) < 1.0 for p in dist.opponents)
        ]
        assert ambiguous, "开局局面不该是唯一确定的"


class TestIgnoresGroundTruth:
    def test_sampling_is_identical_with_and_without_the_truth_field(self):
        full = sim.to_records(sim.play_one_game(13))[0]
        stripped = replace(full, initial=replace(full.initial, opponents=None))
        a = sample(derive(full), n_particles=30, seed=3)
        b = sample(derive(stripped), n_particles=30, seed=3)
        assert a.particles == b.particles

    def test_runs_over_simulated_games_without_violating_invariants(self):
        checked = 0
        for record in sim.generate(2, seed=31):
            for i in range(0, len(record.steps) + 1, 4):
                snapshot = derive(record, steps=record.steps[:i])
                dist = sample(snapshot, n_particles=5, seed=i)
                for particle in dist.particles:
                    for player, hand in particle.hands.items():
                        assert len(hand) == snapshot.num_cards_left[player]
                    all_cards = [c for h in particle.hands.values() for c in h]
                    assert Counter(all_cards) == Counter(snapshot.pool)
                    checked += 1
        assert checked > 50


class TestCli:
    def test_reports_diagnostics_and_probabilities(self, capsys):
        assert main(["infer", "--in", str(fixture_path("landlord_up")),
                     "--particles", "50", "--seed", "0", "--card", "2"]) == 0
        out = capsys.readouterr().out
        assert "采样 50 个粒子" in out
        assert "不同分法" in out
        assert "不用" not in out and "可靠约束" in out

    def test_honours_the_seed(self, capsys):
        args = ["infer", "--in", str(fixture_path("landlord_up")),
                "--particles", "20", "--card", "2"]
        main([*args, "--seed", "4"])
        first = capsys.readouterr().out
        main([*args, "--seed", "4"])
        assert capsys.readouterr().out == first

    def test_rejects_a_bad_particle_count(self, capsys):
        assert main(["infer", "--in", str(fixture_path("landlord_up")),
                     "--particles", "0"]) == 2
