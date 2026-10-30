"""牌局记录的格式定义。

设计原则：**只存推不出来的东西**。已出的牌、各家剩余张数、按顺序的出牌历史
都能从 ``initial`` + ``steps`` 推出来，所以不进文件——避免同一份事实有两个来源。

见 docs/data-schema.md。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

SCHEMA_VERSION = 1
RULESET = "standard-3p-v1"

# 出手顺序：地主 → 地主下家 → 地主上家 →（回到地主）
TURN_ORDER: tuple[str, ...] = ("landlord", "landlord_down", "landlord_up")

# 各位置在叫分结束后的初始手牌张数
INITIAL_HAND_SIZE: dict[str, int] = {
    "landlord": 20,
    "landlord_down": 17,
    "landlord_up": 17,
}


@dataclass(frozen=True)
class Action:
    """一次操作：出牌或不出。

    这是**我们记录格式**的动作表示，不用魔法字符串，避免与牌面混淆。
    """

    kind: str  # "play" | "pass"
    cards: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.kind not in ("play", "pass"):
            raise ValueError(f"未知动作类型：{self.kind}")
        if self.kind == "pass" and self.cards:
            raise ValueError("pass 不应带牌")
        if self.kind == "play" and not self.cards:
            raise ValueError("play 必须带牌")

    def to_json(self) -> dict[str, Any]:
        if self.kind == "pass":
            return {"type": "pass"}
        return {"type": "play", "cards": list(self.cards)}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Action":
        kind = data.get("type")
        if kind == "pass":
            return cls(kind="pass")
        if kind == "play":
            return cls(kind="play", cards=tuple(data["cards"]))
        raise ValueError(f"动作字段无法识别：{data!r}")


@dataclass(frozen=True)
class Step:
    index: int
    player: str
    action: Action

    def to_json(self) -> dict[str, Any]:
        return {"index": self.index, "player": self.player, "action": self.action.to_json()}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Step":
        return cls(
            index=int(data["index"]),
            player=data["player"],
            action=Action.from_json(data["action"]),
        )


@dataclass(frozen=True)
class Initial:
    """开局信息。

    ``opponents`` 是**真值**，只有仿真局面才有；真实牌局留空。
    """

    my_hand: tuple[str, ...]
    three_landlord_cards: tuple[str, ...]
    opponents: dict[str, tuple[str, ...]] | None = None

    def to_json(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "my_hand": list(self.my_hand),
            "three_landlord_cards": list(self.three_landlord_cards),
        }
        if self.opponents is not None:
            data["opponents"] = {k: list(v) for k, v in self.opponents.items()}
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Initial":
        opponents = data.get("opponents")
        return cls(
            my_hand=tuple(data["my_hand"]),
            three_landlord_cards=tuple(data["three_landlord_cards"]),
            opponents=(
                {k: tuple(v) for k, v in opponents.items()} if opponents is not None else None
            ),
        )


@dataclass(frozen=True)
class Candidate:
    action: Action
    score: float

    def to_json(self) -> dict[str, Any]:
        return {"action": self.action.to_json(), "score": self.score}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Candidate":
        return cls(action=Action.from_json(data["action"]), score=float(data["score"]))


@dataclass(frozen=True)
class Advice:
    """模型给出的建议。

    ``note`` 是固定措辞，用来提醒读者这不是真实胜率——模型输出的是 Q 值，
    语义上接近"期望回报"，不等于校准过的胜率。
    """

    after_step: int
    position: str
    model: str
    candidates: list[Candidate]
    diagnostics: dict[str, Any] = field(default_factory=dict)
    note: str = "模型给出的估计，不是真实胜率"

    def to_json(self) -> dict[str, Any]:
        return {
            "after_step": self.after_step,
            "position": self.position,
            "model": self.model,
            "note": self.note,
            "candidates": [c.to_json() for c in self.candidates],
            "diagnostics": dict(self.diagnostics),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Advice":
        return cls(
            after_step=int(data["after_step"]),
            position=data["position"],
            model=data["model"],
            candidates=[Candidate.from_json(c) for c in data["candidates"]],
            diagnostics=dict(data.get("diagnostics", {})),
            note=data.get("note", "模型给出的估计，不是真实胜率"),
        )


@dataclass(frozen=True)
class MatchRecord:
    record_id: str
    source: str  # "sim" | "real"
    created_at: str
    me: str
    initial: Initial
    steps: tuple[Step, ...] = ()
    advice: tuple[Advice, ...] = ()
    outcome: dict[str, Any] | None = None
    schema_version: int = SCHEMA_VERSION
    ruleset: str = RULESET

    def __post_init__(self) -> None:
        if self.me not in TURN_ORDER:
            raise ValueError(f"未知位置：{self.me}")
        if self.source not in ("sim", "real"):
            raise ValueError(f"未知来源：{self.source}")
        for expected, step in enumerate(self.steps):
            if step.index != expected:
                raise ValueError(f"步骤序号不连续：期望 {expected}，实际 {step.index}")

    def to_json(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "schema_version": self.schema_version,
            "record_id": self.record_id,
            "source": self.source,
            "created_at": self.created_at,
            "ruleset": self.ruleset,
            "me": self.me,
            "initial": self.initial.to_json(),
            "steps": [s.to_json() for s in self.steps],
        }
        if self.advice:
            data["advice"] = [a.to_json() for a in self.advice]
        if self.outcome is not None:
            data["outcome"] = dict(self.outcome)
        return data

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "MatchRecord":
        version = int(data.get("schema_version", 0))
        if version != SCHEMA_VERSION:
            raise ValueError(
                f"不支持的 schema_version={version}（当前支持 {SCHEMA_VERSION}）"
            )
        return cls(
            record_id=data["record_id"],
            source=data["source"],
            created_at=data["created_at"],
            me=data["me"],
            initial=Initial.from_json(data["initial"]),
            steps=tuple(Step.from_json(s) for s in data.get("steps", [])),
            advice=tuple(Advice.from_json(a) for a in data.get("advice", [])),
            outcome=data.get("outcome"),
            schema_version=version,
            ruleset=data.get("ruleset", RULESET),
        )
