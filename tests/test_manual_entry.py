"""手动录入：一局真实牌局怎么一步步变成记录。"""

from __future__ import annotations

from pathlib import Path

import pytest

from ddz.record.io import load
from ddz.record.schema import Action, TURN_ORDER
from ddz.record.state import derive
from ddz.source import manual
from ddz.source.manual import IllegalEntryError

FIXTURES = ("landlord", "landlord_up", "landlord_down")
HAND_17 = "34556789TTJJKK222"
LANDLORD_CARDS = "792"


def fixture_path(name: str) -> Path:
    return Path(__file__).parent / "data" / f"position_{name}.json"


@pytest.fixture()
def fresh():
    return manual.start(
        "landlord_up", HAND_17, LANDLORD_CARDS,
        record_id="t", created_at="2026-10-31T00:00:00+08:00",
    )


class TestStart:
    def test_accepts_a_valid_opening(self):
        record = manual.start("landlord_up", HAND_17, LANDLORD_CARDS)
        assert len(record.initial.my_hand) == 17
        assert len(record.initial.three_landlord_cards) == 3
        assert record.steps == ()

    def test_rejects_wrong_hand_size(self):
        with pytest.raises(IllegalEntryError, match="开局应有 17 张"):
            manual.start("landlord_up", HAND_17 + "3", LANDLORD_CARDS)

    def test_rejects_unknown_position(self):
        with pytest.raises(IllegalEntryError, match="位置只能是"):
            manual.start("spectator", HAND_17, LANDLORD_CARDS)

    def test_rejects_cards_outside_the_alphabet(self):
        with pytest.raises(ValueError, match="字符表之外"):
            manual.start("landlord_up", HAND_17[:-1] + "Z", LANDLORD_CARDS)

    def test_rejects_too_many_of_one_rank(self):
        """一副牌只有四张 3，五张就是不成立的。"""
        five_threes = "33333" + HAND_17[5:]
        assert len(five_threes) == 17
        with pytest.raises(IllegalEntryError, match="超出全牌数量"):
            manual.start("landlord_up", five_threes, LANDLORD_CARDS)

    def test_landlord_hand_must_contain_the_landlord_cards(self):
        """地主的三张底牌已经在他那 20 张里，不在一块儿就是不成立的。"""
        from ddz.cards import FULL_DECK

        twenty = tuple(c for c in FULL_DECK if c != "R")[:20]  # 不含 R、不含 9
        assert len(twenty) == 20
        with pytest.raises(IllegalEntryError, match="应当在自己手上"):
            manual.start("landlord", twenty, "79R")

    def test_peasant_hand_plus_landlord_cards_cannot_exceed_the_deck(self):
        """农民手牌 + 底牌合计不能超过一副牌。"""
        with pytest.raises(IllegalEntryError, match="合计超出"):
            manual.start("landlord_up", "3333" + HAND_17[4:], "333")

    def test_rejects_wrong_landlord_card_count(self):
        with pytest.raises(IllegalEntryError, match="底牌应为 3 张"):
            manual.start("landlord_up", HAND_17, "79")


