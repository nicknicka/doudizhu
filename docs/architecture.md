# 架构

## 分层与依赖方向

```
输入源(source) ──┐
                 ├──> 记录层(record) ──┬──> 决策模型(policy) ──┐
仿真/评测 ───────┘                     └──> 手牌推断(inference) ─┴──> 展示(cli / web)
```

依赖方向是单向的：

- `source` 只依赖 `record`
- `policy`、`inference` 只依赖 `record`
- `cli`、`web` 可以依赖全部
- **`record` 不反向依赖任何业务模块**

这条规则是整个"输入源可插拔"说的唯一实现方式：只要 `record` 不认得上层，换输入源就只需要新增一个 `source` 实现。

## 模块职责

| 模块 | 路径 | 职责 | 明确不做 |
|---|---|---|---|
| 输入源 | `src/ddz/source/` | 把外部的局面变成统一的记录对象；手动录入、仿真自对弈 | 不碰模型、不做推断 |
| 记录层 | `src/ddz/record/` | 定义 Schema、序列化、反序列化、回放 | 不做任何博弈计算 |
| 决策模型 | `src/ddz/policy/` | 加载 ONNX 权重、构造特征、输出各合法动作的分数 | 不推断对手手牌 |
| 手牌推断 | `src/ddz/inference/` | 约束过滤 + 粒子采样，输出另两家手牌分布 | 不选最终出牌 |
| 评测 | `src/ddz/evaluation/` | 用仿真真值算命中率、对数似然，与基线对照 | 不修改记录内容 |
| 命令行 | `src/ddz/cli/` | S1 的入口：局面进、建议出 | 不含业务逻辑 |
| 前端 | `web/` | S3 的展示：局面、候选胜率、手牌热力图 | 不含业务逻辑 |

## 接口契约

以下为契约草案，S1 实现时可能微调签名，但职责边界不变。

### 记录层

```python
def save(record: MatchRecord, path: Path) -> None
def load(path: Path) -> MatchRecord
def replay(record: MatchRecord) -> Iterator[Snapshot]
```

**硬性要求**：`load(save(x)) == x`，且 `replay` 能仅凭记录重建每一步的局面。这条由 `tests/` 中的自动化测试保证。

### 输入源

```python
class InputSource(Protocol):
    def records(self) -> Iterator[MatchRecord]: ...
```

- `source/manual.py` —— 手动结构化录入（S1 首选）
- `source/sim.py` —— 用 RLCard 自对弈生成，带真值，供评测（S2）

两者产出**同一种** `MatchRecord`，不写格式转换器。

### 决策模型

```python
class Policy(Protocol):
    def scores(self, snapshot: Snapshot, actions: list[Action]) -> list[float]: ...
```

实现：`policy/douzero.py`，按当前位置（`landlord` / `landlord_up` / `landlord_down`）选择对应的 ONNX 模型。

### 手牌推断

```python
class Inferencer(Protocol):
    def infer(self, snapshot: Snapshot, n_particles: int) -> list[list[str]]: ...
```

输出若干组"另两家手牌"的候选分配（粒子），频率即概率。

## 关键约定

### 牌的表示

统一使用 RLCard / DouZero 的字符表：`3 4 5 6 7 8 9 T J Q K A 2 B R`，其中 `B` 是小王、`R` 是大王。手牌以字符串数组存储，按上表顺序规范化排序。

### 动作表示

```json
{"type": "play", "cards": ["3", "3", "3"]}
{"type": "pass"}
```

不用 `"pass"` 这类魔法字符串，避免与牌面混淆。

### 真值的位置

仿真局面带全部玩家真实手牌，真实对局没有。因此 `initial` 中对手手牌是**可选字段**，评测代码必须在字段缺失时明确拒绝，而不是当成空手牌。

## 目录树

```
src/ddz/
├── __init__.py
├── source/
├── record/
├── policy/
├── inference/
├── evaluation/
└── cli/
tests/            单元测试与 round-trip 测试
scripts/          一次性工具（下载权重、生成评测集）
web/              S3 前端
models/           权重存放（本地，不入库）
data/             运行期数据（本地，不入库）
```
