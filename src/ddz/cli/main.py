"""命令行入口。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ddz.policy.douzero import DEFAULT_MODEL_DIR, DouZeroPolicy
from ddz.policy.legality import legal_actions
from ddz.record.io import load, save
from ddz.record.schema import Advice
from ddz.record.state import derive


def _cmd_suggest(args: argparse.Namespace) -> int:
    record = load(args.infile)
    snapshot = derive(record)

    if snapshot.acting != record.me:
        print(
            f"当前该 {snapshot.acting} 行动，而记录里的我方是 {record.me}；"
            "这张票只支持轮到我方时给建议。",
            file=sys.stderr,
        )
        return 2

    actions = legal_actions(snapshot)
    policy = DouZeroPolicy(args.models)
    candidates, diagnostics = policy.rank(snapshot, actions, top_k=args.top_k)

    advice = Advice(
        after_step=len(record.steps),
        position=snapshot.acting,
        model=diagnostics["model"],
        candidates=candidates,
        diagnostics=diagnostics,
    )
    updated = record.__class__(
        **{**record.__dict__, "advice": record.advice + (advice,)}
    )
    save(updated, args.out)

    print(f"局面：{snapshot.acting} 行动，手牌 {len(snapshot.my_hand)} 张，"
          f"合法动作 {len(actions)} 个")
    for rank, candidate in enumerate(candidates, start=1):
        action = candidate.action
        shown = "不出" if action.kind == "pass" else "".join(action.cards)
        print(f"  {rank}. {shown:14s} 估计 {candidate.score:+.4f}")
    print(f"  （{advice.note}）")
    print(f"已写入 {args.out}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ddz", description="斗地主决策助手")
    sub = parser.add_subparsers(dest="command", required=True)

    suggest = sub.add_parser("suggest", help="读入一个局面，输出带候选建议的记录")
    suggest.add_argument("--in", dest="infile", type=Path, required=True, help="输入记录文件")
    suggest.add_argument("--out", type=Path, required=True, help="输出记录文件")
    suggest.add_argument("--top-k", type=int, default=3, help="给出几个候选（默认 3）")
    suggest.add_argument("--models", type=Path, default=DEFAULT_MODEL_DIR, help="权重目录")
    suggest.set_defaults(func=_cmd_suggest)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
