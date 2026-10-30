# 斗地主决策助手 — 设计共识

- 状态：已定稿（待开工）
- 定稿日期：2026-10-31
- 项目目录：`/Users/nickxiao/Documents/ChatGPT/ddz`

---

## 1. 目标与身份

- **第一身份**：后端 / 全栈求职作品
- **第二身份**：个人斗地主进步工具
- **讲述主线**：可插拔输入源的决策服务 + 一份 Schema 两用 + round-trip 保证 + 可复现评测
- **领域亮点**：标准三人斗地主的未知手牌推断（约束过滤 + 粒子采样）

一句话版本：*一个能读取牌局局面、给出候选出牌与胜率估计、并把每局完整落盘供复盘的决策服务；它的深度来自"在信息不全的情况下推断对手手牌"。*

## 2. 范围

**在范围内**

- 标准三人斗地主（54 张，17/17/20，叫分 1–3 分）
- 从「地主已定、底牌已知」的出牌阶段开始
- 叫分信息**只作为输入特征**，不做叫分决策
- 输入源：手动结构化录入优先，adapter 可插拔
- 输出：2–3 个候选动作 + DouZero-WP 胜率估计；每局落盘供复盘

**明确不做**

- 不训练任何模型
- 不做叫分决策
- 不做 OCR / 屏幕识别 / 平台对接
- 不做 PerfectDou 对比
- 不做神经网络形式的推断模型
- **不做线上真人平台的实时辅助**：架构上留位置，但不实现、不发布

## 3. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | Python 3.11 | RLCard / DouZero 生态 |
| 推理 | **ONNX Runtime（CPU）** | 权重有 ONNX 版本，可完全不用 PyTorch；省磁盘、启动快 |
| 仿真与真值 | RLCard | 环境自带全部玩家真实手牌，可当评测真值 |
| 决策模型 | DouZero-**WP**（胜率目标） | 按胜负训练，比 ADP 版本更贴近"胜率"语义 |
| 推断 | 约束过滤 + 粒子采样 | 零训练、每条结论可解释 |
| 后端 | FastAPI | 本机已装 |
| 前端 | 极简页面（S3） | 只为展示 |

依赖固定：venv + `numpy<2`（老代码用到了 numpy 2.x 移除的 API）。

## 4. 模型权重：已核实可用

**结论：现成权重存在，且可直连下载，不需要自己训练。**

| 来源 | 内容 | 备注 |
|---|---|---|
| `kwai/DouZero` README | `douzero_ADP` / `douzero_WP` 各三个位置模型 | 官方托管在 Google Drive / 百度网盘（提取码 4624） |
| **HuggingFace `palemoky/douzero-baselines`** | **ADP / WP / SL 三套 × 三位置 × (ckpt + onnx)** | 直连、免登录、Apache-2.0，全套 107.8 MB |
| PyPI `douzero` 1.1.0 | 仅 30 KB 源码 | **不含权重**，别混淆 |
| GitHub Releases | 无附件 | 权重不在 Release 里 |

**只取 WP 的 ONNX 三个文件：5.83 + 6.06 + 6.06 ≈ 18 MB。**

模型按位置分开，共三个：

- `checkpoints/douzero_WP/landlord.onnx`
- `checkpoints/douzero_WP/landlord_up.onnx`
- `checkpoints/douzero_WP/landlord_down.onnx`

另外镜像里还有 `sl`（监督学习基线，用人类对局训练）。论文结论是纯 SL 弱于自我博弈的 RL，因此**只作为对照项，不作为主模型**。

## 5. 数据契约

- **一份 JSON Schema，仿真局面与真实手局共用**，不写格式转换器
- **必须 round-trip**：`load(save(x)) == x`，且能原样回放
- 这条以**自动化测试**形式存在，S1 就立起来，不留到后期

记录字段：

- 局面：我方手牌 / 底牌 / 已出牌序列 / 各家剩余张数 / 我的位置
- 候选动作 + 模型给出的估计
- 真值（仅仿真局有，可选字段）
- 元信息：Schema 版本、来源（sim / real）、时间戳

## 6. 阶段与验收

| 阶段 | 内容 | 完成判定 |
|---|---|---|
| S0 | venv + `numpy<2` + rlcard + onnxruntime 跑通一局；ONNX 推断结果与 ckpt 路径一致；拿真实一局比对四条规则 | 环境可复现，规则无差异 |
| S1 | CLI：给定局面 → 3 个候选动作 + 胜率估计；记录 round-trip 测试 | 同一局面重跑结果一致；round-trip 测试通过 |
| S2 | 约束过滤 + 粒子采样推断 → 仿真真值评测 | N 局上产出可复现的命中率数字，N 与参数写进 README，并与随机基线对照 |
| S3 | 极简 Web（局面 / 候选胜率 / 手牌热力图）+ README + 2 分钟录屏 | 陌生人看完录屏能说清"做了什么、难在哪" |

S0 需要比对的四条规则：顺子最少 5 张、连对最少 3 对、飞机带翅膀的张数规定、炸弹与火箭的压制关系。

**时间不够时的砍伐顺序**：UI → 真实对局录入 → 校准 → 推断主线（最后才砍）。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| numpy 2.x 与老代码不兼容 | S0 第一件事，锁 `numpy<2` |
| 磁盘仅剩 15 Gi | pip 加 `--no-cache-dir`；走 ONNX 路线避开 PyTorch |
| 实际平台规则与 RLCard 实现有差异 | S0 逐条比对四条规则，不一致必须重新评估 |
| DouZero 输出是 Q 值，**不等于校准过的胜率** | WP 版本缓解但不等价；对外措辞必须准确 |
| 不完美信息下有质量上限 | 用随机基线对照，陈述"比瞎猜强多少"，不宣称"准" |

## 8. 事实核查记录（2026-10-31）

| 结论 | 证据 |
|---|---|
| DouZero 靠自我博弈训练，零人类数据 | ICML 2021 论文 + README |
| RLCard 的 Game 对象持有全部玩家真实手牌 | `rlcard/games/doudizhu/game.py`：`players[i].current_hand`；而默认 state 把另两家手牌**合并**返回（`_get_others_current_hand`） |
| DouZero 的 `InfoSet` 可自行构造，无需跑其环境 | `douzero/env/env.py`：`get_obs(infoset)` 只依赖 `InfoSet` 字段 |
| 本机环境 | macOS 27.0.1 / arm64 / Python 3.11.17 / numpy 2.4.4 / fastapi 0.115.0；无 torch、无 rlcard；磁盘余 15 Gi |

## 9. 进展

- [x] 设计确认（2026-10-31）
- [x] 仓库与远端对接：`git@github.com:nicknicka/doudizhu.git`
- [x] 框架与文档落地
- [ ] S0 执行

相关文档：[architecture.md](architecture.md) · [data-schema.md](data-schema.md) · [roadmap.md](roadmap.md)
