"""记录回放：只凭记录文件重建任意决策点的局面。"""

from __future__ import annotations

from pathlib import Path

import pytest

from ddz.cli.main import main
from ddz.record.io import load
from ddz.record.state import derive

FIXTURES = ("landlord", "landlord_up", "landlord_down")
HAND_17 = "34556789TTJJKK222"


def fixture_path(name: str) -> Path:
    return Path(__file__).parent / "data" / f"position_{name}.json"


@pytest.fixture(params=FIXTURES)
def fixture(request) -> Path:
    return fixture_path(request.param)


def build_real_record(tmp_path: Path) -> Path:
    """用录入路径造一份真实牌局记录。"""
    path = tmp_path / "real.json"
    assert main([
        "new", "--me", "landlord_up", "--hand", HAND_17, "--landlord-cards", "792",
        "--record-id", "real-1", "--created-at", "2026-10-31T00:00:00+08:00",
        "--out", str(path),
    ]) == 0
    main(["play", "--in", str(path), "--out", str(path), "--player", "landlord", "--cards", "777"])
    main(["play", "--in", str(path), "--out", str(path), "--player", "landlord_down", "--pass"])
    return path


class TestReplayByStep:
    def test_every_step_names_the_right_actor(self, fixture, capsys):
        """逐个决策点回放，每一步报出的行动方都要与推导一致。"""
        record = load(fixture)
        for step in range(len(record.steps) + 1):
            expected = derive(record, steps=record.steps[:step]).acting
            capsys.readouterr()
            assert main(["show", "--in", str(fixture), "--step", str(step)]) == 0
            assert f"现在该 {expected} 行动" in capsys.readouterr().out

    def test_step_zero_is_the_opening(self, fixture, capsys):
        main(["show", "--in", str(fixture), "--step", "0"])
        out = capsys.readouterr().out
        assert "【开局】" in out
        assert "各家已出：landlord=—" in out

    def test_output_carries_everything_the_ticket_asks_for(self, fixture, capsys):
        """重建结果要包含：各家剩余张数、已出牌、最后一手、该谁出。"""
        # landlord fixture 是 0 步，所以取实际存在的最后一步
        step = len(load(fixture).steps)
        main(["show", "--in", str(fixture), "--step", str(step)])
        out = capsys.readouterr().out
        assert "各家剩余：" in out
        assert "各家已出：" in out
        assert "上一手：" in out
        assert "现在该 " in out and " 行动" in out

    def test_same_step_twice_gives_identical_output(self, fixture, capsys):
        main(["show", "--in", str(fixture), "--step", "1"])
        first = capsys.readouterr().out
        main(["show", "--in", str(fixture), "--step", "1"])
        assert capsys.readouterr().out == first

    def test_out_of_range_step_is_rejected(self, fixture, capsys):
        record = load(fixture)
        assert main(["show", "--in", str(fixture), "--step", str(len(record.steps) + 1)]) == 2
        assert "步号要在" in capsys.readouterr().err

    def test_negative_step_is_rejected(self, fixture):
        assert main(["show", "--in", str(fixture), "--step", "-1"]) == 2


class TestReadOnly:
    def test_replay_does_not_modify_the_file(self, fixture, capsys):
        before = fixture.read_bytes()
        for step in range(3):
            main(["show", "--in", str(fixture), "--step", str(step)])
        assert fixture.read_bytes() == before

    def test_replay_leaves_no_side_files(self, fixture, capsys):
        """要看**输入文件所在的那个目录**有没有多出东西，而不是临时目录。"""
        directory = fixture.parent
        before = sorted(p.name for p in directory.iterdir())
        main(["show", "--in", str(fixture), "--step", "0"])
        assert sorted(p.name for p in directory.iterdir()) == before


class TestRealAndSimulatedAgree:
    """同一套行为要同时适用于仿真记录与真实录入的记录。"""

    def test_replays_a_manually_recorded_game(self, tmp_path, capsys):
        path = build_real_record(tmp_path)
        assert main(["show", "--in", str(path), "--step", "0"]) == 0
        out = capsys.readouterr().out
        assert "（real）" in out
        assert "现在该 landlord 行动" in out

        assert main(["show", "--in", str(path), "--step", "2"]) == 0
        out = capsys.readouterr().out
        assert "现在该 landlord_up 行动" in out
        assert "landlord=777" in out

    def test_actor_sequence_is_pinned_independently(self, capsys):
        """把行动方序列**写死**在测试里，作为独立于 derive 的对照。

        期望值是照着 fixture 的 steps 手算的（地主出 → 下家 → 上家），
        不是调用被测代码算出来的 —— 否则就是同源断言。
        """
        path = fixture_path("landlord_up")
        expected = ["landlord", "landlord_down", "landlord_up"]
        for step, actor in enumerate(expected):
            capsys.readouterr()
            assert main(["show", "--in", str(path), "--step", str(step)]) == 0
            assert f"现在该 {actor} 行动" in capsys.readouterr().out

    def test_actor_agrees_with_derivation_for_both_record_kinds(self, fixture, tmp_path, capsys):
        """仿真记录与真实记录，报出的行动方都必须与同一套推导一致。"""
        for path in (fixture, build_real_record(tmp_path)):
            record = load(path)
            for step in range(len(record.steps) + 1):
                expected = derive(record, steps=record.steps[:step]).acting
                capsys.readouterr()
                assert main(["show", "--in", str(path), "--step", str(step)]) == 0
                assert f"现在该 {expected} 行动" in capsys.readouterr().out
