"""端到端：一个局面文件进，一个带建议的记录文件出。

这是本项目约定的**唯一 seam**，所有对外行为都应该挂在这里。
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pytest

from ddz.cli.main import main
from ddz.policy.douzero import DEFAULT_MODEL_DIR
from ddz.rules import legal_actions
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
        """候选必须在**独立算出的合法动作集合**里，且用到的牌都在手牌里。

        只检查"牌在手"是不够的：手里的牌也能拼出非法牌型
        （比如三张 3 加一张 4 组成的"假炸弹"），那样断言会漏掉。
        """
        out = tmp_path / "advice.json"
        run_suggest(fixture, out)

        result = load(out)
        snapshot = derive(result)

        legal = {(a.kind, a.cards) for a in legal_actions(snapshot)}
        hand = Counter(snapshot.my_hand)

        for candidate in result.advice[0].candidates:
            action = candidate.action
            assert (action.kind, action.cards) in legal, f"候选不合法：{action}"
            if action.is_play:
                assert not (Counter(action.cards) - hand), "候选用了手上没有的牌"

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
        """同一局面重跑，输出逐字节相同。

        注意：这条路径上**没有任何随机源**（模型推理是确定性的、采样尚未引入），
        所以不需要 seed 也能保证逐字节相同 —— 这比"同 seed 相同"更强。
        等到 S2 引入粒子采样时，seed 才成为必要条件。
        """
        first, second = tmp_path / "a.json", tmp_path / "b.json"
        assert run_suggest(fixture, first) == 0
        assert run_suggest(fixture, second) == 0
        assert first.read_bytes() == second.read_bytes()

    def test_rerun_replaces_advice_for_the_same_step(self, fixture, tmp_path):
        """同一决策点重跑是替换而不是堆积，否则反复运行会堆出矛盾建议。"""
        out = tmp_path / "advice.json"
        run_suggest(fixture, out)
        run_suggest(out, out)
        assert len(load(out).advice) == 1

    def test_input_file_is_not_modified(self, fixture, tmp_path):
        before = fixture.read_bytes()
        run_suggest(fixture, tmp_path / "advice.json")
        assert fixture.read_bytes() == before
