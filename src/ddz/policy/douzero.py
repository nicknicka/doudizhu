"""DouZero-WP 决策模型：ONNX 权重 + CPU 推理。

三个位置各一个模型（地主 / 地主上家 / 地主下家），按当前该谁动来选。

**输出是 Q 值，不是校准过的胜率。** 选 WP（胜率目标）版本只是让它的语义更接近
"期望胜负"，不代表可以直接当概率读。对外一律称"模型给出的估计"。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from ddz.policy.features import build_features
from ddz.rules import legal_actions
from ddz.record.schema import Action, Advice, Candidate, MatchRecord
from ddz.record.state import Snapshot, derive

DEFAULT_MODEL_DIR = Path("models/douzero_WP")

MODEL_FILES: dict[str, str] = {
    "landlord": "landlord.onnx",
    "landlord_up": "landlord_up.onnx",
    "landlord_down": "landlord_down.onnx",
}

INPUT_NAMES = ("x", "z")
OUTPUT_NAME = "values"


class NotYourTurnError(RuntimeError):
    """当前不该给建议 —— 要么轮不到我方，要么牌局已经结束。"""


class MissingWeightsError(FileNotFoundError):
    """权重不存在时给出可执行的提示，而不是一个原始的 FileNotFoundError。"""


class DouZeroPolicy:
    """按位置加载 ONNX 权重并对合法动作打分。"""

    def __init__(self, model_dir: Path | str = DEFAULT_MODEL_DIR) -> None:
        self.model_dir = Path(model_dir)
        self._sessions: dict[str, object] = {}

    def model_path(self, position: str) -> Path:
        try:
            return self.model_dir / MODEL_FILES[position]
        except KeyError:
            raise ValueError(f"未知位置：{position}") from None

    def _session(self, position: str):
        if position not in self._sessions:
            import onnxruntime as ort

            path = self.model_path(position)
            if not path.exists():
                raise MissingWeightsError(
                    f"缺少权重 {path}。先执行：\n"
                    f"  .venv/bin/python scripts/download_models.py"
                )
            self._sessions[position] = ort.InferenceSession(
                str(path), providers=["CPUExecutionProvider"]
            )
        return self._sessions[position]

    def score(self, snapshot: Snapshot, actions: list[Action]) -> np.ndarray:
        """给每个合法动作打分，返回与 ``actions`` 同序的一维数组。"""
        if not actions:
            raise ValueError("没有合法动作可打分")

        x, z = build_features(
            position=snapshot.acting,
            my_hand=snapshot.my_hand,
            legal_actions=[list(a.cards) for a in actions],
            other_hand_cards=snapshot.pool,
            num_cards_left=snapshot.num_cards_left,
            played_cards=snapshot.played_cards,
            last_move=snapshot.last_move,
            last_move_dict=snapshot.last_move_dict,
            card_play_action_seq=snapshot.card_play_action_seq,
            bomb_num=snapshot.bomb_num,
        )
        session = self._session(snapshot.acting)
        values = session.run([OUTPUT_NAME], {INPUT_NAMES[0]: x, INPUT_NAMES[1]: z})[0]
        return np.asarray(values, dtype=np.float64).reshape(-1)

    def rank(self, snapshot: Snapshot, actions: list[Action], top_k: int = 3):
        """按分数从高到低排序，返回 (候选列表, 诊断信息)。"""
        if top_k < 1:
            raise ValueError("top_k 必须为正")

        scores = self.score(snapshot, actions)
        if scores.shape[0] != len(actions):
            raise AssertionError("模型输出个数与动作数不一致")

        # 同分时按动作本身的规范写法排序，保证结果完全确定
        def tie_break(item):
            action = item[1]
            return (action.kind, action.cards)

        order = sorted(
            zip(scores, actions), key=lambda item: (-float(item[0]), tie_break(item))
        )
        candidates = [Candidate(action=a, score=float(s)) for s, a in order[:top_k]]

        return candidates, self._diagnostics(snapshot, len(actions), top_k)

    def _diagnostics(self, snapshot: Snapshot, n_scored: int, top_k: int) -> dict:
        return {
            "model": str(self.model_path(snapshot.acting)),
            "position": snapshot.acting,
            "n_actions_scored": n_scored,
            "top_k": top_k,
            "score_kind": "Q 值（期望回报），不是校准胜率",
            "n_pool_cards": len(snapshot.pool),
        }

    def advise(self, record: MatchRecord, top_k: int = 3) -> Advice:
        """给一个局面产出建议。轮不到我方时抛 ``NotYourTurnError``。"""
        snapshot = derive(record)
        if snapshot.finished:
            raise NotYourTurnError(
                f"牌局已经结束（{snapshot.winner} 先出完牌），没有可建议的一手。"
            )
        if snapshot.acting != record.me:
            raise NotYourTurnError(
                f"当前该 {snapshot.acting} 行动，而记录里的我方是 {record.me}；"
                "只有轮到我方时才给建议。"
            )
        candidates, diagnostics = self.rank(snapshot, legal_actions(snapshot), top_k=top_k)
        return Advice(
            after_step=len(record.steps),
            position=snapshot.acting,
            model=diagnostics["model"],
            candidates=candidates,
            diagnostics=diagnostics,
        )
