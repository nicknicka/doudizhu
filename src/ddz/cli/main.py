"""命令行入口。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ddz.policy.douzero import DEFAULT_MODEL_DIR, DouZeroPolicy, NotYourTurnError
from ddz.record.io import load, save
from ddz.record.schema import Action, TURN_ORDER
from ddz.record.state import derive
from ddz.source import IllegalEntryError, manual, sim


def _print_advice(record, policy, top_k: int) -> None:
    snapshot = derive(record)
    if snapshot.acting != record.me:
        print(f"当前该 {snapshot.acting} 行动，不是我方，暂不给建议。")
        return
    advice = policy.advise(record, top_k=top_k)
    print(f"合法动作 {advice.diagnostics['n_actions_scored']} 个：")
    for rank, candidate in enumerate(advice.candidates, start=1):
        action = candidate.action
        shown = "不出" if action.is_pass else "".join(action.cards)
        print(f"  {rank}. {shown:14s} 估计 {candidate.score:+.4f}")
    print(f"  （{advice.note}）")


def _cmd_new(args: argparse.Namespace) -> int:
    """录入开局信息。"""
    try:
        record = manual.start(
            args.me,
            manual.parse_cards(args.hand),
            manual.parse_cards(args.landlord_cards),
            record_id=args.record_id,
            created_at=args.created_at,
        )
    except IllegalEntryError as exc:
        print(exc, file=sys.stderr)
        return 2

    save(record, args.out)
    print(f"已建记录 {record.record_id}：{record.me}，手牌 "
          f"{len(record.initial.my_hand)} 张，底牌 "
          f"{''.join(record.initial.three_landlord_cards)}")
    print(f"已写入 {args.out}")
    return 0


def _cmd_play(args: argparse.Namespace) -> int:
    """录一手出牌或不要。"""
    record = load(args.infile)
    if args.pass_action:
        action = Action(kind="pass")
    else:
        if not args.cards:
            print("要么给 --cards，要么给 --pass", file=sys.stderr)
            return 2
        try:
            action = Action(kind="play", cards=manual.parse_cards(args.cards))
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 2

    try:
        record = manual.append_step(record, args.player, action)
    except IllegalEntryError as exc:
        print(f"录不进去：{exc}", file=sys.stderr)
        return 2

    save(record, args.out)
    shown = "不要" if action.is_pass else "".join(action.cards)
    print(f"已录：{args.player} {shown}（共 {len(record.steps)} 手）")

    if args.suggest:
        _print_advice(record, DouZeroPolicy(args.models), args.top_k)
    return 0


def _cmd_undo(args: argparse.Namespace) -> int:
    """撤掉最后一手。"""
    record = load(args.infile)
    try:
        # --keep N：截断到第 N 手，从那儿继续录（改早期错误不必重录后缀）
        record = (
            manual.truncate(record, args.keep)
            if args.keep is not None
            else manual.undo(record)
        )
    except IllegalEntryError as exc:
        print(exc, file=sys.stderr)
        return 2
    save(record, args.out)
    print(f"还剩 {len(record.steps)} 手 → {args.out}")
    return 0


def _cmd_show(args: argparse.Namespace) -> int:
    """看局面。带 --step N 就直接跳回第 N 个决策点（0 = 开局）。"""
    record = load(args.infile)

    if args.step is not None:
        # 「跳到第 N 个决策点」= 把记录截断到那里再推导
        try:
            record = record.upto(args.step)
        except ValueError as exc:
            print(exc, file=sys.stderr)
            return 2

    snapshot = derive(record)

    where = "开局" if not record.steps else f"第 {len(record.steps)} 手之后"
    print(f"记录 {record.record_id}（{record.source}）  我方 {record.me}  【{where}】")
    print(f"我方手牌 {len(snapshot.my_hand)} 张：{''.join(snapshot.my_hand)}")
    print(f"牌池 {len(snapshot.pool)} 张（另两家手牌并集，公开可推导）")
    print("各家剩余：" + "  ".join(f"{p}={n}" for p, n in snapshot.num_cards_left.items()))
    print("各家已出：" + "  ".join(
        f"{p}={''.join(cards) or '—'}" for p, cards in snapshot.played_cards.items()))
    print(f"现在该 {snapshot.acting} 行动")
    if snapshot.last_move:
        print(f"上一手：{''.join(snapshot.last_move)}")
    else:
        print("上一手：无（可自由领出）")

    if args.suggest:
        _print_advice(record, DouZeroPolicy(args.models), args.top_k)
    return 0


def _cmd_simulate(args: argparse.Namespace) -> int:
    """批量产出带真值的仿真记录，供评测使用。"""
    args.out_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for record in sim.generate(args.games, args.seed):
        save(record, args.out_dir / f"{record.record_id}.json")
        written += 1
    print(f"已产出 {args.games} 局 × 3 个视角 = {written} 条记录 → {args.out_dir}")
    print("每条都带三家开局手牌（真值），且每一步都能回放。")
    return 0


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

    new = sub.add_parser("new", help="录入开局信息，建出一份记录")
    new.add_argument("--me", required=True, choices=TURN_ORDER, help="我方位置")
    new.add_argument("--hand", required=True, help="我方起始手牌，如 34556789TTJJKK222")
    new.add_argument("--landlord-cards", required=True, help="三张底牌，如 792")
    new.add_argument("--record-id", default=None)
    new.add_argument("--created-at", default=None, help="固定时间戳，便于测试复现")
    new.add_argument("--out", type=Path, required=True)
    new.set_defaults(func=_cmd_new)

    play = sub.add_parser("play", help="录一手出牌或不要")
    play.add_argument("--in", dest="infile", type=Path, required=True)
    play.add_argument("--out", type=Path, required=True)
    play.add_argument("--player", required=True, choices=TURN_ORDER)
    play.add_argument("--cards", default=None, help="出的牌，如 33")
    play.add_argument("--pass", dest="pass_action", action="store_true", help="这手不要")
    play.add_argument("--suggest", action="store_true", help="录完之后如果轮到我方，直接给建议")
    play.add_argument("--top-k", type=int, default=3)
    play.add_argument("--models", type=Path, default=DEFAULT_MODEL_DIR)
    play.set_defaults(func=_cmd_play)

    undo = sub.add_parser("undo", help="撤掉最后一手，或用 --keep 截断到第 N 手")
    undo.add_argument("--in", dest="infile", type=Path, required=True)
    undo.add_argument("--out", type=Path, required=True)
    undo.add_argument("--keep", type=int, default=None,
                      help="保留前 N 手并丢弃其余（改早期错误用）")
    undo.set_defaults(func=_cmd_undo)

    show = sub.add_parser("show", help="看当前局面")
    show.add_argument("--in", dest="infile", type=Path, required=True)
    show.add_argument("--step", type=int, default=None,
                      help="跳到第 N 个决策点（0 = 开局，缺省 = 当前）")
    show.add_argument("--suggest", action="store_true")
    show.add_argument("--top-k", type=int, default=3)
    show.add_argument("--models", type=Path, default=DEFAULT_MODEL_DIR)
    show.set_defaults(func=_cmd_show)

    simulate = sub.add_parser("simulate", help="批量产出带真值的仿真记录")
    simulate.add_argument("--games", type=int, required=True, help="产出多少局")
    simulate.add_argument("--seed", type=int, default=0, help="随机种子；同种子产出同一批")
    simulate.add_argument("--out-dir", type=Path, required=True)
    simulate.set_defaults(func=_cmd_simulate)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
