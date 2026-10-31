# 记录格式

## 目标

**一份 Schema，两类数据共用**：仿真局面（带真值）与真实牌局（无真值）。因此不需要格式转换器，S2 的评测与 S3 的复盘跑的是同一条数据通路。

## 设计原则：只存推不出来的东西

已出的牌、各家剩余张数、最近的出牌、按顺序的出牌历史、炸弹数——全都能从 `initial` + `steps` 推出来，所以**不写进文件**。同一份事实只有一个来源，才不会出现两处不一致。

推导逻辑在 `src/ddz/record/state.py`，行为由 `tests/test_record.py` 盯着。

## 硬性要求

1. **round-trip**：`load(save(x)) == x`，结构等价
2. **字节稳定**：同一记录两次序列化结果逐字节相同（排序键 + 固定缩进）
3. **可回放**：仅凭记录能逐步重建每个决策点的局面

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | int | 是 | 当前 `1`；不匹配直接拒绝，不做猜测 |
| `record_id` | str | 是 | 唯一标识 |
| `source` | str | 是 | `sim` 或 `real` |
| `created_at` | str | 是 | ISO 8601 带时区。**命令行不会重新生成它**，所以重跑同一输入输出不变 |
| `ruleset` | str | 是 | 当前 `standard-3p-v1` |
| `me` | str | 是 | 我方位置：`landlord` / `landlord_down` / `landlord_up` |
| `initial` | object | 是 | 开局信息 |
| `steps` | list | 是 | 出牌序列，`index` 必须从 0 连续 |
| `advice` | list | 否 | 模型给出的建议 |
| `outcome` | object | 否 | 最终结果，仅完整对局有 |

### `initial`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `my_hand` | list[str] | 是 | **我方**起始手牌（地主 20 张、农民 17 张） |
| `three_landlord_cards` | list[str] | 是 | 三张底牌（公开信息） |
| `opponents` | object | 否 | 对手手牌**真值**，仅仿真局面有 |

对手手牌是可选字段，这一点是刻意的：真实牌局根本拿不到。任何消费方在字段缺失时都必须明确处理，不能当成空手牌。

**仿真记录一定带这个字段**（`source: sim`），它是评测真值的来源。评测关心的是**每个决策点**的真实手牌，而它由「开局手牌 − 已经出的牌」推出来，所以不必逐步另存——这也是"只存推不出来的东西"那条原则的又一次兑现。

### `steps[]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `index` | int | 从 0 连续，不连续直接报错 |
| `player` | str | 出牌者位置 |
| `action` | object | 见下 |

### `advice[]`

| 字段 | 类型 | 说明 |
|---|---|---|
| `after_step` | int | 这个建议是在走完多少步之后给出的 |
| `position` | str | 当时该谁动 |
| `model` | str | 实际使用的权重文件 |
| `note` | str | 固定措辞，提醒这不是真实胜率 |
| `candidates` | list | `{action, score}`，按 score 降序 |
| `diagnostics` | object | 用了哪个模型、给多少个动作打了分等 |

## 牌的表示

字符表：`3 4 5 6 7 8 9 T J Q K A 2 B R`（`B` 小王、`R` 大王），与 RLCard / DouZero 一致。

## 动作的表示

```json
{"type": "play", "cards": ["3", "3", "3"]}
{"type": "pass"}
```

不使用 `"pass"` 这类魔法字符串——避免与牌面混淆。`Action` 在构造时就校验：`play` 必须带牌，`pass` 不能带牌。

## 示例

```json
{
  "schema_version": 1,
  "record_id": "fixture-seed7-landlord_up",
  "source": "sim",
  "created_at": "2026-10-31T00:00:00+08:00",
  "ruleset": "standard-3p-v1",
  "me": "landlord_up",
  "initial": {
    "my_hand": ["3", "4", "5", "5", "6", "7", "8", "9", "T", "T", "J", "J", "K", "K", "2", "2", "2"],
    "three_landlord_cards": ["7", "9", "2"]
  },
  "steps": [
    {"index": 0, "player": "landlord", "action": {"type": "play", "cards": ["8", "8", "8"]}},
    {"index": 1, "player": "landlord_down", "action": {"type": "pass"}}
  ],
  "advice": [
    {
      "after_step": 2,
      "position": "landlord_up",
      "model": "models/douzero_WP/landlord_up.onnx",
      "note": "模型给出的估计，不是真实胜率",
      "candidates": [
        {"action": {"type": "play", "cards": ["2", "2", "2"]}, "score": 0.4587},
        {"action": {"type": "pass"}, "score": 0.4582}
      ],
      "diagnostics": {
        "position": "landlord_up",
        "n_actions_scored": 2,
        "score_kind": "Q 值（期望回报），不是校准胜率"
      }
    }
  ]
}
```

## 已知限制：必须从开局录起

`initial.my_hand` 是**开局**手牌，牌池由 `全牌 − 我方手牌 − 已出的牌` 推出。所以录入必须从第一手开始；不录前史的话，牌池会偏大（把已经打掉的牌也算进去），而模型收到的就是错的输入。

要支持"中途冷启动"，需要显式存下此前的出牌（例如给 `initial` 加 `prior_played`），并且要接受一个代价：`z` 特征依赖**最近 15 手的顺序**，而中途开始录是拿不到这个顺序的，只能当空历史喂进去。

## 版本策略

`schema_version` 只在**破坏性变更**时递增。解析时只接受当前版本，其余直接报错——不做猜测式兼容。升级时提供显式迁移函数，并保留旧版本样例作为回归数据。
