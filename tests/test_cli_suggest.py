"""端到端：一个局面文件进，一个带建议的记录文件出。

这是本项目约定的**唯一 seam**，所有对外行为都应该挂在这里。
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from ddz.cli.main import main
from ddz.policy.douzero import DEFAULT_MODEL_DIR
from ddz.record.io import load
from ddz.record.schema import Action, Step
from ddz.record.state import derive

FIXTURES = ("landlord", "landlord_up", "landlord_down")
HAS_WEIGHTS = all((DEFAULT_MODEL_DIR / f).exists() for f in
                  ("landlord.onnx", "landlord_up.onnx", "landlord_down.onnx"))
pytestmark = pytest.mark.skipif(not HAS_WEIGHTS, reason="权重未下载，先跑 scripts/download_models.py")


def fixture_path(name: str) -> Path:
    return Path(__file__).parent / "data" / f"position_{name}.json"


@pytest.fixture(params=FIXTURES)
def fixture(request) -> Path:
    return fixture_path(request.param)


def run_suggest(source: Path, out: Path, *extra: str) -> int:
    return main(["suggest", "--in", str(source), "--out", str(out), *extra])


class TestSuggest:
    def test_produces_candidates_for_every_position(self, fixture, tmp_path):
        out = tmp_path / "advice.json"
        assert run_suggest(fixture, out) == 0

        result = load(out)
        assert len(result.advice) == 1
        advice = result.advice[0]
        assert advice.position == result.me
        assert 1 <= len(advice.candidates) <= 3

    def test_candidates_are_sorted_by_score_descending(self, fixture, tmp_path):
        out = tmp_path / "advice.json"
        run_suggest(fixture, out)
        scores = [c.score for c in load(out).advice[0].candidates]
        assert scores == sorted(scores, reverse=True)

    def test_candidates_are_legal(self, fixture, tmp_path):
        """候选只包含规则允许的动作，且用到的牌都在手牌里。"""
        out = tmp_path / "advice.json"
        run_suggest(fixture, out)

        result = load(out)
        snapshot = derive(result)
        hand = Counter(snapshot.my_hand)

        for candidate in result.advice[0].candidates:
            if candidate.action.kind == "pass":
                continue
            used = Counter(candidate.action.cards)
            assert not (used - hand), f"候选用了手上没有的牌：{candidate.action.cards}"

    def test_marks_scores_as_model_estimates(self, fixture, tmp_path):
        """必须写明这不是真实胜率。"""
        out = tmp_path / "advice.json"
        run_suggest(fixture, out)
        advice = load(out).advice[0]
        assert "不是真实胜率" in advice.note
        assert "Q 值" in advice.diagnostics["score_kind"]

    def test_reports_diagnostics(self, fixture, tmp_path):
        out = tmp_path / "advice.json"
        run_suggest(fixture, out)
        diag = load(out).advice[0].diagnostics

        assert diag["position"] == load(out).me
        assert diag["n_actions_scored"] >= 1
        assert diag["model"].endswith(f"{load(out).me}.onnx")

    def test_position_is_taken_from_the_acting_player(self, fixture, tmp_path):
        out = tmp_path / "advice.json"
        run_suggest(fixture, out)
        assert derive(load(out)).acting == load(out).me

    def test_top_k_is_respected(self, fixture, tmp_path):
        out = tmp_path / "advice.json"
        assert run_suggest(fixture, out, "--top-k", "1") == 0
        assert len(load(out).advice[0].candidates) == 1

    def test_suggests_only_on_our_turn(self, tmp_path):
        """轮不到我方时应明确拒绝，而不是给出别人的建议。"""
        record = load(fixture_path("landlord"))
        # 让地主出一手，轮到下家，而我方仍是地主
        played = record.__class__(
            **{
                **record.__dict__,
                "steps": (
                    Step(
                        index=0,
                        player="landlord",
                        action=Action(kind="play", cards=(record.initial.my_hand[0],)),
                    ),
                ),
            }
        )
        from ddz.record.io import save

        source = tmp_path / "not_my_turn.json"
        save(played, source)

        assert run_suggest(source, tmp_path / "out.json") == 2


class TestDeterminism:
    def test_same_input_gives_byte_identical_output(self, fixture, tmp_path):
        """同一局面重跑，输出逐字节相同。"""
        first, second = tmp_path / "a.json", tmp_path / "b.json"
        assert run_suggest(fixture, first) == 0
        assert run_suggest(fixture, second) == 0
        assert first.read_bytes() == second.read_bytes()

    def test_advice_is_appended_not_replacing(self, fixture, tmp_path):
        """重复跑不会覆盖已有建议，而是追加。"""
        out = tmp_path / "advice.json"
        run_suggest(fixture, out)
        run_suggest(out, out)
        assert len(load(out).advice) == 2

    def test_input_file_is_not_modified(self, fixture, tmp_path):
        before = fixture.read_bytes()
        run_suggest(fixture, tmp_path / "advice.json")
        assert fixture.read_bytes() == before
