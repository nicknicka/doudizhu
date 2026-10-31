#!/usr/bin/env python3
"""用真实数据生成展示页。

数据全部来自本项目自己的模块（sim / derive / sample / DouZeroPolicy / evaluate），
一个数字都不编。生成的 index.html 自包含，双击就能开。
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from ddz.cards import CARD_ORDER, FULL_DECK  # noqa: E402
from ddz.evaluation import evaluate  # noqa: E402
from ddz.evaluation.calibration import SCORE_CAVEAT, calibrate  # noqa: E402
from ddz.inference import sample  # noqa: E402
from ddz.policy.douzero import DouZeroPolicy  # noqa: E402
from ddz.rules import legal_actions  # noqa: E402
from ddz.record.state import derive  # noqa: E402
from ddz.source import sim  # noqa: E402

# 页面能翻看的决策点个数。够看出「信息越多、分布越收敛」即可。
STEPS_WANTED = 6
PARTICLES = 200

# 下面两组参数与 README 的评测表 / 校准表**逐字对齐**：页面和文档上的数字
# 必须是同一组参数算出来的，否则「可复现」这句就站不住。
METRIC_GAMES = 10
METRIC_PARTICLES = 200
METRIC_STRIDE = 3
CALIBRATION_GAMES = 8


def card_summary(dist, pool) -> list[dict]:
    """每张未现身牌：两个对手各自「至少一张」的概率与期望张数。

    口径与 CLI ``ddz infer`` 一致 —— 报 P(至少一张) 和期望张数。旧实现报的是
    「第 k 张副本的累积概率」，于是同一个点数会拆成多行、每行含义还不同
    （3→97% 是 P(≥1 张)，3→5% 是 P(≥4 张)），读者没法把两行对上。
    """
    rows = []
    for card in sorted(set(pool), key=lambda c: CARD_ORDER[c]):
        by = {
            player: {
                "p": round(dist.probability(card, player), 3),
                "expected": round(dist.expected_count(card, player), 2),
            }
            for player in dist.opponents
        }
        rows.append({"card": card, "by": by})
    # 最没把握的牌排前面（P 最贴近 50/50）。这一版后验是「在合法分法上均匀」，
    # 所以张数多的牌 P(至少一张) 天然接近 1 —— 把它排在前面会看着"很有把握"，
    # 其实只是张数多，不含任何推断信息。平局按牌序，保证输出稳定。
    rows.sort(
        key=lambda r: (
            max(abs(v["p"] - 0.5) for v in r["by"].values()),
            CARD_ORDER[r["card"]],
        )
    )
    return rows


def spread(points: list, n: int) -> list:
    """从决策点序列里均匀挑 n 个（含首尾），让翻看时跨度够大。"""
    if len(points) <= n:
        return list(points)
    idx = sorted({round(i * (len(points) - 1) / (n - 1)) for i in range(n)})
    return [points[i] for i in idx]


def build_data() -> dict:
    """取一局仿真对局，剪出几个「轮到我方」的决策点。"""
    record = next(r for r in sim.generate(4, seed=6) if r.me == "landlord_up")
    policy = DouZeroPolicy()

    points = []
    for step in range(len(record.steps) + 1):
        snap = derive(record, steps=record.steps[:step])
        if snap.acting != record.me:
            continue
        dist = sample(snap, n_particles=PARTICLES, seed=step)
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
            "cards": card_summary(dist, snap.pool),
            "candidates": [
                {
                    "label": "不出" if c.action.is_pass else "".join(c.action.cards),
                    "score": round(c.score, 4),
                }
                for c in candidates
            ],
            "diagnostics": diag,
        })

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
        "record_id": record.record_id,
        "me": record.me,
        "total_steps": len(record.steps),
        "points": spread(points, STEPS_WANTED),
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
        # 与 CLI / README 用同一句措辞，别让读者把 Q 值当概率。
        "score_caveat": SCORE_CAVEAT,
    }


PALETTES = [
    ("暖纸",   "#f2eee6", "#1b1917", "#8a8177", "#b8452f", "#b8452f", "#4a6b8a"),
    ("深夜青", "#0e1416", "#e4ecee", "#7d8a8d", "#4fa3a5", "#4fa3a5", "#c98a4b"),
    ("米白靛", "#faf8f4", "#201e1b", "#8d8880", "#3d5a80", "#3d5a80", "#c07a4a"),
]
FONTS = [
    ('Georgia,"Songti SC",serif', 'ui-monospace,"SF Mono",Menlo,monospace'),
    ('"Helvetica Neue",-apple-system,"PingFang SC",sans-serif', 'ui-monospace,"SF Mono",Menlo,monospace'),
    ('ui-monospace,"SF Mono",Menlo,monospace', 'ui-monospace,"SF Mono",Menlo,monospace'),
]
SIDES = ["right", "left"]


def design_tokens() -> dict[str, str]:
    """从**外部**随机串确定性派生设计决定。

    串由 `openssl rand` 生成、只留在构建侧（web/design-seed.txt）——
    它本身绝不出现在成品页面里，页面只带派生结果。
    """
    seed = (Path(__file__).parent / "design-seed.txt").read_text().strip()
    h = hashlib.sha256(seed.encode()).digest()
    _, ground, ink, muted, accent, a, b = PALETTES[h[0] % len(PALETTES)]
    disp, data = FONTS[h[1] % len(FONTS)]
    return {
        "__GROUND__": ground, "__INK__": ink, "__MUTED__": muted, "__ACCENT__": accent,
        "__SIDE_A__": a, "__SIDE_B__": b,
        "__FONT_DISPLAY__": disp, "__FONT_DATA__": data,
        "__SIDE__": SIDES[h[2] % len(SIDES)],
    }


def main() -> int:
    data = build_data()
    tpl = (Path(__file__).parent / "template.html").read_text(encoding="utf-8")
    out = tpl.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False))
    for k, v in design_tokens().items():
        out = out.replace(k, v)
    (Path(__file__).parent / "index.html").write_text(out, encoding="utf-8")
    print(f"  index.html 已生成：{len(data['points'])} 个决策点，"
          f"{len(data['points'][0]['particles'])} 个粒子/点")

    # 生成后立刻做一次 JS 语法检查。嵌进 HTML 的脚本没有任何工具看着，
    # 一个拼错的 token 会让整页静默变白 —— 这里挡一道。
    import subprocess, tempfile

    script = "const DATA" + out.split("<script>\nconst DATA", 1)[1].split("</script>")[0]
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False, encoding="utf-8") as fh:
        fh.write(script)
        tmp = fh.name
    result = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit("生成的脚本有语法错误：\n" + result.stderr[-800:])
    print("  JS 语法检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
