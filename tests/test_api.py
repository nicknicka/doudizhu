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


# 地主开局 20 张，且三张底牌就在自己手里（manual.start 要求如此）
LANDLORD_HAND = MY_HAND + ("9", "T", "J")


def hand_for(me):
    return LANDLORD_HAND if me == "landlord" else MY_HAND


def make_record(me="landlord_up", steps=STEPS):
    return MatchRecord(
        record_id="fixture-1",
        source="real",
        created_at="2026-01-01T00:00:00+08:00",
        me=me,
        initial=Initial(my_hand=hand_for(me), three_landlord_cards=LANDLORD_CARDS),
        steps=steps,
    )


def test_analyze_describes_the_snapshot():
    got = analyze(make_record(), FakePolicy())
    assert got["snapshot"]["step"] == 2, "默认应走到第一个轮到我方的决策点"
    assert got["snapshot"]["acting"] == "landlord_up" == got["me"]
    assert got["snapshot"]["me"] == "landlord_up", "快照要带上「我方是谁」，页面靠它分席位"
    assert got["snapshot"]["remaining"] == {"landlord": 18, "landlord_down": 17, "landlord_up": 17}
    assert got["snapshot"]["last_move"] == ["9", "9"]
    assert got["point"]["opponents"] == ["landlord", "landlord_down"]


def test_analyze_lists_all_my_turn_steps():
    """页面靠它画步号按钮；只有轮到我方的点才该出现。"""
    assert analyze(make_record(), FakePolicy())["my_steps"] == [2]


def test_analyze_offers_more_than_one_candidate():
    got = analyze(make_record(), FakePolicy())
    labels = [c["label"] for c in got["point"]["candidates"]]
    assert "不出" in labels
    assert "AA" in labels, f"我手上有一对 A 能压 9，候选里应有它：{labels}"


def test_analyze_card_probabilities_are_conserved():
    """全部牌的期望张数加总 == 牌池张数 —— 牌既不会凭空多，也不会凭空少。"""
    got = analyze(make_record(), FakePolicy(), particles=80)
    total = sum(v["expected"] for row in got["point"]["cards"] for v in row["by"].values())
    assert got["snapshot"]["pool_size"] == 35
    assert abs(total - got["snapshot"]["pool_size"]) < 0.5, f"期望张数加总 {total} 对不上牌池"


def test_analyze_shows_a_position_that_is_not_my_turn_without_a_point():
    """看历史局面（这儿是第 1 手，该下家）也得能显示牌桌 —— 只是没有候选。"""
    got = analyze(make_record(), FakePolicy(), step=1)
    assert got["snapshot"]["step"] == 1
    assert got["snapshot"]["acting"] == "landlord_down"
    assert got["point"] is None


def test_analyze_has_no_decision_point_once_the_game_is_over():
    """牌局已经打完 —— 只给局面，不给候选与分布（终局没有"该谁出牌"）。"""
    from ddz.record.state import derive
    from ddz.source import sim

    # seed=0 这局由地主出完，最后一手出完之后轮次正好转到他下家
    finished = next(r for r in sim.generate(1, seed=0) if r.me == "landlord_down")
    assert derive(finished).finished, "这局应当已经打完"

    got = analyze(finished, FakePolicy(), step=len(finished.steps))
    assert got["snapshot"]["finished"] is True
    assert got["snapshot"]["winner"] == "landlord"
    assert got["point"] is None
    assert len(finished.steps) not in got["my_steps"]


def test_analyze_refuses_a_step_out_of_range():
    with pytest.raises(ValueError):
        analyze(make_record(), FakePolicy(), step=99)


def test_analyze_particles_are_complete_two_hand_partitions():
    got = analyze(make_record(), FakePolicy(), particles=50)
    assert len(got["point"]["particles"]) == 50
    for hand_a, hand_b in got["point"]["particles"]:
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


# ---------- 网页录入：与 CLI 的 new / play / undo 同一套校验 ----------

MY_HAND_STR = "".join(MY_HAND)          # 333444555666778AA
LANDLORD_STR = "".join(LANDLORD_CARDS)  # 9TJ


def _new_game(client, **overrides):
    payload = {
        "me": "landlord_up",
        "my_hand": MY_HAND_STR,
        "landlord_cards": LANDLORD_STR,
        "record_id": "web-1",
        "created_at": "2026-01-01T00:00:00+08:00",
    }
    payload.update(overrides)
    r = client.post("/api/game/new", json=payload)
    assert r.status_code == 200, r.text
    return r.json()["record"]


def test_new_game_returns_a_record_the_cli_could_have_written():
    client = _client_with_fake_policy()
    try:
        record = _new_game(client)
        assert record["record_id"] == "web-1"
        assert record["source"] == "real"
        assert record["me"] == "landlord_up"
        assert record["steps"] == []
        # 手牌按字符表规范化存放，和 CLI 录出来的完全一样
        assert record["initial"]["my_hand"] == list(MY_HAND)
    finally:
        app.dependency_overrides.clear()


def test_new_game_reports_a_bad_hand_as_400():
    client = _client_with_fake_policy()
    try:
        r = client.post("/api/game/new", json={
            "me": "landlord_up", "my_hand": "345", "landlord_cards": LANDLORD_STR,
        })
        assert r.status_code == 400
        assert "17 张" in r.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_step_records_a_validated_hand():
    client = _client_with_fake_policy()
    try:
        record = _new_game(client)
        r = client.post("/api/game/step",
                        json={"record": record, "player": "landlord", "cards": "99"})
        assert r.status_code == 200, r.text
        record = r.json()["record"]
        assert [s["action"]["cards"] for s in record["steps"]] == [["9", "9"]]
    finally:
        app.dependency_overrides.clear()


