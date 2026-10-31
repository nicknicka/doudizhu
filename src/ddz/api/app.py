"""展示页后端：把 CLI 已有的能力做成一个本机 HTTP 服务。

页面本身**不含业务逻辑**，它只负责显示；所有数字都在这里现算：
局面推导（``record.derive``）、手牌分布（``inference.sample``）、
候选打分（``policy``）、模型校准（``evaluation.calibration``）。

因此这个服务是页面的前提 —— 没有它，页面就是个空壳。所以除 ``/`` 之外
只提供 ``/api/*``，不另开静态数据通道。
"""

from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from ddz.evaluation import evaluate
from ddz.evaluation.calibration import SCORE_CAVEAT, calibrate
from ddz.inference import card_summary, sample
from ddz.policy.douzero import DouZeroPolicy, MissingWeightsError
from ddz.record.schema import SCORE_DISCLAIMER, Action, MatchRecord
from ddz.record.state import derive, my_turn_steps
from ddz.rules import legal_actions
from ddz.source import manual, sim

REPO = Path(__file__).resolve().parents[3]
WEB = REPO / "web"

DEFAULT_PARTICLES = 200
DEFAULT_TOP_K = 3

# 演示局与两个数据集级指标（评测 / 校准）。参数与 README 的两张表**逐字对齐**，
# 否则页面和文档上的数字就会各说各话。
DEMO_SEED = 6
DEMO_ME = "landlord_up"
METRIC_GAMES = 10
METRIC_PARTICLES = 200
METRIC_STRIDE = 3
CALIBRATION_GAMES = 8

# 设计 token 与模板放在一起（web/tokens.json）——「长什么样」是 web 的事，
# 后端只负责把占位符替换掉。
_TOKENS_FILE = WEB / "tokens.json"


def design_tokens() -> dict[str, str]:
    return json.loads(_TOKENS_FILE.read_text(encoding="utf-8"))


def render_page() -> str:
    tpl = (WEB / "template.html").read_text(encoding="utf-8")
    for key, value in design_tokens().items():
        tpl = tpl.replace(key, value)
    return tpl


def _snapshot_view(snapshot, step: int) -> dict[str, Any]:
    """页面「局面」那一栏要的东西。"""
    return {
        "step": step,
        "me": snapshot.me,
        "acting": snapshot.acting,
        "my_hand": list(snapshot.my_hand),
        "remaining": dict(snapshot.num_cards_left),
        "played": {p: list(c) for p, c in snapshot.played_cards.items()},
        "last_move": list(snapshot.last_move),
        "pool_size": len(snapshot.pool),
    }


def analyze(
    record: MatchRecord,
    policy: DouZeroPolicy,
    step: int | None = None,
    particles: int = DEFAULT_PARTICLES,
    top_k: int = DEFAULT_TOP_K,
) -> dict[str, Any]:
    """算出一个局面要显示的全部东西。

    返回分两层：``snapshot`` 是**要显示的那个局面**（一定在），``point`` 是
    决策点专属的东西（候选、粒子、逐张概率）—— 只有那个局面确实轮到我方时才存在。
    轮不到我方时 ``point`` 是 ``None``，页面照样把牌桌显示出来。

    ``step`` 指"看第几手之后的局面"。``None`` 交给后端挑一个默认视图：第一个
    轮到我方的决策点（一局打完时那就等于终局，没什么可看的，所以不能拿终局当默认）。
    调用方想看"记录当前位置"就显式传手数 —— 网页在录完一手后就是这么做的。
    """
    if particles < 1:
        raise ValueError("粒子数至少为 1")
    if top_k < 1:
        raise ValueError("top_k 必须为正")

    mine = my_turn_steps(record)
    end = len(record.steps)

    target = (mine[0] if mine else end) if step is None else step
    if not 0 <= target <= end:
        raise ValueError(f"步号要在 0 到 {end} 之间，收到 {step}")

    shown = derive(record, steps=record.steps[:target])

    view: dict[str, Any] = {
        "record_id": record.record_id,
        "source": record.source,
        "me": record.me,
        "total_steps": end,
        "my_steps": list(mine),
        "current_step": end,
        "current_acting": derive(record).acting,
        "snapshot": _snapshot_view(shown, target),
        "point": None,
    }
    if target not in mine:
        return view          # 轮不到我方：只给局面，不给候选与分布

    actions = legal_actions(shown)
    if not actions:
        raise ValueError("这个局面下我方没有合法动作")
    # 一次把所有合法动作都打上分：页面既要 top-k 做建议，也要完整清单
    # 让用户"点一下就把这一手记下来"，而不是自己敲牌。
    ranked, diagnostics = policy.rank(shown, actions, top_k=len(actions))
    dist = sample(shown, n_particles=particles, seed=target)

    def row(candidate) -> dict[str, Any]:
        action = candidate.action
        return {
            "label": "不出" if action.is_pass else "".join(action.cards),
            "score": round(candidate.score, 4),
            "cards": list(action.cards),      # 不要的话就是 []
        }

    view["point"] = {
        "step": target,
        "opponents": list(dist.opponents),
        "candidates": [row(c) for c in ranked[:top_k]],
        "actions": [row(c) for c in ranked],
        "cards": card_summary(dist, shown.pool),
        "particles": [
            [list(p.hands[o]) for o in dist.opponents] for p in dist.particles
        ],
        "diagnostics": diagnostics,
        "disclaimer": SCORE_DISCLAIMER,
    }
    return view


