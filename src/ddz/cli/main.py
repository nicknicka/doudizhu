"""命令行入口。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ddz.policy.douzero import DEFAULT_MODEL_DIR, DouZeroPolicy, NotYourTurnError
from ddz.policy.legality import legal_actions
from ddz.record.io import load, save
from ddz.record.state import derive


def _cmd_suggest(args: argparse.Namespace) -> int:
    """读局面 → 要建议 → 写记录。这里只做编排，不含业务逻辑。"""
    record = load(args.infile)
    policy = DouZeroPolicy(args.models)

    try:
        advice = policy.advise(record, top_k=args.top_k)
    except NotYourTurnError as exc:
        print(exc, file=sys.stderr)
        return 2

    snapshot = derive(record)
    save(record.with_advice(advice), args.out)

    print(f"局面：{advice.position} 行动，手牌 {len(snapshot.my_hand)} 张，"
          f"合法动作 {advice.diagnostics['n_actions_scored']} 个")
    for rank, candidate in enumerate(advice.candidates, start=1):
        action = candidate.action
        shown = "不出" if action.is_pass else "".join(action.cards)
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
