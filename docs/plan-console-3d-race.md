# 掌机资产「双路线并跑」计划（代码 vs Blender）

> 日期：2026-11-02。目标仓库 `/Users/nickxiao/Documents/ChatGPT/ddz`。
> 相关：[web-console.md](web-console.md)（视觉基准）、[web-3d-pipeline.md](web-3d-pipeline.md)（管线原理）、
> [glb-toolchain.md](glb-toolchain.md)（工具链）、[refs/console-3view/](refs/console-3view/)（三视图）。

---

## 0. 目标与判定口径

**同一台掌机，用两种资产生产方式各做一版，接到同一套前端渲染管线上，用同一把尺量，择优。**

不是比"哪个工具更高级"，而是比四件事：

| 维度 | 为什么算 |
|---|---|
| **画面**（对着三视图） | 用户要的"质量质感" |
| **体积** | 网页要能秒开 |
| **可复现/可 diff** | 这个仓库的作风：能一条命令重建、能进 code review |
| **迭代一次的成本** | 后面必然还要改（改倒角、加细节、换配色） |

---

## 1. 共同前提（两条路都要遵守）

- 依赖**全部本地化**，不许引 CDN（现有硬约束）。
- `node web/verify.mjs` 必须全绿；后端 `pytest` 不动。
- ⚠️ **不要碰并行 agent 正在改的文件**：`src/**`、`tests/**`、`web/app/{api,console,labels}.js`、`web/verify.mjs`。
  目前工作区里这些文件有别人的未提交改动（"牌局结束/赢家"功能），**不要 commit、不要 revert**。
- 视觉基准 = 三视图（`docs/refs/console-3view/`）。**允许**倒角高光、AO、环境光渐变、柔影；
  信息层（记牌条/座位牌/操作台）仍保持点阵字 + 硬边框 + 限色。
- 所有产物**可复现**：建模脚本入库，一条命令能从源码重建 GLB。

---

## 2. 共享前端工作流（两条路**共用**，先做一次）

这是"同一把尺"的前提。**无论模型从哪来，这部分只做一遍**：

1. **vendored three 附件**（本地，不引 CDN）：
   ```
   web/vendor/three/examples/jsm/loaders/GLTFLoader.js
   web/vendor/three/examples/jsm/utils/BufferGeometryUtils.js
   web/vendor/three/examples/jsm/utils/SkeletonUtils.js
   ```
   依据：`three@0.187` 的 `GLTFLoader` 实际 import 了后两者。若走 meshopt 再加 `libs/meshopt_decoder.module.js`。
2. **`scene.js` 增加外壳来源开关**：`?shell=code|glb`（默认 `code`，保证不回归）
   - `glb`：加载 `web/assets/console.glb`，**按节点名取件**（约定见 §3.3）
   - `code`：走现有手写几何（保底，可随时切回）
3. **光照/材质管线**（按 `web-3d-pipeline.md` 第 7.5 节的 8 步，取前 5 步）：
   `RoomEnvironment` + `PMREMGenerator` 作 `scene.environment`（`envMapIntensity` 压低）
   → `MeshStandardMaterial` 分级（外壳 / 玻璃 / 金属圈）
   → 接触阴影铺底 → `outputColorSpace` + `toneMapping` → 保持 RT 的 MSAA。
4. **屏幕**：仍是离屏 `RenderTarget`，只是把它的 texture 赋给 GLB 里名为 `Screen` 的材质。
5. **截图 harness**：`tools/console-shot.mjs`，固定 1440 / 900 / 420 三档、固定 dsf、固定相机与光照，
   输出 `a-*.png` / `b-*.png`，**两条路用同一个脚本**。

> 完成标准：`?shell=code` 与 `?shell=glb`（先放一个占位 GLB）都能出图，`verify.mjs` 仍全绿。

---

## 3. 计划 A —— 代码建模（build123d → GLB）

**思路：把现在手写的 `ExtrudeGeometry` 换成真正的参数化 CAD。**
现在的 `octaShape + extrude` 本质是"穷人的 CAD"；`build123d` 提供的是 OpenCASCADE B-rep：
`fillet()` / `chamfer()` / 布尔开孔 都是一等公民，正好治我们最痛的"倒角做不出来"。

### 3.1 工具
- `cadgen`（PyPI，MIT）+ `build123d` —— 已由安装 agent 装到本机
- 无需 Blender、无需 GUI、无 API Key

### 3.2 步骤（每步都有验证）
| # | 做什么 | 验证 |
|---|---|---|
| A1 | `tools/console-code/build_console.py`：用 build123d 按三视图比例写**机身主体**（八角轮廓 + 大倒角） | `cadgen` 跑通，CAD viewer 里看到剪影对上三视图 |
| A2 | 加**屏幕开孔**（真布尔挖洞）+ 屏框分层（外壳/内衬/玻璃，三个零件三个颜色） | 导出 GLB，节点名齐全 |
| A3 | 加**机顶记牌槽 + 扬声器孔阵**（真孔，布尔）+ 螺丝（真圆柱凹） | 同上 |
| A4 | 加**按键井**：按 HTML 键位在正面做凹槽/凸台，与 `setKeys()` 反投影的位置对齐 | 截图对比键位是否咬合 |
| A5 | 材质：外壳 / 侧边带 / 金属圈 / 玻璃，各给 baseColor + roughness + metalness | GLB 里 `materials[]` 数量与命名正确 |
| A6 | 导出 `web/assets/console.glb`，过 `gltf-transform optimize` + `gltf_validator` | 体积与校验结果记录在案 |

