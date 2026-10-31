"""展示页后端的契约。

页面本身不含业务逻辑 —— 它只显示，所有数字都由这层现算。所以这里盯的是
「喂给页面的数字与形状对不对、错误怎么回」，不盯渲染（渲染由 web/verify.mjs 看）。
"""

from __future__ import annotations

import pytest

from ddz.api.app import analyze, app, get_policy
from ddz.inference import sample
from ddz.record.schema import Action, Candidate, Initial, MatchRecord, Step

fastapi_testclient = pytest.importorskip("fastapi.testclient")

# 一手自洽的 17 张（每个点数不超过 4 张），配三张底牌。
MY_HAND = ("3", "3", "3", "4", "4", "4", "5", "5", "5", "6", "6", "6", "7", "7", "8", "A", "A")
LANDLORD_CARDS = ("9", "T", "J")

# 地主领出一对 9，下家不要 —— 于是第 2 手轮到我方（landlord_up），
# 且我手上有一对 A 可以压，合法动作不止"不出"。
STEPS = (
    Step(index=0, player="landlord", action=Action(kind="play", cards=("9", "9"))),
    Step(index=1, player="landlord_down", action=Action(kind="pass")),
)


class FakePolicy:
    """只给确定的分，不加载 ONNX：这一层测的是推导与形状，不是模型。"""

    def rank(self, snapshot, actions, top_k=3):
        picked = actions[:top_k]
        return (
            [Candidate(action=a, score=float(len(picked) - i)) for i, a in enumerate(picked)],
            {"n_actions_scored": len(actions), "position": snapshot.acting},
        )


def make_record(me="landlord_up", steps=STEPS):
    return MatchRecord(
        record_id="fixture-1",
        source="real",
        created_at="2026-01-01T00:00:00+08:00",
        me=me,
        initial=Initial(my_hand=MY_HAND, three_landlord_cards=LANDLORD_CARDS),
        steps=steps,
    )


def test_analyze_describes_the_snapshot():
    got = analyze(make_record(), FakePolicy())
    assert got["step"] == 2, "默认应走到第一个轮到我方的决策点"
    assert got["acting"] == "landlord_up" == got["me"]
    assert got["remaining"] == {"landlord": 18, "landlord_down": 17, "landlord_up": 17}
    assert got["last_move"] == ["9", "9"]
    assert got["opponents"] == ["landlord", "landlord_down"]


def test_analyze_lists_all_my_turn_steps():
    """页面靠它画步号按钮；只有轮到我方的点才该出现。"""
    assert analyze(make_record(), FakePolicy())["my_steps"] == [2]


def test_analyze_offers_more_than_one_candidate():
    got = analyze(make_record(), FakePolicy())
    labels = [c["label"] for c in got["candidates"]]
    assert "不出" in labels
    assert "AA" in labels, f"我手上有一对 A 能压 9，候选里应有它：{labels}"


def test_analyze_card_probabilities_are_conserved():
    """全部牌的期望张数加总 == 牌池张数 —— 牌既不会凭空多，也不会凭空少。"""
    got = analyze(make_record(), FakePolicy(), particles=80)
    total = sum(v["expected"] for row in got["cards"] for v in row["by"].values())
    assert got["pool_size"] == 35
    assert abs(total - got["pool_size"]) < 0.5, f"期望张数加总 {total} 对不上牌池"


def test_analyze_refuses_a_step_where_it_is_not_my_turn():
    with pytest.raises(ValueError, match="不是我方"):
        analyze(make_record(), FakePolicy(), step=1)


def test_analyze_refuses_a_step_out_of_range():
    with pytest.raises(ValueError):
        analyze(make_record(), FakePolicy(), step=99)


def test_analyze_particles_are_complete_two_hand_partitions():
    got = analyze(make_record(), FakePolicy(), particles=50)
    assert len(got["particles"]) == 50
    for hand_a, hand_b in got["particles"]:
        assert len(hand_a) == 18 and len(hand_b) == 17


def _client_with_fake_policy():
    app.dependency_overrides[get_policy] = lambda: FakePolicy()
    return fastapi_testclient.TestClient(app)


def test_analyze_endpoint_round_trips_a_record():
    client = _client_with_fake_policy()
    try:
        r = client.post("/api/analyze", json={"record": make_record().to_json(), "particles": 40})
        assert r.status_code == 200
        assert r.json()["me"] == "landlord_up"
    finally:
        app.dependency_overrides.clear()


def test_analyze_endpoint_reports_a_bad_record_as_400():
    client = _client_with_fake_policy()
    try:
        bad = make_record().to_json()
        bad["schema_version"] = 999
        r = client.post("/api/analyze", json={"record": bad})
        assert r.status_code == 400
        assert "schema_version" in r.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_index_serves_the_page():
    client = _client_with_fake_policy()
    try:
        r = client.get("/")
        assert r.status_code == 200
        assert "text/html" in r.headers["content-type"]
        assert "斗地主决策助手" in r.text
    finally:
        app.dependency_overrides.clear()
