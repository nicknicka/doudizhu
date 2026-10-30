# 记录格式与 round-trip 约定

## 目标

**一份 Schema，两类数据共用。**

- 仿真局面（自对弈产生，带真值）
- 真实对局（手动录入，无真值）

两者用同一种结构存储，因此 S2 的评测和 S3 的复盘跑的是**同一条数据通路**，不需要格式转换器。

## 硬性要求

1. **round-trip**：`load(save(x)) == x`，结构等价
2. **可回放**：仅凭记录能逐步重建每个决策点的局面
3. 以上两条由 `tests/` 中的自动化测试保证，S1 阶段就立起来

## 字段定义

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema_version` | int | 是 | 当前为 `1` |
| `record_id` | str | 是 | 唯一标识 |
| `source` | str | 是 | `sim` 或 `real` |
| `created_at` | str | 是 | ISO 8601 带时区 |
| `ruleset` | str | 是 | 规则集标识，当前 `standard-3p-v1` |
| `me` | str | 是 | 我方位置：`landlord` / `landlord_up` / `landlord_down` |
| `initial.my_hand` | list[str] | 是 | 我方起始手牌 |
| `initial.three_landlord_cards` | list[str] | 是 | 三张底牌 |
| `initial.opponents` | object | 否 | **真值**，仅仿真局有 |
| `steps` | list[Step] | 是 | 出牌序列 |
| `outcome` | object | 否 | 最终结果，仅完整对局有 |

### Step

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `index` | int | 是 | 从 0 开始 |
| `player` | str | 是 | 出牌者位置 |
| `action` | object | 是 | `{"type": "play", ...}` 或 `{"type": "pass"}` |
| `cards_left` | object | 是 | 各家剩余张数 |
| `candidates` | list | 否 | 我方决策点上模型给出的候选与估计 |
| `truth_hand` | list[str] | 否 | 该玩家出牌前的手牌，仅仿真局有 |

### 牌的表示

字符表：`3 4 5 6 7 8 9 T J Q K A 2 B R`（`B` = 小王，`R` = 大王），与 RLCard / DouZero 一致。手牌按此顺序规范化排序后存储。

## 示例（仿真局，含真值）

```json
{
  "schema_version": 1,
  "record_id": "sim-000001",
  "source": "sim",
  "created_at": "2026-10-31T12:00:00+08:00",
  "ruleset": "standard-3p-v1",
  "me": "landlord_up",
  "initial": {
    "my_hand": ["3", "4", "7", "9", "T", "Q", "K", "A", "2", "B"],
    "three_landlord_cards": ["5", "J", "R"],
    "opponents": {
      "landlord": ["3", "3", "6", "8", "9", "J", "Q", "K", "2", "2"],
      "landlord_down": ["4", "5", "6", "7", "8", "T", "J", "A", "A", "B"]
    }
  },
  "steps": [
    {
      "index": 0,
      "player": "landlord",
      "action": {"type": "play", "cards": ["8", "8"]},
      "cards_left": {"landlord": 18, "landlord_up": 10, "landlord_down": 10},
      "truth_hand": ["3", "3", "6", "8", "9", "J", "Q", "K", "2", "2"]
    },
    {
      "index": 1,
      "player": "landlord_up",
      "action": {"type": "play", "cards": ["9", "9"]},
      "cards_left": {"landlord": 18, "landlord_up": 8, "landlord_down": 10},
      "candidates": [
        {"action": {"type": "play", "cards": ["9", "9"]}, "score": 0.58},
        {"action": {"type": "play", "cards": ["Q", "Q"]}, "score": 0.51},
        {"action": {"type": "pass"}, "score": 0.44}
      ],
      "truth_hand": ["3", "4", "7", "9", "T", "Q", "K", "A", "2", "B"]
    }
  ],
  "outcome": {"winner": "landlord"}
}
```

## 示例（真实对局，无真值）

```json
{
  "schema_version": 1,
  "record_id": "real-20261031-01",
  "source": "real",
  "created_at": "2026-10-31T21:30:00+08:00",
  "ruleset": "standard-3p-v1",
  "me": "landlord_down",
  "initial": {
    "my_hand": ["3", "5", "6", "8", "9", "J", "J", "Q", "A", "2"],
    "three_landlord_cards": ["5", "J", "R"]
  },
  "steps": [
    {
      "index": 0,
      "player": "landlord_down",
      "action": {"type": "play", "cards": ["9"]},
      "cards_left": {"landlord": 20, "landlord_up": 17, "landlord_down": 9}
    }
  ]
}
```

## 版本策略

`schema_version` 只在**破坏性变更**时递增。升级时在 `record/` 中提供显式迁移函数，并保留旧版本样例作为回归测试数据。
