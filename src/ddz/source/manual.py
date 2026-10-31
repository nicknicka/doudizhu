"""手动录入：把一局真实牌局一步步录成记录。

设计成**函数式**：记录是不可变的，每次录入返回一份新记录，所以「改错了」就是
把上一步丢掉重来，不需要额外的撤销栈。每一步都校验，因此不会录出一局
规则上不成立的牌。

局限（见 docs/data-schema.md）：必须从开局录起。牌池是
「全牌 − 我方手牌 − 已出的牌」推出来的，不录前史就会算出一个偏大的池子，
模型会收到错的输入。
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timedelta, timezone

from ddz.cards import FULL_DECK_COUNTS, normalize
from ddz.rules import beat_options, canonical_combo, legal_actions
from ddz.record.schema import (
    INITIAL_HAND_SIZE,
    TURN_ORDER,
    Action,
    Initial,
    MatchRecord,
    Step,
)
from ddz.record.state import derive

CN_TZ = timezone(timedelta(hours=8))


class IllegalEntryError(ValueError):
    """录进去的内容规则上不成立。"""


def now() -> str:
    return datetime.now(CN_TZ).isoformat(timespec="seconds")


def _validate_timestamp(stamp: str) -> None:
    """时间戳必须是带时区的 ISO 8601 —— 否则跨时区复盘时没法还原。"""
    try:
        parsed = datetime.fromisoformat(stamp)
    except ValueError as exc:
        raise IllegalEntryError(f"created_at 不是合法的 ISO 8601：{stamp!r}") from exc
    if parsed.tzinfo is None:
        raise IllegalEntryError(f"created_at 必须带时区：{stamp!r}")


def start(
    me: str,
    my_hand,
    three_landlord_cards,
    *,
    record_id: str | None = None,
    created_at: str | None = None,
    source: str = "real",
) -> MatchRecord:
    """录入开局信息，建出一份空记录。"""
    if me not in TURN_ORDER:
        raise IllegalEntryError(f"位置只能是 {TURN_ORDER}，收到 {me!r}")

    hand = normalize(my_hand)
    landlord_cards = normalize(three_landlord_cards)

    expected = INITIAL_HAND_SIZE[me]
    if len(hand) != expected:
        raise IllegalEntryError(f"{me} 开局应有 {expected} 张手牌，收到 {len(hand)} 张")
    if len(landlord_cards) != 3:
        raise IllegalEntryError(f"底牌应为 3 张，收到 {len(landlord_cards)} 张")

    over = Counter(hand) - FULL_DECK_COUNTS
    if over:
        raise IllegalEntryError(f"手牌超出全牌数量：{dict(over)}")
    over = Counter(landlord_cards) - FULL_DECK_COUNTS
    if over:
        raise IllegalEntryError(f"底牌超出全牌数量：{dict(over)}")

    if me == "landlord":
        # 地主的三张底牌已经在他那 20 张里
        missing = Counter(landlord_cards) - Counter(hand)
        if missing:
            raise IllegalEntryError(f"地主的底牌应当在自己手上，缺少：{dict(missing)}")
    else:
        # 农民：自己的手牌 + 底牌不能超过整副牌
        over = Counter(hand) + Counter(landlord_cards) - FULL_DECK_COUNTS
        if over:
            raise IllegalEntryError(f"手牌与底牌合计超出全牌数量：{dict(over)}")

    stamp = created_at or now()
    _validate_timestamp(stamp)
    return MatchRecord(
        record_id=record_id or f"real-{stamp}",
        source=source,
        created_at=stamp,
        me=me,
        initial=Initial(
            my_hand=hand, three_landlord_cards=landlord_cards
        ),
    )


def _validate_play(record: MatchRecord, snapshot, player: str, action: Action) -> None:
    """校验一手出牌：牌型认得、牌还没出过、压得住上一手。"""
    try:
        combo = canonical_combo(action.cards)
    except ValueError as exc:
        raise IllegalEntryError(str(exc)) from exc

    # Snapshot 里的 my_hand 是 record.me 的手牌，所以只有轮到本人时
    # 才能做完整的合法性校验；别人的手牌我们本来就不该知道。
    remaining = snapshot.num_cards_left[player]
    if len(action.cards) > remaining:
        raise IllegalEntryError(
            f"{player} 只剩 {remaining} 张，出不了 {len(action.cards)} 张"
        )

    if player == record.me:
        if action not in legal_actions(snapshot):
            raise IllegalEntryError(f"这手不合法：{combo}")
        return

    # 别人的牌：只能验证牌在池子里、并且压得住
    over = Counter(action.cards) - Counter(snapshot.pool)
    if over:
        raise IllegalEntryError(f"这些牌已经出过了，不可能再出：{dict(over)}")
    if snapshot.last_move and combo not in beat_options(snapshot.pool, snapshot.last_move):
        raise IllegalEntryError(f"这手压不过上一手：{combo}")


def append_step(record: MatchRecord, player: str, action: Action) -> MatchRecord:
    """记录一手。校验轮次、牌型与合法性，不通过就拒绝。"""
    if player not in TURN_ORDER:
        raise IllegalEntryError(f"位置只能是 {TURN_ORDER}，收到 {player!r}")

    snapshot = derive(record)
    if player != snapshot.acting:
        raise IllegalEntryError(f"现在该 {snapshot.acting} 出牌，不是 {player}")

    if action.is_play:
        _validate_play(record, snapshot, player, action)
    elif not snapshot.last_move:
        # 上一手为空 = 由这一家自由领出，此时不能不要
        raise IllegalEntryError(f"{player} 是领出方，不能不要")

    step = Step(index=len(record.steps), player=player, action=action)
    updated = MatchRecord(**{**record.__dict__, "steps": record.steps + (step,)})
    # 立刻推导一遍：手牌对不上等问题在这里就炸，而不是等到要建议的时候
    derive(updated)
    return updated


def undo(record: MatchRecord) -> MatchRecord:
    """撤掉最后一手。空记录时拒绝，而不是静默什么都不做。"""
    if not record.steps:
        raise IllegalEntryError("还没有记录任何一手，无法撤销")
    return MatchRecord(**{**record.__dict__, "steps": record.steps[:-1]})


def truncate(record: MatchRecord, keep: int) -> MatchRecord:
    """只保留前 ``keep`` 手，从那里继续录 —— 对应「不用重来整局」。"""
    if not 0 <= keep <= len(record.steps):
        raise IllegalEntryError(f"只能保留 0 到 {len(record.steps)} 手，收到 {keep}")
    return MatchRecord(**{**record.__dict__, "steps": record.steps[:keep]})


def parse_cards(text: str) -> tuple[str, ...]:
    """把 ``"33K"`` 这样的紧凑写法拆成牌。"""
    return normalize(text)
