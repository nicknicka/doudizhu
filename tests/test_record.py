"""记录层：round-trip、自洽性、回放与轮转。"""

from __future__ import annotations

import pytest

from ddz.cards import FULL_DECK
from ddz.record.io import dumps, loads
from ddz.record.schema import Action, Step
from ddz.record.state import _acting_player, derive, replay

FIXTURES = ("landlord", "landlord_up", "landlord_down")


def fixture_path(name: str):
    from pathlib import Path

    return Path(__file__).parent / "data" / f"position_{name}.json"


@pytest.fixture(params=FIXTURES)
def record(request):
    return loads(fixture_path(request.param).read_text(encoding="utf-8"))


class TestRoundTrip:
    def test_text_round_trip_is_exact(self, record):
        """load(dumps(x)) == x —— 这是硬要求。"""
        assert loads(dumps(record)) == record

    def test_round_trip_is_byte_stable(self, record):
        """同一记录两次序列化的字节完全相同。"""
        assert dumps(record) == dumps(loads(dumps(record)))

    def test_disk_round_trip(self, record, tmp_path):
        from ddz.record.io import load, save

        path = tmp_path / "r.json"
        save(record, path)
        assert load(path) == record

    def test_rejects_unknown_schema_version(self, record):
        from ddz.record.schema import MatchRecord

        data = record.to_json()
        data["schema_version"] = 999
        with pytest.raises(ValueError, match="schema_version"):
            MatchRecord.from_json(data)

    def test_rejects_unknown_position(self, record):
        from ddz.record.schema import MatchRecord

        data = record.to_json()
        data["me"] = "spectator"
        with pytest.raises(ValueError, match="未知位置"):
            MatchRecord.from_json(data)


class TestSelfConsistency:
    def test_cards_are_conserved(self, record):
        """我方手牌 + 牌池 + 已出的牌 = 54 张。"""
        snapshot = derive(record)
        played = [c for cards in snapshot.played_cards.values() for c in cards]
        assert len(snapshot.my_hand) + len(snapshot.pool) + len(played) == len(FULL_DECK)

    def test_pool_equals_full_deck_minus_hand_minus_played(self, record):
        """牌池是可推导的：全牌 − 我的手牌 − 已出的牌。"""
        from collections import Counter

        snapshot = derive(record)
        played = [c for cards in snapshot.played_cards.values() for c in cards]
        expected = Counter(FULL_DECK) - Counter(snapshot.my_hand) - Counter(played)
        assert Counter(snapshot.pool) == expected

    def test_num_cards_left_matches_played_counts(self, record):
        snapshot = derive(record)
        for position, played in snapshot.played_cards.items():
            expected = len(record.initial.my_hand) if position == record.me else None
            if expected is not None:
                assert snapshot.num_cards_left[position] == expected - len(played)

    def test_rejects_playing_a_card_we_do_not_hold(self, record):
        bad = record.__class__(
            **{
                **record.__dict__,
                "steps": record.steps
                + (
                    Step(
                        index=len(record.steps),
                        player=record.me,
                        action=Action(kind="play", cards=("R", "R", "R", "R")),
                    ),
                ),
            }
        )
        with pytest.raises(ValueError, match="不自洽"):
            derive(bad)


class TestReplay:
    def test_yields_one_snapshot_per_decision_point(self, record):
        snapshots = list(replay(record))
        assert len(snapshots) == len(record.steps) + 1

    def test_first_snapshot_is_the_opening(self, record):
        first = next(replay(record))
        assert first.acting == "landlord"
        assert first.card_play_action_seq == ()
        assert first.num_cards_left["landlord"] == 20

    def test_last_snapshot_is_where_we_stand(self, record):
        assert list(replay(record))[-1] == derive(record)

    def test_replay_is_read_only(self, record):
        before = dumps(record)
        list(replay(record))
        assert dumps(record) == before


class TestTurnRotation:
    """出手顺序：地主 → 地主下家 → 地主上家 → 回到地主。"""

    def step(self, player: str, kind: str) -> Step:
        action = Action(kind=kind, cards=("3",) if kind == "play" else ())
        return Step(index=0, player=player, action=action)

    def test_landlord_leads_when_no_steps(self):
        assert _acting_player(()) == "landlord"

    def test_play_passes_the_turn_on(self):
        assert _acting_player((self.step("landlord", "play"),)) == "landlord_down"

    def test_one_pass_advances_one_more(self):
        steps = (self.step("landlord", "play"), self.step("landlord_down", "pass"))
        assert _acting_player(steps) == "landlord_up"

    def test_two_passes_return_the_lead(self):
        steps = (
            self.step("landlord", "play"),
            self.step("landlord_down", "pass"),
            self.step("landlord_up", "pass"),
        )
        assert _acting_player(steps) == "landlord"
