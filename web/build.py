#!/usr/bin/env python3
"""用真实数据生成展示页。

数据全部来自本项目自己的模块（sim / derive / sample / DouZeroPolicy），
一个数字都不编。生成的 index.html 自包含，双击就能开。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from ddz.cards import FULL_DECK  # noqa: E402
from ddz.evaluation.calibration import calibrate  # noqa: E402
from ddz.inference import sample  # noqa: E402
from ddz.policy.douzero import DouZeroPolicy  # noqa: E402
from ddz.rules import legal_actions  # noqa: E402
from ddz.record.state import derive  # noqa: E402
from ddz.source import sim  # noqa: E402

STEPS_WANTED = 3


def build_data() -> dict:
    """取一局仿真对局，剪出几个「轮到我方」的决策点。"""
    record = next(r for r in sim.generate(4, seed=6) if r.me == "landlord_up")
    policy = DouZeroPolicy()

    points = []
    for step in range(len(record.steps) + 1):
        snap = derive(record, steps=record.steps[:step])
        if snap.acting != record.me:
            continue
        dist = sample(snap, n_particles=200, seed=step)
        candidates, diag = policy.rank(snap, legal_actions(snap), top_k=3)

        points.append({
            "step": step,
            "acting": snap.acting,
            "my_hand": list(snap.my_hand),
            "remaining": snap.num_cards_left,
            "played": {k: list(v) for k, v in snap.played_cards.items()},
            "last_move": list(snap.last_move),
            "pool_size": len(snap.pool),
            "opponents": list(dist.opponents),
            "particles": [[list(p.hands[o]) for o in dist.opponents] for p in dist.particles],
            "candidates": [
                {
                    "label": "不出" if c.action.is_pass else "".join(c.action.cards),
                    "score": round(c.score, 4),
                }
                for c in candidates
            ],
            "diagnostics": diag,
        })
        if len(points) >= STEPS_WANTED:
            break

    games = list(sim.generate(8, seed=0))
    ours, baseline = calibrate(games, policy, n_buckets=5, step_stride=1) if False else (None, None)
    from ddz.evaluation import evaluate

    metrics_ours, metrics_base = evaluate(games, n_particles=120, seed=0, step_stride=6)

    return {
        "record_id": record.record_id,
        "me": record.me,
        "total_steps": len(record.steps),
        "points": points,
        "metrics": {
            "top1": round(metrics_ours.top1_accuracy, 4),
            "top1_base": round(metrics_base.top1_accuracy, 4),
            "ll": round(metrics_ours.log_likelihood, 4),
            "ll_base": round(metrics_base.log_likelihood, 4),
            "n_positions": metrics_ours.n_positions,
            "n_cards": metrics_ours.n_cards_scored,
        },
    }


def main() -> int:
    data = build_data()
    tpl = (Path(__file__).parent / "template.html").read_text(encoding="utf-8")
    out = tpl.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False))
    (Path(__file__).parent / "index.html").write_text(out, encoding="utf-8")
    print(f"  index.html 已生成：{len(data['points'])} 个决策点，"
          f"{len(data['points'][0]['particles'])} 个粒子/点")
    return 0


if __name__ == "__main__":
    sys.exit(main())
