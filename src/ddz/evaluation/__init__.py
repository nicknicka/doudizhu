"""评测：用仿真真值衡量推断质量，并与基线对照。不修改记录内容。"""

from ddz.evaluation.metrics import Metrics, MissingGroundTruthError, evaluate

__all__ = ["Metrics", "MissingGroundTruthError", "evaluate"]
