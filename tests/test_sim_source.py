"""仿真数据生成：评测真值的唯一来源。"""

from __future__ import annotations

from collections import Counter
from hashlib import sha256
from pathlib import Path

import pytest

from ddz.cards import FULL_DECK, normalize
from ddz.cli.main import main
from ddz.record.io import dumps, load
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

    def test_seats_follow_the_actual_landlord_id(self, monkeypatch):
        """地主不必是 player 0；席位要由当局实际地主编号推导。"""

        hands = (
            "".join(FULL_DECK[20:37]),
            "".join(FULL_DECK[:20]),
            "".join(FULL_DECK[37:]),
        )
        landlord_cards = "345"

        class StubEnv:
            def __init__(self):
                self.finished = False

            def seed(self, seed):
                pass

            def reset(self):
                state = {
                    "raw_obs": {"landlord": 1, "seen_cards": landlord_cards},
                    "raw_legal_actions": [landlord_cards],
                }
                return state, 1

            def get_perfect_information(self):
                return {"hand_cards": list(hands)}

            def is_over(self):
                return self.finished

            def step(self, action, raw_action=False):
                assert raw_action is True
                assert action == landlord_cards
                self.finished = True
                return {}, 2

        monkeypatch.setattr(sim.rlcard, "make", lambda name: StubEnv())
        game = sim.play_one_game(seed=7)

        assert game.start_hands == {
            "landlord_up": tuple(hands[0]),
            "landlord": tuple(hands[1]),
            "landlord_down": tuple(hands[2]),
        }
        assert game.steps[0].player == "landlord"
        assert all(card in game.start_hands["landlord"] for card in game.three_landlord_cards)

        records = {record.me: record for record in sim.to_records(game)}
        expected_hands = {
            "landlord_up": normalize(tuple(hands[0])),
            "landlord": normalize(tuple(hands[1])),
            "landlord_down": normalize(tuple(hands[2])),
        }
        assert records["landlord"].initial.my_hand == expected_hands["landlord"]
        assert records["landlord_down"].initial.my_hand == expected_hands["landlord_down"]
        assert records["landlord_up"].initial.my_hand == expected_hands["landlord_up"]
        for record in records.values():
            assert record.initial.opponents is not None
            assert set(record.initial.opponents) == set(TURN_ORDER) - {record.me}
            assert record.initial.opponents == {
                pos: hand for pos, hand in expected_hands.items() if pos != record.me
            }

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
        assert [dumps(r) for r in sim.generate(2, seed=3)] == [
            dumps(r) for r in sim.generate(2, seed=3)
        ]

    def test_landlord_zero_output_stays_byte_identical(self):
        expected = {
            7: {
                "landlord": "15cf9c1282bc7051b114a49b8d6e86f686be5786614975dd1a71c6bc0fd4c911",
                "landlord_down": "e4d9e31c88d8762e7fb2ca43e46cc2d51146c7e9916fb2d659b72d109d549d12",
                "landlord_up": "43bca025b8a310bd6099b9eee78ac331b26761e2cd89e7069798835a7985fdaf",
            },
            123: {
                "landlord": "06dc4aafe6ff21b884d63b934a8d69f5ea155eff82d021a4b4f721bd30feb590",
                "landlord_down": "4c462b7b6d14a6c857d8d58d718a6fa3ba68be4795a018b7f242849ab8747535",
                "landlord_up": "d7e00a4661649374e5f8426c5927c47c0390d19f69a1bae92767b645dae371b9",
            },
        }
        actual = {
            seed: {
                record.me: sha256(dumps(record).encode("utf-8")).hexdigest()
                for record in sim.to_records(sim.play_one_game(seed))
            }
            for seed in expected
        }
        assert actual == expected


class TestCli:
    def test_writes_one_file_per_record(self, tmp_path):
        assert main(["simulate", "--games", "2", "--seed", "1",
                     "--out-dir", str(tmp_path)]) == 0
        assert len(list(tmp_path.glob("*.json"))) == 6

    def test_same_seed_is_reproducible_across_processes(self, tmp_path):
        """必须在**不同进程**之间也一致。

        同一进程内重跑测不出这件事：RLCard 的合法动作来自内部 set，
        列表顺序随 PYTHONHASHSEED 变化，直接 random.choice 会让同一个 seed
        在不同进程里走出不同的对局。这里故意用不同的哈希种子各跑一次。
        """
        import os
        import subprocess
        import sys

        runs = []
        for i, hash_seed in enumerate(("0", "1")):
            out_dir = tmp_path / f"run{i}"
            subprocess.run(
                [sys.executable, "-m", "ddz", "simulate", "--games", "2",
                 "--seed", "123", "--out-dir", str(out_dir)],
                check=True, capture_output=True,
                env={**os.environ, "PYTHONHASHSEED": hash_seed},
            )
            runs.append({p.name: p.read_bytes() for p in sorted(out_dir.iterdir())})

        assert runs[0].keys() == runs[1].keys()
        for name in runs[0]:
            assert runs[0][name] == runs[1][name], f"{name} 在两个进程里不一致"

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
