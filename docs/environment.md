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
.venv/bin/python -m pip install --no-cache-dir -r requirements.lock.txt
.venv/bin/python -m pip install --no-cache-dir -e . --no-deps
.venv/bin/python scripts/download_models.py
.venv/bin/python -m pytest
```

五步都实测通过。三点说明：

- **依赖从锁定清单装，不让 pip 现场解析。** 直接 `pip install -e ".[dev]"` 的话，`pyproject.toml` 只约束直接依赖，间接依赖（protobuf、packaging 之类）仍会浮动到当下最新版——那样的"复现"只是碰巧一致。
- 第二步的 **`--no-deps` 是故意的**：依赖已由第一步装好，这一步只把本项目本身装上，不需要 pip 再解析一遍。
- 装依赖时加 **`--no-cache-dir`**：模型与依赖会占掉 2–4 GB。下载脚本则是**幂等**的，文件已存在且大小正确时直接跳过。

## 依赖清单

直接依赖声明在 `pyproject.toml`；**真正用于安装的是 `requirements.lock.txt`**，它记录了含间接依赖的完整解析结果。

锁定清单不是说明书：`test_installed_versions_match_lock` 会逐项比对准已装版本，任何间接依赖一旦浮动，测试立刻失败。

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

### 3. 「对手手牌并集」是公开信息，不是泄漏

`raw_obs["others_hand"]` 精确等于另外两家手牌的并集，`state["obs"][54:108]` 是同一信息的编码形态。

初看像泄漏，其实是**牌的守恒**——每张牌只可能在我手上、别人手上、已出的牌堆里，所以

```
另两家并集 = 全牌 − 我的手 − 已出的牌
```

会数牌的牌手都能算出这个集合，它相对于公开信息的信息量是**零**。真正隐藏的是**分配**（哪张牌在谁手上），那才是要推断的东西。

完整核对见 [rules.md](rules.md)——那里也记录了这条结论**曾经被判断错**、以及是怎么纠正过来的。

实践含义：牌池由记录层自己推导（真实牌局那条路径没有仿真器的便利字段可用），理由是**可移植性**，不是保密。

### 4. DouZero 的 `other_hand_cards` 特征就是那个公开牌池

上游的构造是：

```python
self.info_sets[acting].other_hand_cards = []
for pos in positions:
    if pos != acting:
        self.info_sets[acting].other_hand_cards += self.info_sets[pos].player_hand_cards
```

也就是另两家**当前手牌的并集**。按上一条，它就是「全牌 − 我的手 − 已出的牌」，**公开可推导** —— 在真实牌局里也能直接算出来，不需要先有推断模块。

这一节早期写的是「必须由推断来填，推断是接入模型的前置条件」，**那个结论是错的**。推断仍是项目主线，但它是独立的价值，不是模型的前置条件。

## 验证方式

`tests/test_environment.py` 七条断言，`pytest` 全绿：

| 测试 | 守护什么 |
|---|---|
| `test_installed_versions_match_lock` | 锁定清单与实际安装逐项一致 |
| `test_numpy_stays_on_major_version_1` | numpy 主版本锁生效 |
| `test_pytorch_is_absent` | 没有混入 PyTorch |
| `test_simulator_runs_a_full_game` | 仿真器可用且能收敛 |
| `test_simulator_exposes_ground_truth_hands` | 评测真值来源存在 |
| `test_simulator_action_api_shape` | 动作接口形状没变 |
| `test_onnx_weights_load_and_run` | 权重可加载、形状符合预期（权重缺失时跳过） |