def test_step_returns_play_cards_in_canonical_order():
    """接口和 CLI/JSON 共用同一个动作边界：8884 返回 4888。"""
    client = _client_with_fake_policy()
    try:
        record = _new_game(client)
        r = client.post(
            "/api/game/step",
            json={"record": record, "player": "landlord", "cards": "8884"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["record"]["steps"][0]["action"]["cards"] == ["4", "8", "8", "8"]
    finally:
        app.dependency_overrides.clear()


def test_step_refuses_the_wrong_player():
    client = _client_with_fake_policy()
    try:
        record = _new_game(client)
        r = client.post("/api/game/step",
                        json={"record": record, "player": "landlord_up", "cards": "99"})
        assert r.status_code == 400
        assert "现在该 landlord 出牌" in r.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_step_refuses_cards_that_are_not_available():
    """我手上有三张 3，牌池只剩一张 —— 地主不可能打出两张 3。"""
    client = _client_with_fake_policy()
    try:
        record = _new_game(client)
        r = client.post("/api/game/step",
                        json={"record": record, "player": "landlord", "cards": "33"})
        assert r.status_code == 400
        assert "已经出过" in r.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_step_and_undo_then_analyze_round_trips():
    """录两手、撤一手，再让后端算这个局面 —— 网页录入与 CLI 是同一条数据通路。"""
    client = _client_with_fake_policy()
    try:
        record = _new_game(client)
        record = client.post("/api/game/step",
                             json={"record": record, "player": "landlord", "cards": "99"}
                             ).json()["record"]
        record = client.post("/api/game/step",
                             json={"record": record, "player": "landlord_down", "cards": ""}
                             ).json()["record"]
        got = client.post("/api/analyze", json={"record": record, "particles": 40}).json()
        assert got["point"]["step"] == 2 and got["snapshot"]["acting"] == "landlord_up"
        assert [s["action"]["type"] for s in record["steps"]] == ["play", "pass"]

        undone = client.post("/api/game/undo", json={"record": record}).json()["record"]
        assert len(undone["steps"]) == 1
        # 撤销之后不该再轮到我方：仍然给局面，但不再给候选/分布
        after = client.post("/api/analyze", json={"record": undone}).json()
        assert after["point"] is None
        assert after["snapshot"]["acting"] == "landlord_down"
    finally:
        app.dependency_overrides.clear()


def test_undo_on_an_empty_record_is_refused():
    client = _client_with_fake_policy()
    try:
        record = _new_game(client)
        r = client.post("/api/game/undo", json={"record": record})
        assert r.status_code == 400
        assert "无法撤销" in r.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_analyze_before_my_turn_gives_the_position_without_a_point():
    """刚开完局就还轮不到我方 —— 页面照样得能显示局面。"""
    got = analyze(make_record(steps=()), FakePolicy())
    assert got["my_steps"] == []
    assert got["point"] is None
    assert got["current_acting"] == "landlord"
    assert got["snapshot"]["step"] == 0
    assert got["snapshot"]["remaining"] == {"landlord": 20, "landlord_down": 17, "landlord_up": 17}


def test_analyze_hands_back_every_legal_action_with_its_cards():
    """页面靠它做"点一下就把这一手记下来"，所以每个动作都得带具体牌面。"""
    got = analyze(make_record(), FakePolicy())
    actions = got["point"]["actions"]
    labels = {a["label"]: a for a in actions}
    assert "不出" in labels and labels["不出"]["cards"] == []
    assert labels["AA"]["cards"] == ["A", "A"]
    # 全量动作是 top-k 的超集，且分数降序
    assert len(actions) >= len(got["point"]["candidates"])
    scores = [a["score"] for a in actions]
    assert scores == sorted(scores, reverse=True)


def test_analyze_reports_pool_counts():
    """牌盘的张数上限（以及将来的记牌器）吃的就是这一份数据。"""
    got = analyze(make_record(), FakePolicy())
    counts = got["snapshot"]["pool_counts"]
    assert got["snapshot"]["pool_size"] == 35
    assert sum(counts.values()) == 35, "各点数之和必须等于牌池张数"
    assert counts["3"] == 1, "我手上有三张 3，牌池只剩一张"
    assert counts["A"] == 2, "我手上有两张 A"
    assert counts["T"] == 4, "一张 T 都没现身"


@pytest.mark.parametrize("me,expect_up,expect_down", [
    ("landlord",      "landlord_up",   "landlord_down"),
    ("landlord_down", "landlord",      "landlord_up"),
    ("landlord_up",   "landlord_down", "landlord"),
])
def test_seat_mapping_is_relative_to_me(me, expect_up, expect_down):
    """上下家以**我方**为参照，与谁是地主无关 —— 两者经常是反的。"""
    seats = analyze(make_record(me=me, steps=()), FakePolicy())["seats"]
    assert seats[me]["relative"] == "me"
    assert seats[expect_up]["relative"] == "up"
    assert seats[expect_down]["relative"] == "down"
    assert seats["landlord"]["identity"] == "landlord"
    assert all(seats[p]["identity"] == "peasant" for p in seats if p != "landlord")