### 3.3 节点命名约定（两条路都遵守，前端按名取件）
```
Shell            机身主体           材质: shellMat
SideBand         侧边带             材质: bandMat
Bezel            屏框               材质: bezelMat
Screen           屏幕玻璃面          材质: screenMat  ← 运行时替换成 RenderTarget 贴图
Trim             金色细线/铭牌底板     材质: goldMat
KeyWell_L / KeyWell_R   左右按键凹槽   （不含具体按键）
```
其余（螺丝、扬声器、肩块）可以合并进 `Shell`，只要不影响取件。

### 3.4 风险
- build123d 是**B-rep 精确建模**：曲面/有机造型不擅长（我们这台是硬表面，正好合适）。
- 倒角半径太小会失败（OCC 常见），需要试半径；脚本里要有 try 降级。
- 导出 GLB 的**三角面密度**由 OCC 网格化参数控制，要控制到合理面数。

### 3.5 时间盒
**4–6 小时**（我这边）出 A 版可对比的 GLB；不追求一次到位，先到"剪影 + 倒角 + 屏框 + 键井"。

---

## 4. 计划 B —— Blender headless（bpy → GLB）

**思路：用建模工具的完整能力，重点是三件我现在做不到的事 —— 真 Bevel、UV 展开、AO 烘焙。**

### 4.1 工具
- Blender（`brew install --cask blender`，由安装 agent 确认）
- 技能：`scenario-labs/skills@scenario-blender-expert`（覆盖硬表面/UV/烘焙/导出，**明确支持 headless**）
- 运行方式：`blender -b --factory-startup --python-exit-code 1 -P build_console.py`（不开 GUI）

### 4.2 步骤
| # | 做什么 | 验证 |
|---|---|---|
| B1 | `tools/console-blender/build_console.py`：按三视图建基础体（机身/屏框/槽/键位） | `blender -b -P` 跑通，输出 `console.blend` |
| B2 | **Bevel 修改器**：外壳轮廓 + 每条硬边；硬边显式 `shade_flat`，圆角显式 `shade_smooth` | 渲染截图看边缘是否出现窄高光带 |
| B3 | **UV 展开**（smart project 或按缝） | UV 覆盖无明显拉伸 |
| B4 | **烘 AO** 到贴图（Cycles bake），并可选烘一张 normal | 贴图文件入库，体积记录 |
| B5 | **PBR 材质**：Principled BSDF，外壳/侧带/金圈/玻璃四套；AO 接进 base color 或单独 AO | GLB 里材质完整 |
| B6 | 导出 `web/assets/console.glb`（`bpy.ops.export_scene.gltf(export_format='GLB')`）+ 优化/校验 | 同 A6 |

### 4.3 风险
- 装 Blender ~1GB；本机是否已装由安装 agent 报告。
- `bpy` 脚本对 API 版本敏感（Blender 5.x 与 4.x 有差异），要锁版本。
- 产出物是**二进制 + 脚本**：`.blend` 不能 code review，只能靠脚本复现；所以脚本必须自包含。
- AO 烘焙耗时与贴图分辨率成正比，先 1K 试。

### 4.4 时间盒
**6–10 小时**（我这边，含装环境与调 API）；同样先到"剪影 + 倒角 + UV + AO + 材质"。

---

## 5. 对比协议（同一把尺）

### 5.1 视觉
- 用 `tools/console-shot.mjs` 出三档截图（1440 / 900 / 420），同一相机、同一光照、同一 dsf。
- 并排贴出 A / B / **现状 code** 三列。
- 按更新后的 7 条验收（[`agents/acceptance-review.md`](agents/acceptance-review.md) 第 4 条已改成"按三视图"）逐条打分，
  **由独立 sub-agent 评**（作者不自评），给出 PASS/FAIL + 证据 + 最差项。

### 5.2 非视觉
| 指标 | 怎么量 |
|---|---|
| GLB 体积 | `ls -l` + `gltf-transform inspect` |
| 首帧加载 | 浏览器 `performance` 从 load 到 shell 就绪 |
| 可复现 | 删掉 GLB，跑脚本能否一键重建 |
| 可 diff | `git diff` 是否能看出改了什么（代码路线强项） |
| 迭代一次成本 | 改"倒角半径 0.3→0.5"要几步、几分钟 |

### 5.3 决策规则
1. 视觉有**明显**提升（不是"差不多"）→ 选提升大的那条；
2. 视觉接近 → 选**可复现/可 diff/迭代成本低**的那条（大概率是代码路线）；
3. 两条都不明显好于现状 → **回退到现状 + 只上光照管线**，不为建模而建模。

---

## 6. 并行执行方式

- **共享前端**（§2）：我先做，两条路依赖它。
- **路线 A**：我直接做（cadgen 已装）。
- **路线 B**：交给一个 worker agent 做（装 Blender + 写 bpy 脚本），**它只允许在 `tools/console-blender/` 与 `web/assets/console-b.glb` 下写**。
- 冲突避免：A 写 `tools/console-code/` + `web/assets/console-a.glb`；B 写 `tools/console-blender/` + `web/assets/console-b.glb`；
  前端只读 `web/assets/`，两边互不覆盖。
- 两条路都**不要** commit 别人的文件（见 §1）。

---

## 7. 停止条件

任一条路出现下面情况就**停手并报告**，不要硬撑：
- 工具装不上且没有等价替代；
- 3 次尝试后剪影仍对不上三视图；
- 产物体积 > 8MB（网页不可接受）且压不下去。