class TestAppend:
    def test_records_a_play(self, fresh):
        after = manual.append_step(fresh, "landlord", Action(kind="play", cards=("5",)))
        assert len(after.steps) == 1
        assert after.steps[0].index == 0

    def test_rejects_out_of_turn_player(self, fresh):
        with pytest.raises(IllegalEntryError, match="现在该 landlord 出牌"):
            manual.append_step(fresh, "landlord_up", Action(kind="play", cards=("3",)))

    def test_rejects_an_illegal_play_by_me(self, fresh):
        """轮到我时，牌的合法性按我的手牌严格校验。"""
        record = manual.append_step(fresh, "landlord", Action(kind="play", cards=("5",)))
        record = manual.append_step(record, "landlord_down", Action(kind="pass"))
        assert derive(record).acting == "landlord_up"
        # 手里没有 4 张 3，凑不出炸弹
        with pytest.raises(IllegalEntryError, match="这手不合法"):
            manual.append_step(record, "landlord_up", Action(kind="play", cards=("3", "3", "3", "3")))

    def test_rejects_a_card_that_was_already_played(self, fresh):
        """用大王来测：整副牌只有一张，出掉之后池子里就没有了。"""
        record = manual.append_step(fresh, "landlord", Action(kind="play", cards=("R",)))
        with pytest.raises(IllegalEntryError, match="已经出过"):
            manual.append_step(record, "landlord_down", Action(kind="play", cards=("R",)))

    def test_rejects_a_play_that_cannot_beat_the_last_move(self, fresh):
        record = manual.append_step(fresh, "landlord", Action(kind="play", cards=("2",)))
        with pytest.raises(IllegalEntryError, match="压不过"):
            manual.append_step(record, "landlord_down", Action(kind="play", cards=("3",)))

    def test_rejects_pass_when_leading(self, fresh):
        """领出方不能不要 —— 上一手为空时 pass 不成立。"""
        assert derive(fresh).last_move == ()
        with pytest.raises(IllegalEntryError, match="不能不要"):
            manual.append_step(fresh, "landlord", Action(kind="pass"))

    def test_rejects_a_naive_timestamp(self):
        """created_at 必须带时区，否则跨时区复盘没法还原。"""
        with pytest.raises(IllegalEntryError, match="必须带时区"):
            manual.start("landlord_up", HAND_17, LANDLORD_CARDS,
                         created_at="2026-10-31T00:00:00")

    def test_rejects_a_malformed_timestamp(self):
        with pytest.raises(IllegalEntryError, match="ISO 8601"):
            manual.start("landlord_up", HAND_17, LANDLORD_CARDS, created_at="昨天下午")

    def test_rejects_playing_more_cards_than_remaining(self, fresh):
        """出牌张数不能超过本人剩余张数。

        先把地主的手牌打薄：他一张一张领出，另外两家一直过（每轮 3 手）。
        打到他只剩 4 张时，再让他出一手 5 张的顺子，必须被拒。
        """
        from collections import Counter

        record = fresh
        for _ in range(16):
            card = derive(record).pool[0]
            record = manual.append_step(record, "landlord", Action(kind="play", cards=(card,)))
            record = manual.append_step(record, "landlord_down", Action(kind="pass"))
            record = manual.append_step(record, "landlord_up", Action(kind="pass"))

        remaining = derive(record).num_cards_left["landlord"]
        assert remaining == 4, f"预期地主剩 4 张，实际 {remaining}"

        # 从牌池里找一个五张顺子（牌型合法，但张数超过剩余）
        pool = Counter(derive(record).pool)
        ranks = "3456789TJQKA"
        straight = next(
            ranks[i : i + 5] for i in range(len(ranks) - 4)
            if all(pool[r] >= 1 for r in ranks[i : i + 5])
        )
        with pytest.raises(IllegalEntryError, match="只剩"):
            manual.append_step(
                record, "landlord", Action(kind="play", cards=tuple(straight))
            )

    def test_rejects_an_unknown_card_type(self, fresh):
        with pytest.raises(IllegalEntryError, match="不是合法牌型"):
            manual.append_step(fresh, "landlord", Action(kind="play", cards=("3", "4", "6")))


class TestUndoAndTruncate:
    def test_undo_drops_the_last_step(self, fresh):
        record = manual.append_step(fresh, "landlord", Action(kind="play", cards=("5",)))
        assert manual.undo(record).steps == ()

    def test_undo_on_empty_is_rejected(self, fresh):
        with pytest.raises(IllegalEntryError, match="无法撤销"):
            manual.undo(fresh)

    def test_truncate_keeps_a_prefix(self, fresh):
        record = manual.append_step(fresh, "landlord", Action(kind="play", cards=("5",)))
        record = manual.append_step(record, "landlord_down", Action(kind="pass"))
        assert len(manual.truncate(record, 1).steps) == 1
        assert len(manual.truncate(record, 0).steps) == 0

    def test_truncate_out_of_range_is_rejected(self, fresh):
        with pytest.raises(IllegalEntryError, match="步号要在"):
            manual.truncate(fresh, 5)


class TestFormatIdentity:
    """手动录入产出的记录必须与仿真记录**完全同构**，不引入第二套格式。"""

    @pytest.mark.parametrize("name", FIXTURES)
    def test_rebuilding_the_fixture_gives_an_identical_record(self, name):
        original = load(fixture_path(name))
        rebuilt = manual.start(
            original.me,
            original.initial.my_hand,
            original.initial.three_landlord_cards,
            record_id=original.record_id,
            created_at=original.created_at,
            source=original.source,
        )
        for step in original.steps:
            rebuilt = manual.append_step(rebuilt, step.player, step.action)
        assert rebuilt == original

    def test_json_keys_match_the_simulated_fixture(self):
        original = load(fixture_path("landlord_up"))
        manual_record = manual.start(
            original.me, original.initial.my_hand, original.initial.three_landlord_cards
        )
        assert set(manual_record.to_json()) == set(original.to_json())


def test_turn_order_constant_covers_all_positions():
    assert set(TURN_ORDER) == {"landlord", "landlord_down", "landlord_up"}
