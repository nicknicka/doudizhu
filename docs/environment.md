# 环境与依赖

这份文档记录的是**实测通过**的环境，不是照上游文档抄来的。下面的每个版本号、每条结论都对应一次实际执行。

## 实测平台

| 项 | 值 |
|---|---|
| 操作系统 | macOS 27.0.1（Build 26A434） |
| 架构 | arm64（Apple Silicon） |
| Python | 3.11.17（Homebrew） |
| 推理后端 | ONNX Runtime 1.31.1，CPU |
| 是否用 GPU | 否 |

## 复现步骤

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install --no-cache-dir -e ".[dev]"
.venv/bin/python scripts/download_models.py
.venv/bin/python -m pytest
```

四步都实测通过。两个补充说明：

- 装依赖时加 `--no-cache-dir`：模型与依赖会占掉 2–4 GB，对磁盘紧张的环境有必要。
- 下载脚本是**幂等**的：文件已存在且大小正确时直接跳过，可以放心重复执行。

## 依赖清单

直接依赖锁死在 `pyproject.toml`，含间接依赖的完整解析结果在 `requirements.lock.txt`。

| 包 | 锁定版本 | 用途 |
|---|---|---|
| numpy | 1.26.4 | 特征编码、数值计算 |
| rlcard | 1.2.0 | 仿真环境与评测真值 |
| onnxruntime | 1.31.1 | 推理（CPU） |
| pytest | 9.2.0 | 测试（dev extra） |

**不安装 PyTorch。** 权重有 ONNX 版本，这条路线省下约 1–2 GB 磁盘，也省掉一整套 CUDA 相关的麻烦。测试里有一条断言专门守着这件事（`test_pytorch_is_absent`）。

## 模型权重

来源是公开镜像，免登录直连：

| 文件 | 字节数 | 位置 |
|---|---|---|
| `landlord.onnx` | 5,834,135 | `models/douzero_WP/` |
| `landlord_up.onnx` | 6,061,463 | `models/douzero_WP/` |
| `landlord_down.onnx` | 6,061,463 | `models/douzero_WP/` |

合计约 18 MB。**权重不进 Git 历史**，新克隆的仓库需要先跑一次下载脚本。

脚本按字节数校验完整性——下载被截断会直接报错，而不是留下一个坏文件让后面莫名其妙地失败。

## 模型接口（实测形状）

三个位置模型都是两个输入、一个输出：

| 模型 | 输入 `x` | 输入 `z` | 输出 `values` |
|---|---|---|---|
| `landlord.onnx` | `(batch, 373)` | `(batch, seq_len, 162)` | `(batch, 1)` |
| `landlord_up.onnx` | `(batch, 484)` | `(batch, seq_len, 162)` | `(batch, 1)` |
| `landlord_down.onnx` | `(batch, 484)` | `(batch, seq_len, 162)` | `(batch, 1)` |

两点注意：

- 计算图里 `batch` 与 `seq_len` 是**符号维度**，不是固定值。特征语义由上游 `_process_action_seq` 决定，其约定是 `seq_len = 15`。
- 两个农民模型的 `x` 比地主模型宽（484 vs 373），因为可见信息不同。具体特征含义由后续 ticket 负责。

**推理延迟实测：0.47 ms / 次**（CPU，batch = 7，模拟 7 个合法动作）。实时性不是这个项目的瓶颈。

## 实测发现（踩到的坑）

### 1. numpy 版本：原判断有误

计划里写的理由是"老代码用到 numpy 2.x 移除的 API"。**实测推翻了它**：

- 用 numpy **2.4.6** + rlcard 1.2.0 跑完整一局：**通过**，真值也能正常读取。
- 在已安装的 rlcard 全量源码里搜 numpy 2 移除的 API（`np.float_` / `np.NaN` / `np.alltrue` 等）：**无匹配**。
- 在 DouZero 的 `env.py` 里搜同一批 API：**无匹配**。它只用到 `array` / `concatenate` / `float32` / `hstack` / `int8` / `newaxis` / `random` / `repeat` / `zeros`，这些在 numpy 2 下都正常。

所以 numpy 锁 1.x 是**保守选择，不是硬约束**：锁的是我们真正端到端验证过的那套配置。保留这个锁的理由是成本低、风险低；但它不是"必须"。完整的规则面覆盖没有在 numpy 2 下跑过，这是保留锁的唯一实质理由。要切到 numpy 2 的话，先补一轮完整规则覆盖测试即可。

### 2. RLCard 1.2.0 的动作接口与旧教程不同

这是最容易踩的一个：

- `state["legal_actions"]` 是 **dict**（动作 ID → 编码向量），**不是**动作字符串列表。
- 动作字符串在 `state["raw_legal_actions"]`。
- `env.step(action)` 默认吃**动作 ID**；传字符串必须写成 `env.step(action, raw_action=True)`，否则报 `TypeError`。

测试 `test_simulator_action_api_shape` 钉住了这三点——上游改了就红。

### 3. RLCard 的观测里泄漏了对手手牌

`state["raw_obs"]["others_hand"]` 给的是**另外两家合并后的完整手牌**（开局就是 37 个字符）。这不是真实牌局里能看到的信息。

后果很直接：**手牌推断模块必须主动回避这个字段**。一旦误用，推断看起来"特别准"，但那是在偷看答案——而且因为字段名看起来人畜无害（`others_hand`），这个错误很容易悄悄发生。后续实现推断时，可见信息应当只从 `current_hand` / `played_cards` / `num_cards_left` / `seen_cards` / `trace` 里取。

### 4. DouZero 的手牌并集特征，必须由推断来填

DouZero 的特征里有一项 `other_hand_cards`，上游的构造是：

```python
self.info_sets[acting].other_hand_cards = []
for pos in positions:
    if pos != acting:
        self.info_sets[acting].other_hand_cards += self.info_sets[pos].player_hand_cards
```

也就是**另外两家真实手牌的并集**——不是估计值，是牌局引擎里的真值。

这条把项目的主线从"加分项"变成了"前置条件"：**在真实牌局里用 DouZero，这个特征必须由手牌推断来填**。推断不是锦上添花，它是模型能否用于真实局面的前提。

## 验证方式

`tests/test_environment.py` 六条断言，`pytest` 全绿：

| 测试 | 守护什么 |
|---|---|
| `test_numpy_stays_on_major_version_1` | 依赖锁生效 |
| `test_pytorch_is_absent` | 没有混入 PyTorch |
| `test_simulator_runs_a_full_game` | 仿真器可用且能收敛 |
| `test_simulator_exposes_ground_truth_hands` | 评测真值来源存在 |
| `test_simulator_action_api_shape` | 动作接口形状没变 |
| `test_onnx_weights_load_and_run` | 权重可加载、形状符合预期（权重缺失时跳过） |
