"""从 DouZero 的完整动作 Q 值估计“模型动作选择概率”。

这是展示用的派生量，不是胜率：先对全部合法动作的 Q 值做温度 ``1.0`` 的
softmax；对手回合再把每个合法手牌假设下的 softmax 等权平均。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

from ddz.cards import normalize
from ddz.inference.sampling import Distribution
from ddz.policy.douzero import DouZeroPolicy
from ddz.record.schema import Action
from ddz.record.state import Snapshot
from ddz.rules import legal_actions

PROBABILITY_TEMPERATURE = 1.0
PROBABILITY_KIND = "模型动作选择概率"


@dataclass(frozen=True)
class ActionProbability:
    action: Action
    probability: float
    score: float | None = None


def softmax(scores: list[float], temperature: float = PROBABILITY_TEMPERATURE) -> list[float]:
    """稳定 softmax；先减最大值，避免 exp 溢出。"""
    if not scores:
        raise ValueError("没有分数可归一化")
    if temperature <= 0:
        raise ValueError("温度必须为正")

    maximum = max(scores)
    weights = [math.exp((score - maximum) / temperature) for score in scores]
    total = math.fsum(weights)
    return [weight / total for weight in weights]


def my_action_probabilities(
    snapshot: Snapshot, policy: DouZeroPolicy
) -> tuple[tuple[ActionProbability, ...], dict]:
    """对当前行动者的全部合法动作给出 softmax 概率。"""
    actions = legal_actions(snapshot)
    if not actions:
        raise ValueError("这个局面下没有合法动作")

    ranked, diagnostics = policy.rank(snapshot, actions, top_k=len(actions))
    probabilities = softmax([candidate.score for candidate in ranked])
    items = tuple(
        ActionProbability(
            action=candidate.action,
            probability=probability,
            score=candidate.score,
        )
        for candidate, probability in zip(ranked, probabilities)
    )
    return items, {
        **diagnostics,
        "probability_kind": PROBABILITY_KIND,
        "temperature": PROBABILITY_TEMPERATURE,
    }


def opponent_action_probabilities(
    snapshot: Snapshot, policy: DouZeroPolicy, dist: Distribution
) -> tuple[tuple[ActionProbability, ...], dict]:
    """逐手牌假设算完整动作 softmax，再把同一动作的概率等权平均。"""
    totals: dict[tuple[str, tuple[str, ...]], float] = {}
    actions: dict[tuple[str, tuple[str, ...]], Action] = {}
    diagnostics: dict = {}

    for particle in dist.particles:
        other = next(p for p in dist.opponents if p != snapshot.acting)
        hypothesis = replace(
            snapshot,
            me=snapshot.acting,
            my_hand=particle.hands[snapshot.acting],
            pool=normalize(snapshot.my_hand + particle.hands[other]),
        )
        legal = legal_actions(hypothesis)
        if not legal:
            continue

        ranked, diagnostics = policy.rank(hypothesis, legal, top_k=len(legal))
        probabilities = softmax([candidate.score for candidate in ranked])
        for candidate, probability in zip(ranked, probabilities):
            key = (candidate.action.kind, candidate.action.cards)
            actions[key] = candidate.action
            totals[key] = totals.get(key, 0.0) + probability / len(dist.particles)

    if not actions:
        raise ValueError("没有任何手牌假设存在合法动作")

    items = tuple(
        ActionProbability(action=action, probability=probability)
        for key, probability in totals.items()
        for action in (actions[key],)
    )
    items = tuple(
        sorted(items, key=lambda item: (-item.probability, item.action.kind, item.action.cards))
    )
    return items, {
        **diagnostics,
        "probability_kind": PROBABILITY_KIND,
        "temperature": PROBABILITY_TEMPERATURE,
        "n_particles": len(dist.particles),
        "aggregation": "particle_mean",
    }
