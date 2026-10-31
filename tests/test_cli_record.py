"""命令行录入流程：new → play → undo → show。"""

from __future__ import annotations

from pathlib import Path

import pytest

from ddz.cli.main import main
from ddz.policy.douzero import DEFAULT_MODEL_DIR
from ddz.record.io import load
from ddz.record.state import derive

HAND_17 = "34556789TTJJKK222"
HAS_WEIGHTS = all((DEFAULT_MODEL_DIR / f).exists() for f in
                  ("landlord.onnx", "landlord_up.onnx", "landlord_down.onnx"))


def new_record(tmp_path: Path) -> Path:
    out = tmp_path / "r.json"
    assert main([
        "new", "--me", "landlord_up", "--hand", HAND_17, "--landlord-cards", "792",
        "--record-id", "t", "--created-at", "2026-10-31T00:00:00+08:00",
        "--out", str(out),
    ]) == 0
    return out


def test_new_creates_a_loadable_record(tmp_path):
    record = load(new_record(tmp_path))
    assert record.me == "landlord_up"
    assert len(record.initial.my_hand) == 17


def test_new_rejects_a_bad_hand(tmp_path):
    assert main([
        "new", "--me", "landlord_up", "--hand", HAND_17 + "3", "--landlord-cards", "792",
        "--out", str(tmp_path / "x.json"),
    ]) == 2


def test_play_appends_a_step(tmp_path):
    path = new_record(tmp_path)
    assert main(["play", "--in", str(path), "--out", str(path),
                 "--player", "landlord", "--cards", "5"]) == 0
    assert len(load(path).steps) == 1


def test_play_records_a_pass(tmp_path):
    path = new_record(tmp_path)
    main(["play", "--in", str(path), "--out", str(path), "--player", "landlord", "--cards", "5"])
    assert main(["play", "--in", str(path), "--out", str(path),
                 "--player", "landlord_down", "--pass"]) == 0
    assert load(path).steps[-1].action.is_pass


def test_play_rejects_an_out_of_turn_entry(tmp_path):
    path = new_record(tmp_path)
    assert main(["play", "--in", str(path), "--out", str(tmp_path / "o.json"),
                 "--player", "landlord_up", "--cards", "3"]) == 2


def test_play_rejects_an_illegal_card(tmp_path):
    path = new_record(tmp_path)
    assert main(["play", "--in", str(path), "--out", str(tmp_path / "o.json"),
                 "--player", "landlord", "--cards", "ZZ"]) == 2


def test_undo_removes_the_last_step(tmp_path):
    path = new_record(tmp_path)
    main(["play", "--in", str(path), "--out", str(path), "--player", "landlord", "--cards", "5"])
    assert main(["undo", "--in", str(path), "--out", str(path)]) == 0
    assert load(path).steps == ()


def test_undo_on_empty_record_is_rejected(tmp_path):
    path = new_record(tmp_path)
    assert main(["undo", "--in", str(path), "--out", str(tmp_path / "o.json")]) == 2


def test_show_prints_the_position(tmp_path, capsys):
    path = new_record(tmp_path)
    assert main(["show", "--in", str(path)]) == 0
    out = capsys.readouterr().out
    assert "landlord_up" in out
    assert "牌池" in out


@pytest.mark.skipif(not HAS_WEIGHTS, reason="权重未下载")
def test_play_can_suggest_right_after_entry(tmp_path, capsys):
    """录完之后如果轮到我方，可以直接拿到建议。"""
    path = new_record(tmp_path)
    main(["play", "--in", str(path), "--out", str(path), "--player", "landlord", "--cards", "5"])
    # 地主出一手、下家一过，就轮到我方了；这一步录完直接要建议
    assert main(["play", "--in", str(path), "--out", str(path),
                 "--player", "landlord_down", "--pass", "--suggest"]) == 0
    out = capsys.readouterr().out
    assert "估计" in out
    assert derive(load(path)).acting == "landlord_up"


@pytest.mark.skipif(not HAS_WEIGHTS, reason="权重未下载")
def test_show_suggest_only_when_it_is_our_turn(tmp_path, capsys):
    path = new_record(tmp_path)
    main(["play", "--in", str(path), "--out", str(path), "--player", "landlord", "--cards", "5"])
    assert main(["show", "--in", str(path), "--suggest"]) == 0
    assert "不是我方" in capsys.readouterr().out
