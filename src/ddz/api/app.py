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
from ddz.record.schema import SCORE_DISCLAIMER, MatchRecord
from ddz.record.state import derive, my_turn_steps
from ddz.rules import legal_actions
from ddz.source import sim

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


def analyze(
    record: MatchRecord,
    policy: DouZeroPolicy,
    step: int | None = None,
    particles: int = DEFAULT_PARTICLES,
    top_k: int = DEFAULT_TOP_K,
) -> dict[str, Any]:
    """算出一个决策点要显示的全部东西。

    ``step=None`` 表示「第一个轮到我方的决策点」—— 页面刚打开或刚载入一份
    记录时并不知道该从哪儿看起，由这里决定。
    """
    if particles < 1:
        raise ValueError("粒子数至少为 1")
    if top_k < 1:
        raise ValueError("top_k 必须为正")

    mine = my_turn_steps(record)
    if not mine:
        raise ValueError("这局记录里没有轮到我方的决策点")

    target = mine[0] if step is None else step
    if not 0 <= target <= len(record.steps):
        raise ValueError(f"步号要在 0 到 {len(record.steps)} 之间，收到 {step}")
    if target not in mine:
        raise ValueError(f"第 {target} 手轮到 {derive(record, steps=record.steps[:target]).acting}，不是我方（{record.me}）")

    snapshot = derive(record, steps=record.steps[:target])
    actions = legal_actions(snapshot)
    if not actions:
        raise ValueError("这个局面下我方没有合法动作")

    candidates, diagnostics = policy.rank(snapshot, actions, top_k=top_k)
    dist = sample(snapshot, n_particles=particles, seed=target)

    return {
        "record_id": record.record_id,
        "source": record.source,
        "me": record.me,
        "total_steps": len(record.steps),
        "step": target,
        "my_steps": list(mine),
        "acting": snapshot.acting,
        "my_hand": list(snapshot.my_hand),
        "remaining": dict(snapshot.num_cards_left),
        "played": {p: list(c) for p, c in snapshot.played_cards.items()},
        "last_move": list(snapshot.last_move),
        "pool_size": len(snapshot.pool),
        "opponents": list(dist.opponents),
        "candidates": [
            {
                "label": "不出" if c.action.is_pass else "".join(c.action.cards),
                "score": round(c.score, 4),
            }
            for c in candidates
        ],
        "cards": card_summary(dist, snapshot.pool),
        "particles": [
            [list(p.hands[o]) for o in dist.opponents] for p in dist.particles
        ],
        "diagnostics": diagnostics,
        "disclaimer": SCORE_DISCLAIMER,
    }


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


def create_app() -> FastAPI:
    app = FastAPI(title="斗地主决策助手", docs_url=None, redoc_url=None)
    # 页面只带一个本地依赖（GSAP），挂在 /vendor 下 —— 断网也要能开
    app.mount("/vendor", StaticFiles(directory=WEB / "vendor"), name="vendor")

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
