"""评测：用仿真真值衡量推断质量，并与基线对照。不修改记录内容。"""

from ddz.evaluation.calibration import (
    SCORE_CAVEAT,
    Bucket,
    CalibrationReport,
    NotCalibratableError,
    calibrate,
)
from ddz.evaluation.metrics import Metrics, MissingGroundTruthError, evaluate

__all__ = [
    "Metrics", "MissingGroundTruthError", "evaluate",
    "SCORE_CAVEAT", "Bucket", "CalibrationReport", "NotCalibratableError", "calibrate",
]