@functools.lru_cache(maxsize=1)
def demo_payload(policy: DouZeroPolicy) -> dict[str, Any]:
    """演示局 + 数据集级的评测与校准。第一次请求时算，之后走缓存。"""
    record = next(r for r in sim.generate(4, seed=DEMO_SEED) if r.me == DEMO_ME)
    metrics_ours, metrics_base = evaluate(
        list(sim.generate(METRIC_GAMES, seed=0)),
        n_particles=METRIC_PARTICLES,
        seed=0,
        step_stride=METRIC_STRIDE,
    )
    report = calibrate(
        list(sim.generate(CALIBRATION_GAMES, seed=0)),
        policy,
        n_buckets=5,
        step_stride=1,
    )
    return {
        "record": record.to_json(),
        "metrics": {
            "top1": round(metrics_ours.top1_accuracy, 4),
            "top1_base": round(metrics_base.top1_accuracy, 4),
            "ll": round(metrics_ours.log_likelihood, 4),
            "ll_base": round(metrics_base.log_likelihood, 4),
            "n_positions": metrics_ours.n_positions,
            "n_cards": metrics_ours.n_cards_scored,
        },
        "calibration": {
            "n_samples": report.n_samples,
            "mean_estimate": round(report.mean_estimate, 3),
            "actual_rate": round(report.actual_rate, 3),
            "buckets": [
                {
                    "low": round(b.low, 2),
                    "high": round(b.high, 2),
                    "n": b.n,
                    "mean_estimate": round(b.mean_estimate, 3),
                    "actual_rate": round(b.actual_rate, 3),
                }
                for b in report.buckets
            ],
        },
        "caveat": SCORE_CAVEAT,
    }


_POLICY = DouZeroPolicy()


def get_policy() -> DouZeroPolicy:
    """FastAPI 依赖。测试里覆盖它就能不加载 ONNX。"""
    return _POLICY


class AnalyzeRequest(BaseModel):
    record: dict[str, Any]
    step: int | None = None
    particles: int = DEFAULT_PARTICLES
    top_k: int = DEFAULT_TOP_K


class NewGameRequest(BaseModel):
    """和 CLI 的 ddz new 同一个入口（source.manual.start）。"""

    me: str
    my_hand: str          # 紧凑写法，如 34556789TTJJKK222
    landlord_cards: str   # 三张底牌
    record_id: str | None = None
    created_at: str | None = None


class StepRequest(BaseModel):
    """和 CLI 的 ddz play 同一个入口（source.manual.append_step）。

    ``cards`` 留空 = 这手不要；给了牌就是出牌。校验完全走 CLI 那一套。
    """

    record: dict[str, Any]
    player: str
    cards: str | None = None


class UndoRequest(BaseModel):
    record: dict[str, Any]


def create_app() -> FastAPI:
    app = FastAPI(title="斗地主决策助手", docs_url=None, redoc_url=None)
    # 页面只带一个本地依赖（GSAP），挂在 /vendor 下 —— 断网也要能开
    app.mount("/vendor", StaticFiles(directory=WEB / "vendor"), name="vendor")
    # 展示页的脚本按模块分文件，从 /app 取
    app.mount("/app", StaticFiles(directory=WEB / "app"), name="app")

    @app.get("/", response_class=HTMLResponse)
    def index() -> str:
        return render_page()

    @app.get("/api/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/api/demo")
    def demo(policy: DouZeroPolicy = Depends(get_policy)) -> dict[str, Any]:
        try:
            return demo_payload(policy)
        except MissingWeightsError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/api/game/new")
    def game_new(req: NewGameRequest) -> dict[str, Any]:
        try:
            record = manual.start(
                req.me,
                manual.parse_cards(req.my_hand),
                manual.parse_cards(req.landlord_cards),
                record_id=req.record_id,
                created_at=req.created_at,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"record": record.to_json()}

    @app.post("/api/game/step")
    def game_step(req: StepRequest) -> dict[str, Any]:
        try:
            record = MatchRecord.from_json(req.record)
            cards = (req.cards or "").strip()
            action = (
                Action(kind="pass")
                if not cards
                else Action(kind="play", cards=manual.parse_cards(cards))
            )
            return {"record": manual.append_step(record, req.player, action).to_json()}
        except ValueError as exc:
            # IllegalEntryError 也是 ValueError：轮次不对、牌型不认、牌已经出过……
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/game/undo")
    def game_undo(req: UndoRequest) -> dict[str, Any]:
        try:
            record = MatchRecord.from_json(req.record)
            updated = manual.undo(record)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"record": updated.to_json()}

    @app.post("/api/analyze")
    def analyze_endpoint(
        req: AnalyzeRequest, policy: DouZeroPolicy = Depends(get_policy)
    ) -> dict[str, Any]:
        try:
            record = MatchRecord.from_json(req.record)
            return analyze(
                record, policy, step=req.step, particles=req.particles, top_k=req.top_k
            )
        except MissingWeightsError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return app


app = create_app()
