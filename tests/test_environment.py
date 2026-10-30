"""环境契约的冒烟测试。

守护「环境锁定」这件事本身：依赖被锁死且真的锁住了、仿真器可用、
真值可读、推理权重可加载，且没有把 PyTorch 混进来。

这些断言只描述我们**依赖的外部契约**，不碰任何业务逻辑。
"""

from __future__ import annotations

import importlib.util
import random
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = REPO_ROOT / "models" / "douzero_WP"
LOCK_FILE = REPO_ROOT / "requirements.lock.txt"

WEIGHT_FILES = ("landlord.onnx", "landlord_up.onnx", "landlord_down.onnx")

# 每个位置模型的 x 宽度。数字来自 DouZero 的特征构造，上游一旦改动会暴露。
# z 的形状是 (batch, seq_len, 162)，其中 batch 与 seq_len 在计算图里是符号维度。
# DouZero 的约定是 seq_len = 5：取最近 15 手，每 3 手（一轮）折成一行，
# 3 * 54 = 162 列（见上游 _action_seq_list2array 的 reshape(5, 162)）。
EXPECTED_X_WIDTH = {
    "landlord.onnx": 373,
    "landlord_up.onnx": 484,
    "landlord_down.onnx": 484,
}
Z_FEATURE_DIM = 162
Z_SEQ_LEN = 5


@pytest.fixture()
def seeded_env():
    """一个已播种的斗地主仿真环境，每个测试一份，互不影响。"""
    import rlcard

    env = rlcard.make("doudizhu")
    env.seed(42)
    return env


def parse_lock(path: Path) -> dict[str, str]:
    """把 `名称==版本` 形式的锁定清单读成字典，忽略注释与空行。"""
    pins: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, pinned = line.partition("==")
        assert separator and pinned, f"lock 行格式异常：{line}"
        pins[name] = pinned
    return pins


def test_installed_versions_match_lock():
    """已装版本必须与 requirements.lock.txt 逐项一致。

    这条让锁文件成为真正的约束而非说明文档：间接依赖一旦浮动到别的版本，
    这里立刻会红，而不是等到某天行为悄悄变了才发现。
    """
    pins = parse_lock(LOCK_FILE)
    assert pins, "锁定清单不应为空"

    mismatched: dict[str, tuple[str, str]] = {}
    for name, expected in pins.items():
        try:
            actual = version(name)
        except PackageNotFoundError:
            actual = "(未安装)"
        if actual != expected:
            mismatched[name] = (expected, actual)

    assert not mismatched, f"以下包与 lock 不符（期望, 实际）：{mismatched}"


def test_numpy_stays_on_major_version_1():
    """依赖锁生效：环境固定在端到端实测过的 numpy 1.x 上。

    注意这不是硬约束 —— 实测 numpy 2.4.6 下 RLCard 同样能跑通完整一局，
    且两个上游库都未使用 numpy 2 移除的 API。锁 1.x 是为了让环境等于
    验证过的那一套配置。切换前需补一轮完整规则覆盖测试。
    详见 docs/environment.md。
    """
    import numpy as np

    assert np.__version__.startswith("1."), f"numpy 应为 1.x，实际是 {np.__version__}"


def test_pytorch_is_absent():
    """推理走 ONNX Runtime，环境里不应出现 PyTorch。"""
    assert importlib.util.find_spec("torch") is None, "不应安装 PyTorch"


def test_simulator_runs_a_full_game(seeded_env):
    """仿真器能跑完一局，且 1000 步内收敛。"""
    random.seed(42)
    state, _ = seeded_env.reset()

    for _ in range(1000):
        if seeded_env.is_over():
            break
        action = random.choice(state["raw_legal_actions"])
        state, _ = seeded_env.step(action, raw_action=True)

    assert seeded_env.is_over(), "对局未在 1000 步内结束"


def test_simulator_exposes_ground_truth_hands(seeded_env):
    """仿真器能给出三家真实手牌 —— 这是整套评测的真值来源。"""
    seeded_env.reset()

    hands = seeded_env.get_perfect_information()["hand_cards"]
    assert len(hands) == 3, "应有三个玩家的手牌"
    assert all(isinstance(h, str) for h in hands)
    assert sum(len(h) for h in hands) == 54, "三家手牌加总应为 54 张"


def test_simulator_action_api_shape(seeded_env):
    """钉住我们依赖的动作接口形状。

    RLCard 1.2.0 与旧教程不同：legal_actions 是 dict（动作 ID → 编码向量），
    真正的动作字符串在 raw_legal_actions；step() 默认吃动作 ID，
    传字符串必须加 raw_action=True。
    """
    state, _ = seeded_env.reset()

    assert isinstance(state["legal_actions"], dict)
    assert isinstance(state["raw_legal_actions"], list)
    assert all(isinstance(a, str) for a in state["raw_legal_actions"])

    # 传裸字符串而不加 raw_action=True 必须报错，否则说明接口变了
    with pytest.raises(TypeError):
        seeded_env.step("pass")


@pytest.mark.skipif(
    not all((MODELS_DIR / f).exists() for f in WEIGHT_FILES),
    reason="权重未下载，先执行 python scripts/download_models.py",
)
def test_onnx_weights_load_and_run():
    """三个位置模型都能加载，输入输出形状与预期一致，并能跑出数值。"""
    import numpy as np
    import onnxruntime as ort

    for name in WEIGHT_FILES:
        sess = ort.InferenceSession(
            str(MODELS_DIR / name), providers=["CPUExecutionProvider"]
        )
        inputs = {i.name: i for i in sess.get_inputs()}
        assert set(inputs) == {"x", "z"}, f"{name} 的输入应为 x 与 z"

        x_width = EXPECTED_X_WIDTH[name]
        assert inputs["x"].shape == ["batch", x_width], f"{name} 的 x 宽度不符"

        z_shape = inputs["z"].shape
        assert len(z_shape) == 3, f"{name} 的 z 应为三维"
        assert z_shape[-1] == Z_FEATURE_DIM, f"{name} 的 z 末维不符"

        feed = {
            "x": np.zeros((1, x_width), dtype=np.float32),
            "z": np.zeros((1, Z_SEQ_LEN, Z_FEATURE_DIM), dtype=np.float32),
        }
        out = sess.run(["values"], feed)[0]
        assert out.shape == (1, 1), f"{name} 的输出形状不符"
        assert np.isfinite(out).all(), f"{name} 输出了非有限值"
