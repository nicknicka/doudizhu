"""仿真数据生成：评测真值的唯一来源。"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from ddz.cards import FULL_DECK
from ddz.cli.main import main
from ddz.record.io import load
from ddz.record.schema import TURN_ORDER
from ddz.record.state import derive
from ddz.source import sim


class TestOneGame:
    def test_same_seed_gives_the_same_game(self):
        a, b = sim.play_one_game(7), sim.play_one_game(7)
        assert a == b

    def test_different_seeds_give_different_games(self):
        assert sim.play_one_game(7) != sim.play_one_game(8)

    def test_starting_hands_add_up_to_a_full_deck(self):
        game = sim.play_one_game(7)
        all_cards = [c for hand in game.start_hands.values() for c in hand]
        assert Counter(all_cards) == Counter(FULL_DECK)

    def test_landlord_takes_the_three_landlord_cards(self):
        game = sim.play_one_game(7)
        for card in game.three_landlord_cards:
            assert card in game.start_hands["landlord"]

    def test_the_game_finishes(self):
        game = sim.play_one_game(7)
        assert game.steps, "一局不该一步都没有"
        assert game.steps[-1].index == len(game.steps) - 1


class TestRecords:
    def test_one_game_yields_three_perspectives(self):
        records = sim.to_records(sim.play_one_game(7))
        assert len(records) == 3
        assert {r.me for r in records} == set(TURN_ORDER)

    def test_every_record_carries_the_truth(self):
        """每条记录都要带上另两家的真实开局手牌。"""
        for record in sim.to_records(sim.play_one_game(7)):
            assert record.initial.opponents is not None
            assert set(record.initial.opponents) == set(TURN_ORDER) - {record.me}
            cards = list(record.initial.my_hand)
            for hand in record.initial.opponents.values():
                cards.extend(hand)
            assert Counter(cards) == Counter(FULL_DECK)

    def test_every_decision_point_can_be_derived(self):
        for record in sim.to_records(sim.play_one_game(7)):
            for i in range(len(record.steps) + 1):
                derive(record, steps=record.steps[:i])

    def test_source_is_marked_as_simulation(self):
        for record in sim.to_records(sim.play_one_game(7)):
            assert record.source == "sim"


class TestBatch:
    def test_generate_yields_three_records_per_game(self):
        assert len(list(sim.generate(2, seed=1))) == 6

    def test_rejects_zero_games(self):
        with pytest.raises(ValueError, match="至少为 1"):
            list(sim.generate(0, seed=1))

    def test_same_seed_gives_the_same_batch(self):
        from ddz.record.io import dumps

        assert [dumps(r) for r in sim.generate(2, seed=3)] == [
            dumps(r) for r in sim.generate(2, seed=3)
        ]


class TestCli:
    def test_writes_one_file_per_record(self, tmp_path):
        assert main(["simulate", "--games", "2", "--seed", "1",
                     "--out-dir", str(tmp_path)]) == 0
        assert len(list(tmp_path.glob("*.json"))) == 6

    def test_output_is_reproducible(self, tmp_path):
        first, second = tmp_path / "a", tmp_path / "b"
        main(["simulate", "--games", "1", "--seed", "5", "--out-dir", str(first)])
        main(["simulate", "--games", "1", "--seed", "5", "--out-dir", str(second)])
        left = sorted(p.name for p in first.iterdir())
        assert left == sorted(p.name for p in second.iterdir())
        for name in left:
            assert (first / name).read_bytes() == (second / name).read_bytes()

    def test_written_records_load_and_replay(self, tmp_path):
        main(["simulate", "--games", "1", "--seed", "2", "--out-dir", str(tmp_path)])
        for path in tmp_path.glob("*.json"):
            record = load(path)
            assert record.source == "sim"
            assert len(record.steps) > 0
            derive(record)

    def test_format_matches_the_recorded_path(self, tmp_path):
        """仿真记录与手录记录是同一份格式，键集合完全一样。"""
        main(["simulate", "--games", "1", "--seed", "2", "--out-dir", str(tmp_path)])
        simulated = load(next(tmp_path.glob("*.json")))

        from ddz.source import manual

        fresh = manual.start("landlord_up", "34556789TTJJKK222", "792")
        assert set(simulated.to_json()) == set(fresh.to_json())
