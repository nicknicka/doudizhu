"""可能性判定：某张牌可能在谁手上。

这里守的是**底线**：所有结论都必须能从公开信息证成，一条都不能靠猜。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ddz.cards import FULL_DECK_COUNTS
from ddz.cli.main import main
from ddz.inference import bounds_for, unseen_copies
from ddz.record.io import load
from ddz.record.schema import TURN_ORDER, Initial, MatchRecord
from ddz.record.state import Snapshot, derive
from ddz.source import manual, sim

FIXTURES = ("landlord", "landlord_up", "landlord_down")


def fixture_path(name: str) -> Path:
    return Path(__file__).parent / "data" / f"position_{name}.json"


@pytest.fixture(params=FIXTURES)
def snapshot(request) -> Snapshot:
    return derive(load(fixture_path(request.param)))


def empty_snapshot(**overrides) -> Snapshot:
    base = dict(
        acting="landlord",
        me="landlord_up",
        my_hand=(),
        pool=(),
        played_cards={p: () for p in TURN_ORDER},
        num_cards_left={p: 0 for p in TURN_ORDER},
        last_move=(),
        last_move_dict={p: () for p in TURN_ORDER},
        card_play_action_seq=(),
        bomb_num=0,
    )
    return Snapshot(**{**base, **overrides})


class TestBaselines:
    def test_a_card_i_hold_is_never_in_anyones_hand(self, snapshot):
        """我手上的牌，未现身数是 0，所以谁都不可能有。"""
        for card in snapshot.my_hand:
            assert unseen_copies(snapshot, card) < FULL_DECK_COUNTS[card]

    def test_already_played_cards_are_impossible_for_everyone(self):
        """地主出的 777，加上我手上那张 7，四张已齐 —— 谁都不可能有 7。"""
        state = derive(load(fixture_path("landlord_up")))
        assert unseen_copies(state, "7") == 0
        assert all(b.impossible for b in bounds_for(state, "7").values())

    def test_a_player_who_ran_out_holds_nothing(self):
        state = empty_snapshot(
            pool=("K", "K"),
            num_cards_left={"landlord": 2, "landlord_down": 0, "landlord_up": 0},
        )
        assert bounds_for(state, "K")["landlord_down"].impossible


    def test_my_own_position_is_not_reported(self):
        """我手上有什么我自己知道，判定不该给"我自己"一行。"""
        state = empty_snapshot(my_hand=("K", "K", "K"), pool=("K",))
        assert set(bounds_for(state, "K")) == {"landlord", "landlord_down"}

    def test_unknown_card_is_rejected(self, snapshot):
        with pytest.raises(ValueError, match="字符表之外"):
            unseen_copies(snapshot, "Z")


class TestPigeonhole:
    def test_lower_bound_when_others_cannot_carry_them_all(self):
        """三张 K 未现身，另外两家各只剩 1 张牌 —— 剩下那张必然在我这儿。

        这是鸽笼，不是猜测：牌不会凭空消失。
        """
        # 自洽：我方 1 张 + 牌池 3 张 = 这局还剩 4 张；两家手上合计必须是 3 张
        state = empty_snapshot(
            my_hand=("K",),
            pool=("K", "K", "K"),
            num_cards_left={"landlord": 1, "landlord_down": 2, "landlord_up": 1},
        )
        assert unseen_copies(state, "K") == 3
        verdicts = bounds_for(state, "K")

        # 下家只剩 2 张，容不下全部三张 —— 地主必然至少拿 1 张
        assert verdicts["landlord"].low == 1
        assert verdicts["landlord"].certain
        # 地主只剩 1 张，容不下三张 —— 下家必然至少拿 2 张
        assert verdicts["landlord_down"].low == 2
        assert verdicts["landlord_down"].certain
        # 上限也由剩余张数卡住：两家加起来正好分完三张
        assert verdicts["landlord"].high == 1
        assert verdicts["landlord_down"].high == 2

    def test_no_lower_bound_when_others_have_room(self, snapshot):
        for bound in bounds_for(snapshot, "2").values():
            assert bound.low == 0


class TestBoundsAreConsistent:
    def test_low_never_exceeds_high(self, snapshot):
        for card in FULL_DECK_COUNTS:
            for bound in bounds_for(snapshot, card).values():
                assert 0 <= bound.low <= bound.high

    def test_high_respects_unseen_and_hand_size(self, snapshot):
        for card in FULL_DECK_COUNTS:
            unseen = unseen_copies(snapshot, card)
            for player, bound in bounds_for(snapshot, card).items():
                assert bound.high <= min(unseen, snapshot.num_cards_left[player])

    def test_every_reason_is_present(self, snapshot):
        for bound in bounds_for(snapshot, "2").values():
            assert bound.reasons, "每个结论都要给得出理由"


class TestIgnoresGroundTruth:
    def test_verdicts_are_identical_with_and_without_the_truth_field(self):
        """记录里带上对手真值，判定结果必须**一字不差**。

        这是"不读真值"的结构性证明：`derive` 根本不碰 `initial.opponents`。
        """
        game = sim.play_one_game(11)
        full = sim.to_records(game)[0]
        stripped = MatchRecord(
            **{
                **full.__dict__,
                "initial": Initial(
                    my_hand=full.initial.my_hand,
                    three_landlord_cards=full.initial.three_landlord_cards,
                    opponents=None,
                ),
            }
        )
        assert stripped.initial.opponents is None

        for cards in ((), full.steps):
            a = bounds_for(derive(full, steps=cards), "K")
            b = bounds_for(derive(stripped, steps=cards), "K")
            assert a == b


class TestAcrossSimulatedGames:
    def test_no_baseline_is_ever_violated(self):
        """在批量仿真局上跑一遍，底线一条都不许破。"""
        checked = 0
        for record in sim.generate(3, seed=21):
            for i in range(len(record.steps) + 1):
                state = derive(record, steps=record.steps[:i])
                for card in FULL_DECK_COUNTS:
                    unseen = unseen_copies(state, card)
                    if not 0 <= unseen <= FULL_DECK_COUNTS[card]:
                        raise AssertionError(f"未现身数不合理：{card} -> {unseen}")
                    verdicts = bounds_for(state, card)
                    for player, bound in verdicts.items():
                        # 出完牌的人手上什么都不会有
                        if state.num_cards_left[player] == 0:
                            assert bound.impossible, (record.record_id, i, card, player)
                        # 已无未现身的牌，谁都不可能有
                        if unseen == 0:
                            assert bound.impossible, (record.record_id, i, card, player)
                        assert bound.low <= bound.high
                    checked += 1
        assert checked > 100, "样本太少，说明批量生成没跑起来"


class TestCli:
    def test_lists_every_position(self, tmp_path, capsys):
        assert main(["who", "--in", str(fixture_path("landlord_up")), "--card", "2"]) == 0
        out = capsys.readouterr().out
        for player in ("landlord", "landlord_down"):
            assert player in out
        assert "landlord_up" not in out, "不该列出我方"
        assert "不读真值" in out

    def test_reports_an_impossible_card(self, capsys):
        assert main(["who", "--in", str(fixture_path("landlord_up")), "--card", "7"]) == 0
        assert "不可能" in capsys.readouterr().out

    def test_rejects_a_bad_card(self, capsys):
        assert main(["who", "--in", str(fixture_path("landlord_up")), "--card", "Z"]) == 2

    def test_honours_step(self, capsys):
        assert main(["who", "--in", str(fixture_path("landlord_up")),
                     "--card", "R", "--step", "0"]) == 0
        assert "还有 1 张没现身" in capsys.readouterr().out
