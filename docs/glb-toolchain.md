# 网页 3D 资产（GLB）生产链工具调查

> 调研日期：2026-11-02（Asia/Shanghai）  
> 目标：为当前斗地主展示页的“像素风掌机 GLB 路线”查清模型生成、程序化建模、优化/质检、浏览器加载和 Blender 自动化的具体工具。  
> 证据规则：标为“**事实**”的内容有一手来源；标为“**推断**”的内容是工程判断，不代表厂商或项目结论。找不到一手依据的地方明确写“未找到一手依据”。

## 0. 事实与统计口径

- **事实：** 本文的 GitHub 星数与“最后 commit”均在 2026-11-02 通过 GitHub REST API 查询。星数取 `stargazers_count`；最后 commit 取默认分支第一条 commit 的 `commit.committer.date`，不是 release 日期。对应 API 形式为 `https://api.github.com/repos/<owner>/<repo>` 和 `https://api.github.com/repos/<owner>/<repo>/commits?per_page=1`。
- **事实：** skill 安装量来自 `npx skills find blender` 与 `npx skills find '3d modeling'` 的输出；skill 来源仓库的星数和最后 commit 同样用 GitHub API 查询。本文不安装任何 skill，只给出候选和安装命令。
- **推断：** 本文的“活跃/维护/低活跃”只根据最后 commit 日期分层，不评价项目质量或厂商 SLA。近 90 天内有 commit 记为“活跃”，90–365 天记为“维护”，超过 365 天记为“低活跃/停更”。
- **事实：** 本机当前已安装的 skill 中没有 Blender 专项 skill；`oil-ui/references/media.md` 只在实时 3D 章节给出通用 three.js/glTF 约束，不提供 Blender 建模、UV、烘焙或导出工作流。
- **事实：** 当前仓库的 three.js 是 `0.187.0`：`web/vendor/three.module.min.js` 内注明原始文件为 `/npm/three@0.187.0/build/three.module.js`。本文的 three.js 文件清单按 `three@0.187.0` 的官方 npm 包实际源码核对。
- **事实：** 当前仓库没有 `three/examples/jsm`，只有 `web/vendor/three.module.min.js`；要接 GLB，仍需补入三个官方 addon 及其传递依赖。

---

## 1. TL;DR：两条最短路径

### 路径 A：不装 Blender，用免费代码 CAD / 网格工具

**事实：** 这条路不通向商业模型生成 API，而是用本地 Python 库直接建模/导出：`build123d` 可 `export_gltf(..., binary=True)` 生成 GLB；CadQuery 的 `Assembly.export("out.glb")` 也可直接生成 GLB；`trimesh` 可直接 `export_glb(...)`；`vedo` 官方 `write()` 不支持 GLB/GLTF，只能先导 OBJ/PLY 再转换。

**最短操作链：**

1. 用 `build123d` 或 CadQuery 写参数化硬表面模型，导出 BRep/STEP 中间件和 GLB。
2. 如果模型要拆件、修网格或做统一转换，用 `trimesh` 处理；如果已有 OBJ/PLY，再转 GLB。
3. 用 `gltf-transform optimize` 或 `gltfpack -c` 优化。
4. 用 Khronos `gltf_validator` 校验 GLB。
5. three.js 补 `GLTFLoader` 及其必需依赖；如果用 meshopt，再加载 `meshopt_decoder.module.js`。

**推断：** 对掌机外壳、面板和按键井这类“尺寸/结构可明确参数化”的硬表面，代码 CAD 成型可靠；但它不替你做游戏级倒角策略、UV 排布、AO 烘焙和材质 look-dev。若目标是最终质感而不只是几何正确，路径 B 更合适。

### 路径 B：装 Blender，用 `bpy` + 现成 skill 工作流

**事实：** Blender 官方支持 `blender --background --python script.py` 的无头命令行执行。脚本可以：

- 加 Bevel 修改器；
- 调 `bpy.ops.uv.smart_project()` 做自动 UV；
- 配置 Cycles bake 后调 `bpy.ops.object.bake(...)` 烘 AO/纹理；
- 调 `bpy.ops.export_scene.gltf(filepath=..., export_format='GLB')` 导出 GLB；
- 导出时还能启用 Blender 的 glTF Meshopt/Draco 选项，或调用 gltfpack。

**最短操作链：**

1. 安装 Blender（macOS 也可只用命令行运行，不打开 GUI）。
2. `blender --background --python build_console.py`
3. 脚本完成：基础体/倒角 → Smart UV → AO bake → PBR 材质 → GLB 导出。
4. `gltf-transform optimize` 或 `gltfpack -c` 再优化。
5. `gltf_validator` 校验。
6. three.js `GLTFLoader` 加载，`RoomEnvironment` + `PMREMGenerator` 建环境光。

**推断：** 如果目标是“像掌机实物、边缘有可信高光、屏幕/按键有凹槽”，Blender 无头脚本是两条路里更短的人工控制路径。MCP 不是这条路径的必要组件：`bpy` 脚本本身就可以完整跑在 CI/终端里。

---

## 2. 免费/开源模型生成

### 2.1 仓库、许可、星数与活跃度

| 模型 | 一句话定位 | 官方仓库 | 星数 / 最后 commit | 许可 | 活跃度判断（按最后 commit） | 付费/密钥 | macOS 无 GUI |
|---|---|---|---|---|---|---|---|
| TripoSR | 单图快速前馈重建 | [VAST-AI-Research/TripoSR](https://github.com/VAST-AI-Research/TripoSR) | **7273** / **2026-06-04** | MIT | 维护（约 5 个月前） | 免费 | **事实：** 提供 `python run.py`；**未找到官方 macOS 支持声明**。文档要求 PyTorch/CUDA，默认约 6GB VRAM |
| InstantMesh | 单图 → 稀疏视图 LRM → 网格 | [TencentARC/InstantMesh](https://github.com/TencentARC/InstantMesh) | **4584** / **2025-01-03** | Apache-2.0 | 低活跃/停更（约 22 个月前） | 免费 | **事实：** 提供 `python run.py`；**未找到官方 macOS 支持声明**。官方推荐 CUDA >= 12.1、xformers；**未找到官方最低 VRAM 数字** |
| Hunyuan3D-2 | 单图/多视图形状 + 纹理生成 | [Tencent-Hunyuan/Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2) | **15276** / **2025-10-28** | 非 OSI 的 Tencent Hunyuan 3D 2.0 Community License；排除 EU、UK、South Korea | 低活跃/停更（约 12 个月前） | 免费，无 API key | **事实：** README 写支持 macOS、Windows、Linux；可用 Python/本地 API server。Apple Silicon 全功能仍需按自定义扩展逐项验证 |
| TRELLIS | Structured Latent 的文本/图像/多图 → 3D | [microsoft/TRELLIS](https://github.com/microsoft/TRELLIS) | **14165** / **2026-10-27** | MIT；部分子模块另有许可 | 活跃 | 免费 | **事实：** 官方只测试 Linux + NVIDIA GPU；**不能按事实说 macOS 可运行** |
| Stable Fast 3D | 单图快速重建 + UV/材质预测 | [Stability-AI/stable-fast-3d](https://github.com/Stability-AI/stable-fast-3d) | **1918** / **2025-01-22** | Stability AI Community License；见下方商用限制 | 低活跃/停更（约 21 个月前） | 免费；**需要 Hugging Face gated access token** | **事实：** README 写 Mac Silicon MPS 支持是实验性的；也支持 CPU；MPS 在 M1 Max 64GB 上测试过 |

### 2.2 多视图能力、显存、输出

| 模型 | 官方多视图？ | 官方显存/平台 | 主要输出 | 备注 |
|---|---|---|---|---|
| TripoSR | **否。** 核心定义为单图；README 的“多路径”是批量处理多张独立图片，不是把多张图联合成同一物体 | 默认单图约 **6GB VRAM**；官方示例在 NVIDIA A100 上 <0.5s；安装说明以 CUDA 为主 | `run.py --model-save-format glb` 可导出 GLB，默认 OBJ；也支持 texture baking | MIT 包含源码、预训练模型和 demo |
| InstantMesh | **否。** 官方定义为 single image → sparse-view reconstruction；输入仍是单图 | 推荐 Python >=3.10、PyTorch >=2.1、CUDA >=12.1、xformers；demo 可用双 GPU 节省内存 | 默认 OBJ；`--export_texmap` 可导出带 UV 纹理的 OBJ/MTL；没有官方 GLB 输出 | 活跃度低，且 macOS/CUDA 依赖不友好 |
| Hunyuan3D-2 | **是。** 有 `Hunyuan3D-2mv` 多视图 shape 模型；另有 multiview texture pipeline | **事实：** shape generation 6GB VRAM；shape + texture 合计 16GB；官方 README 明写支持 macOS/Windows/Linux | 输出 `trimesh` 对象，可保存 GLB/OBJ；2.0 的纹理步骤与 PBR 能力要按具体模型核对，PBR 模型在 Hunyuan3D-2.1 新闻中出现 | 许可有 EU/UK/South Korea 地域排除，商用前必须逐条核对 |
| TRELLIS | **是。** 官方 `example_multi_image.py` 展示 3 张图输入；README 说明 multi-image conditioning 是无训练的 tuning-free 方案，不保证所有输入都最优 | **事实：** Linux 测试；至少 16GB NVIDIA GPU；A100/A6000 验证；CUDA Toolkit 需编译子模块 | mesh、radiance field、3D Gaussian；可从输出提取 GLB，示例给了 `to_glb(...); glb.export("sample.glb")` | MIT 主代码；部分子模块不同许可，需单独核对 |
| Stable Fast 3D | **否。** README 明确 single image；`run.py` 支持多个图像路径是逐张推理 | CUDA 默认约 6GB VRAM；MPS 实验性，官方建议少于 32GB 统一内存时跑 CPU；MPS 在 M1 Max 64GB 测试 | GLB | 需要先在 Hugging Face 申请 gated model access；Stability Community License 免费商用一般要求年收入 <$1M、注册并署名，超过后需企业许可 |

**推断：** 对当前掌机资产，若必须在本地免费跑且坚持多视图，Hunyuan3D-2 和 TRELLIS 是仅有的明确选项；但一个官方支持 CUDA/Linux 更强，一个官方声明 macOS。若要走 macOS 无 GUI，Stable Fast 3D 是唯一在 README 明确写 MPS/CPU 路径的项目，但它不支持多视图。  
**结论：** 在当前“6 张视图 + macOS 无 GUI + 低摩擦”约束下，本地开源模型没有一项同时满足三者；因此本版不再推荐商业 API，而是改用 Blender 脚本或代码 CAD 作为免费主线。

---

## 3. 程序化/代码建模

### 3.1 公共字段总表

| 工具 | 一句话定位 | 官方来源 | 星数 / 最后 commit | 许可 | 付费/密钥 | macOS 无 GUI | 直接 GLB |
|---|---|---|---|---|---|---|---|
| Blender bpy | 完整 DCC 的无头 Python 自动化 | [命令行参数](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html) / [Python API](https://docs.blender.org/api/current/) | **21497** / **2026-11-01** | GNU GPL | 免费、无密钥 | **事实：** 可以，`--background --python` | **事实：** 可以，`bpy.ops.export_scene.gltf(...)` |
| trimesh | Python 网格处理/生成/导入导出 | [官方文档](https://trimesh.org/) | **3716** / **2026-10-24** | MIT | 免费、无密钥 | **事实：** 纯 Python 脚本，可无 GUI | **事实：** 可以，`export_glb(...)` |
| vedo | VTK 可视化/网格工具 | [官方文档](https://vedo.embl.es/) | **2274** / **2026-10-28** | MIT | 免费、无密钥 | **事实：** 可脚本运行 | **事实：** 官方 `write()` 支持扩展列表不含 `.glb/.gltf`；需先导 OBJ/PLY 再转换，或使用它的 Three.js JSON |
| build123d | 代码式 CAD/BRep，面向参数化零件 | [Import/Export](https://build123d.readthedocs.io/en/latest/import_export.html) | **3584** / **2026-10-30** | Apache-2.0 | 免费、无密钥 | **事实：** Python 库，无 GUI 依赖 | **事实：** 可以，`export_gltf(..., binary=True)` |
| CadQuery | 代码式 CAD/BRep，Assembly 支持 glTF | [Import/Export](https://cadquery.readthedocs.io/en/latest/importexport.html) | **6034** / **2026-10-24** | Apache-2.0 | 免费、无密钥 | **事实：** Python 库，无 GUI 依赖 | **事实：** `Assembly.export("out.glb")`；不是任意 `Workplane.export` 都支持 glTF |

### 3.2 Blender `bpy`：能做什么，怎么落地

- **事实：** 官方命令行文档明确有 `--background` 和 `--python`，所以可以在 macOS 终端里跑，不必开 GUI。
- **事实：** Bevel Modifier 是官方内置生成修改器，可用 `bpy.ops.object.modifier_add(type='BEVEL')` 或直接操作 modifier 数据添加；适合做硬表面倒角。
- **事实：** UV 方面可调 `bpy.ops.uv.smart_project()`；它不是“自动生成完美 UV”，但可以作为无 GUI 的首版 unwrap。
- **事实：** Cycles bake 官方支持把 AO/程序纹理烘到 image texture；脚本能调 `bpy.ops.object.bake(...)`，但依然要先准备 UV、材质节点、图像节点和 bake 设置。
- **事实：** glTF 导出官方 API 是 `bpy.ops.export_scene.gltf(...)`，`export_format` 可选，文档还提供 `export_meshopt_compression_enable`、`export_draco_mesh_compression_enable` 和 built-in gltfpack 选项。
- **事实：** 因此“自动加 Bevel / 自动 UV / 烘 AO / 导出 glTF”都是官方可脚本化的，不是必须买第三方 Blender 插件。
- **推断：** 对我们的掌机，最有效的脚本顺序是：基础块面 → Bevel → 标记硬边/平滑 → Smart UV 或手工 seam → AO bake → PBR 材质 → GLB。自动 UV 可作为第一版，但按键井、屏幕开孔、侧面带仍可能需要 seam 微调。

### 3.3 `trimesh`、`vedo`、`build123d`/CadQuery 的边界

- **事实：** `trimesh.exchange.gltf.export_glb()` 直接导 binary glTF；还支持 `extension_webp` 和 `extension_draco` 选项，Draco 需要安装 `DracoPy`。
- **事实：** `vedo.file_io.write()` 的官方 docstring 支持 `vtk, vti, ply, obj, stl, byu, vtp, mhd, xyz, xml, tif, png, bmp`，没有 GLB/GLTF；所以不能说 vedo“直接导出 GLB”。它可以导 OBJ/PLY，再用 trimesh/glTF-Transform 转 GLB。
- **事实：** build123d 的 `export_gltf()` 有 `binary` 参数；`binary=True` 可输出 GLB，并且会导出 `TEXCOORD_0` UV；它还能给节点注入 PBR material。
- **事实：** CadQuery 的 glTF 导出针对 `Assembly`，用扩展名区分 `.gltf` 和 `.glb`；普通 `Workplane.export()` 的官方导出类型列表不含 glTF。
- **推断：** 对“掌机外壳/面板/按键井”这种强参数化硬表面，build123d/CadQuery 比 trimesh 更适合先做精确 BRep；但代码 CAD 不自动提供游戏级 UV、倒角高光策略和 PBR 材质设计，导出后仍应走 Blender/gltf-transform。

---

## 4. GLB 优化与质检工具链

### 4.1 公共字段总表

| 工具 | 一句话定位 | 官方来源 | 星数 / 最后 commit | 许可 | 付费/密钥 | macOS 无 GUI | 主要能力 |
|---|---|---|---|---|---|---|---|
| glTF-Transform | glTF 2.0 的 JS/TS SDK + CLI，适合可复现优化 | [仓库](https://github.com/donmccurdy/glTF-Transform) / [CLI 文档](https://gltf-transform.dev/cli) | **2057** / **2026-10-16** | MIT | 免费、无密钥 | **事实：** Node CLI，macOS 可用 | `optimize`、`inspect`、`prune`、`dedup`、`weld`、`reorder`、`draco`、`meshopt`、`resize`、`webp`、`etc1s`、`uastc` |
| gltfpack / meshoptimizer | 面向 GPU 的 glTF 几何/动画/纹理压缩 CLI | [仓库](https://github.com/zeux/meshoptimizer) / [gltfpack](https://github.com/zeux/meshoptimizer/tree/master/gltf) | **8766** / **2026-10-14** | MIT | 免费、无密钥 | **事实：** 原生二进制或 npm，macOS 可用 | 顶点缓存/overdraw/量化、meshopt `-c/-cc`、简化 `-si`、KTX2 `-tc`、WebP `-tw` |
| glTF-Validator | Khronos 官方 glTF 2.0 规范校验器 | [仓库](https://github.com/KhronosGroup/glTF-Validator) / [npm](https://www.npmjs.com/package/gltf-validator) | **475** / **2026-10-06** | Apache-2.0 | 免费、无密钥 | **事实：** 原生 CLI 可用；npm 包无 `bin`，需要自己写 Node 调用 | JSON 报告、GLB 容器/缓冲区/引用/图片/扩展校验 |

### 4.2 glTF-Transform 能做什么

**事实：** 官方 CLI 文档明确列出：

```bash
npm install --global @gltf-transform/cli

gltf-transform optimize input.glb output.glb --compress meshopt --texture-compress webp
gltf-transform inspect input.glb
gltf-transform prune input.glb output.glb
gltf-transform dedup input.glb output.glb
gltf-transform draco input.glb output.glb --method edgebreaker
gltf-transform meshopt input.glb output.glb --level medium
gltf-transform resize input.glb output.glb --width 1024 --height 1024
gltf-transform webp input.glb output.glb --slots "baseColor"
gltf-transform uastc input.glb output.glb --slots "{normalTexture,occlusionTexture,metallicRoughnessTexture}"
```

- **事实：** `optimize` 一键组合常见优化；官方也提醒了默认值不适合所有场景，复杂资产应配合 `inspect` 后逐项使用。
- **事实：** `inspect` 会报告几何/纹理/节点问题；它可以帮助判断体积是被几何、贴图还是 draw call 吃掉了。
- **事实：** 它支持 Draco、Meshopt、KTX2/Basis、WebP、AVIF/PNG/JPEG 等纹理/几何压缩路径。

### 4.3 gltfpack 能做什么

**事实：** gltfpack 官方说明：

```bash
gltfpack -i scene.gltf -o scene.glb
gltfpack -i scene.glb -o scene-compressed.glb -c
gltfpack -i scene.glb -o scene-compressed.glb -cc
gltfpack -i scene.glb -o scene-ktx2.glb -tc
gltfpack -i scene.glb -o scene-webp.glb -tw
gltfpack -i scene.glb -o scene-simplified.glb -si 0.5
```

- 会优化顶点 fetch/transform cache、量化几何、合并 draw call、裁剪/折叠节点、简化网格。
- `-c`/`-cc` 输出 `EXT_meshopt_compression`，浏览器端要调用 `GLTFLoader.setMeshoptDecoder(...)`。
- `-tc` 输出 KTX2/Basis，浏览器端需要 `KTX2Loader`。
- `-tw` 输出 WebP，需要支持 `EXT_texture_webp`。
- gltfpack 不保留任意 vendor/custom extension；Draco 等扩展在官方说明里明确不是它的支持对象。

### 4.4 校验

- **事实：** Khronos 官方 native CLI 的 `gltf_validator` 会输出 `<asset>.report.json`，包含问题列表和 asset stats；返回码在至少一个 error 时非零。
- **事实：** npm `gltf-validator` 的 `latest` 元数据里 `bin: null`，所以它不是开箱即用的命令行可执行文件；要用 npm 路径，需要在 Node 脚本里调 `validateBytes`，或使用 Khronos native binary。
- **推断：** 对 CI，推荐 native `gltf_validator`；对一次性 Node 工具链，推荐 `@gltf-transform/cli` + `gltf-validator` 库脚本。

### 4.5 硬表面小道具 GLB 的合理体积

**未找到一手依据：** Khronos glTF 规范、glTF-Transform 文档、gltfpack 文档和 Khronos Validator 文档都没有给出“网页中一个硬表面小道具应该小于多少 MB”的统一推荐值。模型-viewer 文档只给出一项可量化约束：**DRACO decoder 大于 100KB，只有当文件节省量明显大于 decoder 开销时才值得用 DRACO**。

**事实：** 我用 Khronos 官方 `glTF-Sample-Assets` 仓库实际读取了若干硬表面/小道具的 binary GLB 文件大小（这些文件内嵌原尺寸贴图，并非统一做过网页极限压缩）：

| 官方样本 | GLB 大小 |
|---|---:|
| Box | 1,664 B |
| BoxTextured | 5,956 B |
| Duck | 120,484 B |
| Fox | 162,852 B |
| DamagedHelmet | 3,773,916 B |
| ToyCar | 5,422,412 B |
| WaterBottle | 8,966,700 B |
| Lantern | 9,564,264 B |
| BoomBox | 10,614,184 B |
| AntiqueCamera | 17,540,348 B |

来源：Khronos [glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)；该仓库 star **1141**，最后 commit **2026-10-23**，许可证按每个模型分别声明（仓库 API 返回 `NOASSERTION`）。

**推断：** 官方样本说明“高质量、内嵌贴图的硬表面 GLB”可以是几 MB 到十几 MB；但它们不是网页首屏预算，不能据此把 10MB 当目标。对当前单掌机道具，我会给出一个明确标注为工程推断的预算：

- **主目标：0.5–2 MB/个**：meshopt 或 Draco 后的几何 + 1K WebP/KTX2 PBR 贴图；
- **更省：<0.5–1 MB**：512px 贴图、少量材质、合并 draw call、无高模细节；
- **可接受但需实测：2–5 MB**：更高的 2K/4K 贴图或更细几何；
- **>5–10 MB**：只有在页面确实以该模型为视觉主角、且延迟加载/海报占位/网络条件可控时才考虑。

这些区间是**工程推断**，不是官方标准；真正应绑定的是页面 LCP、首次可交互时间、目标设备和网络分布，而不是一个绝对 MB 数。

---

## 5. 浏览器端：three.js 接 GLB

### 5.1 官方文档与源码入口

| API | 官方文档 | `examples/jsm` 路径 |
|---|---|---|
| `GLTFLoader` | <https://threejs.org/docs/pages/GLTFLoader.html> | `examples/jsm/loaders/GLTFLoader.js` |
| `KTX2Loader` | <https://threejs.org/docs/pages/KTX2Loader.html> | `examples/jsm/loaders/KTX2Loader.js` |
| `DRACOLoader` | <https://threejs.org/docs/pages/DRACOLoader.html> | `examples/jsm/loaders/DRACOLoader.js` |
| `MeshoptDecoder` | 无独立 docs page；通过 `GLTFLoader.setMeshoptDecoder()` 使用 | `examples/jsm/libs/meshopt_decoder.module.js` |
| `RoomEnvironment` | <https://threejs.org/docs/pages/RoomEnvironment.html> | `examples/jsm/environments/RoomEnvironment.js` |
| `PMREMGenerator` | <https://threejs.org/docs/pages/PMREMGenerator.html> | 已包含在 `three.module.min.js` 核心导出中 |

### 5.2 vendored 文件清单（按 `three@0.187.0` 实际 import 关系）

当前仓库已有：

```text
web/vendor/three.module.min.js
```

要给浏览器加载未压缩的 GLB，至少补齐：

```text
web/vendor/three/examples/jsm/loaders/GLTFLoader.js
web/vendor/three/examples/jsm/utils/BufferGeometryUtils.js
web/vendor/three/examples/jsm/utils/SkeletonUtils.js
```

原因：`GLTFLoader.js` 在 `0.187.0` 里从 `../utils/BufferGeometryUtils.js` 导入 `toTrianglesDrawMode`，并从 `../utils/SkeletonUtils.js` 导入 `clone`；这两个文件也都从裸模块 `three` 导入。

如果采用 **Meshopt**（gltf-transform `meshopt` 或 gltfpack `-c/-cc`），再补：

```text
web/vendor/three/examples/jsm/libs/meshopt_decoder.module.js
```

装载方式：

```js
import { GLTFLoader } from './vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/three/examples/jsm/libs/meshopt_decoder.module.js';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
```

如果采用 **KTX2/Basis**（gltf-transform `etc1s/uastc` 或 gltfpack `-tc`），再补：

```text
web/vendor/three/examples/jsm/loaders/KTX2Loader.js
web/vendor/three/examples/jsm/utils/WorkerPool.js
web/vendor/three/examples/jsm/math/ColorSpaces.js
web/vendor/three/examples/jsm/libs/ktx-parse.module.js
web/vendor/three/examples/jsm/libs/zstddec.module.js
web/vendor/three/examples/jsm/libs/basis/basis_transcoder.js
web/vendor/three/examples/jsm/libs/basis/basis_transcoder.wasm
```

装载方式：

```js
import { KTX2Loader } from './vendor/three/examples/jsm/loaders/KTX2Loader.js';

const ktx2 = new KTX2Loader()
  .setTranscoderPath('./vendor/three/examples/jsm/libs/basis/')
  .detectSupport(renderer);
loader.setKTX2Loader(ktx2);
```

如果采用 **Draco**（gltf-transform `draco`），再补：

```text
web/vendor/three/examples/jsm/loaders/DRACOLoader.js
web/vendor/three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js
web/vendor/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm
web/vendor/three/examples/jsm/libs/draco/gltf/draco_decoder.js
```

装载方式：

```js
import { DRACOLoader } from './vendor/three/examples/jsm/loaders/DRACOLoader.js';

const draco = new DRACOLoader()
  .setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/');
loader.setDRACOLoader(draco);
```

**关键坑（事实）：** `GLTFLoader.js`、`KTX2Loader.js`、`DRACOLoader.js`、`RoomEnvironment.js` 和它们依赖的 utils 文件都用裸模块说明符 `from 'three'`。本地 vendored 时要么：

- 在页面加本地 import map，把 `"three"` 映射到 `./vendor/three.module.min.js`；或
- 修改每个 vendored 文件的 import 路径，直接指向本地 `three.module.min.js`。

**推断：** 对当前仓库，最小可行组合是：

```text
three.module.min.js
GLTFLoader.js
BufferGeometryUtils.js
SkeletonUtils.js
meshopt_decoder.module.js           # 如果模型用 meshopt
```

如果模型纹理最终选 WebP，则不需要 KTX2Loader；如果选 KTX2，才把 KTX2/WorkerPool/ktx-parse/zstddec/ColorSpaces/basis 文件一并本地化。Draco 与 Meshopt 不必同时用；对当前小道具，优先 Meshopt 以避免额外 >100KB Draco decoder 开销。

### 5.3 RoomEnvironment + PMREMGenerator

- **事实：** `RoomEnvironment` 是 three.js 官方 addon，路径为 `examples/jsm/environments/RoomEnvironment.js`，核心实现来自 model-viewer 项目。
- **事实：** `PMREMGenerator` 已在 three.js 核心导出中，不需要额外 addon 文件。
- **事实：** three.js `MeshStandardMaterial` 文档建议始终设置环境贴图；`RoomEnvironment` + `PMREMGenerator` 是无 HDRI 文件时的低摩擦 IBL 方案。
- **推断：** 对像素风掌机，不要在“像素化 + PBR + 环境反射”上互相打架：材质可以用 PBR，但环境光强度、roughness 和像素化分辨率要一起校准；屏幕和按键井优先靠 Bevel + AO + 可控 roughness，而不是堆强反射。

### 5.4 Google `<model-viewer>` 作为参考

| 项 | 事实 |
|---|---|
| 定位 | 官方 Web Component，可直接在 HTML 中加载 GLB/glTF，内置渲染、相机、光照/环境、动画、AR、loading 状态和可访问性能力 |
| 官方文档 | <https://modelviewer.dev/docs/> |
| 仓库 | <https://github.com/google/model-viewer> |
| 星数 / 最后 commit | **8303** / **2026-10-23** |
| 许可 | Apache-2.0 |
| 付费/密钥 | 免费、无密钥 |
| 本地化 | **事实：** 可本地 vendored；但 DRACO/KTX2/Meshopt 默认可能指向 CDN，文档提供 `dracoDecoderLocation`、`ktx2TranscoderLocation`、`meshoptDecoderLocation` 覆盖 |
| 对本项目 | **推断：** 它更适合作为“浏览器端 GLB 能力基线”和官网参考；我们已有 three.js 场景，直接接 `GLTFLoader` 的集成成本更低 |

---

## 6. Blender 自动化驱动：`bpy` 脚本 vs MCP

### 6.1 MCP 服务器

| 项目 | 一句话定位 | 官方仓库 | 星数 / 最后 commit | 许可 | 是否需要 Blender 常开 GUI |
|---|---|---|---|---:|---|
| MCP for Blender（原 `blender-mcp`） | 把 IDE/Agent 接到正在运行的 Blender，通过 addon socket 驱动它 | [ahujasid/mcp-for-blender](https://github.com/ahujasid/mcp-for-blender) | **32987** / **2026-10-29** | MIT | **事实：需要。** README 明确写“addon starts its server when Blender opens”，步骤要求打开 Blender、启用 addon、在 3D Viewport/N 面板启动 MCP Server；不是 headless CI 驱动 |

**事实：** PyPI 包名已从 `blender-mcp` 变成 `mcp-for-blender`；旧配置仍可工作，但新项目应使用新仓库和包名。  
**事实：** 其 README 中“headless setups”环境变量说明主要针对 AI 服务凭据注入，并不改变 addon 需要运行在 Blender 进程内的事实。  
**推断：** MCP 更适合“人看着 Blender 实时改、Agent 负责操作”的交互式工作流；不适合要求可复现、可审计、可在 macOS 无 GUI 服务器上跑的批量资产流水线。

### 6.2 直接 `bpy` 脚本 vs MCP

| 维度 | 直接 `bpy` 脚本 | MCP 驱动 |
|---|---|---|
| 运行方式 | `blender --background --python build.py` | Blender GUI + addon + MCP server + Agent |
| macOS 无 GUI | **事实：可以** | **事实：不满足**，README 要求 Blender 开着 |
| 可复现性 | 脚本文件是构建产物，能进 Git/CI | 依赖会话/Agent 状态，复现要额外记录 |
| 互动反馈 | 没有实时可视反馈，通常加预热渲染/自动截图 | 适合实时预览、人机来回 |
| 适合任务 | 固定资产生成、批处理、CI 校验、后期 exporter | 探索造型、让 Agent 现场修、教学/演示 |
| 推荐 | **推断：本项目的首选**：把掌机生成/导出写成 `bpy` 脚本 | 作为人工探索工具，不作为生产唯一入口 |

---

### 6.3 可直接用的 Blender skill / workflow 候选

以下安装量来自 2026-11-02 的 `npx skills find`；仓库事实来自 GitHub API。**事实与推断分区：** 安装量和仓库元数据是事实；“是否适合本项目”是推断。

| Skill / workflow | 能帮助什么 | 来源与安装 | 来源仓库星数 / 最后 commit | 许可 / 安装量 | 无 GUI / headless |
|---|---|---|---|---:|---|
| `scenario-labs/skills@scenario-blender-expert` | **首选。** Blender 专家路由：建模、硬表面、UV/烘焙、纹理、导出、质量审计；显式同时支持 live MCP 和 headless。其仓库还包含 `scenario-blender-hard-surface`、`scenario-blender-uv-baking`、`scenario-blender-export` 等子技能 | [skills.sh](https://skills.sh/scenario-labs/skills/scenario-blender-expert) / `npx skills add scenario-labs/skills@scenario-blender-expert -g -y` | `scenario-labs/skills` **1446** / **2026-10-30**（活跃） | MIT / **880 installs** | **是。** SKILL 明确给出 `blender -b ... --factory-startup --python-exit-code 1 -P x.py`；也支持 live GUI MCP |
| `freshtechbro/claudedesignskills@blender-web-pipeline` | Blender → glTF/GLB → three.js/Babylon 的批处理、LOD、纹理烘焙和 web 优化；包含 `batch_export.py`、`optimize_model.py`、`generate_lods.py` | [skills.sh](https://skills.sh/freshtechbro/claudedesignskills/blender-web-pipeline) / `npx skills add freshtechbro/claudedesignskills@blender-web-pipeline -g -y` | `freshtechbro/claudedesignskills` **1210** / **2025-11-20**（维护） | MIT / **3.6K installs** | **是。** 脚本本身使用 `blender --background --python`；但内容较旧，需按 Blender 5.x API 复核 |
| `RobLe3/cc-blender-skill@blender-modeling` 及其 `blender-pro-workflow` / `blender-uv-texturing` / `blender-export` | 面向 Blender MCP 的建模、材质、UV、导出技能；硬表面修改器栈和导出设置覆盖面较全 | [skills.sh](https://skills.sh/RobLe3/cc-blender-skill/blender-modeling) / `npx skills add RobLe3/cc-blender-skill@blender-modeling -g -y` | `RobLe3/cc-blender-skill` **136** / **2026-10-12**（活跃） | MIT / 子技能约 **1.3K–2.6K installs** | **有限。** SKILL 的 `allowed-tools` 面向 `mcp__blender__*`，需要 live Blender/MCP；不是首选 CI 路径 |
| `earthtojake/text-to-cad@cad` | 不是 Blender，但它是当前最好的免费代码 CAD 路线：Python `build123d` 生成零件/装配，导出 STEP、STL、3MF、GLB，并带本地 CAD Viewer | [skills.sh](https://skills.sh/earthtojake/text-to-cad/cad) / `npx skills add earthtojake/text-to-cad@cad -g -y` | `earthtojake/text-to-cad` **24691** / **2026-10-31**（活跃） | MIT / **14.9K installs** | **是**（它的 CAD engine 是 CLI/Python；viewer 只用于人工检查） |

**我建议的实际组合：**

1. **无 GUI 生产驱动：** `scenario-blender-expert` 作为总协议，配合它的 hard-surface、UV/baking、export 子技能；它明确不要求 GUI。
2. **Web 导出参考：** `blender-web-pipeline` 的脚本可作为第二参考，特别是批量导出和 LOD；但不要盲信旧 API 参数。
3. **只做代码 CAD：** `text-to-cad@cad` 替代 Blender；适合掌机外壳这种尺寸明确、需要可复现参数化的资产。
4. **如果愿意让 Blender GUI 常开：** `cc-blender-skill` 家族值得用；它更偏向 live MCP，而不是 headless CI。

**推断：** 当前最合适的不是“再找一个全能大 skill”，而是把 `scenario-blender-expert` 当路由器，限定只加载硬表面、UV/bake、export 三块，并让项目自己的 `build_console.py` 成为唯一的可复现入口。

---

## 7. 结论：现在只保留免费路径

### 不装 Blender 的最短路径

1. 用 `build123d` 或 CadQuery 写参数化硬表面模型，导出 GLB；如果只有三角网格，用 `trimesh.export_glb()`。
2. 用 `gltf-transform optimize --compress meshopt --texture-compress webp` 或 `gltfpack -c -tw` 优化。
3. 用 `gltf_validator` 校验。
4. three.js vendored：`GLTFLoader + BufferGeometryUtils + SkeletonUtils + meshopt_decoder.module.js`；如果用 KTX2，再加 KTX2 依赖；用 `RoomEnvironment + PMREMGenerator` 提供环境光。

**边界：** 这条路完全免费、无密钥，但不负责游戏级 UV、AO 和材质 look-dev；适合几何优先、参数化明确的硬表面。

### 装 Blender 的最短路径

1. 安装 Blender，安装 `scenario-blender-expert` skill（可选加 `blender-web-pipeline`）。
2. 代码入口仍是 `blender --background --python build_console.py`。
3. 在脚本内：搭基础体 → 加 Bevel → 设硬边/平滑 → Smart UV 或 seam unwrap → 烘 AO → PBR 材质 → `export_scene.gltf()` 导出 GLB。
4. 再用 skill 的 export/审计子流程跑 glTF-Transform/gltfpack 和 Khronos Validator。
5. three.js 只装 `GLTFLoader` + Meshopt/KTX2/Draco 中实际用到的一项。

**推断：** 如果项目要认真做“像素风掌机”的轮廓、按键井、屏幕凹槽和统一质感，Blender + `scenario-blender-expert` 是当前最短且免费的可控路径。MCP 只作为交互式辅助；可复现的生产入口应始终是 `bpy` 脚本。

## 8. 参考链接清单

### 开源图像/文本 → 3D

- [TripoSR](https://github.com/VAST-AI-Research/TripoSR)
- [InstantMesh](https://github.com/TencentARC/InstantMesh)
- [Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2)
- [Hunyuan3D-2 X/Tencent 许可样例（README 中链接的 2.1 仓库）](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)
- [TRELLIS](https://github.com/microsoft/TRELLIS)
- [TRELLIS multi-image example](https://github.com/microsoft/TRELLIS/blob/main/example_multi_image.py)
- [Stable Fast 3D](https://github.com/Stability-AI/stable-fast-3d)

### 程序化建模

- [Blender Command Line Arguments](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
- [Blender Python API](https://docs.blender.org/api/current/)
- [Blender Bevel Modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html)
- [Blender UV Smart Project API](https://docs.blender.org/api/current/bpy.ops.uv.html#bpy.ops.uv.smart_project)
- [Blender Cycles Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)
- [Blender glTF 2.0 Export](https://docs.blender.org/manual/en/latest/addons/scene_gltf2.html)
- [Blender `bpy.ops.export_scene.gltf`](https://docs.blender.org/api/current/bpy.ops.export_scene.html#bpy.ops.export_scene.gltf)
- [trimesh documentation](https://trimesh.org/)
- [trimesh `export_glb`](https://trimesh.org/trimesh.exchange.gltf.html#trimesh.exchange.gltf.export_glb)
- [vedo documentation](https://vedo.embl.es/)
- [vedo `write()` source](https://github.com/marcomusy/vedo/blob/master/vedo/file_io/writers.py)
- [build123d Import/Export](https://build123d.readthedocs.io/en/latest/import_export.html)
- [CadQuery Import/Export](https://cadquery.readthedocs.io/en/latest/importexport.html)

### GLB 优化与质检

- [glTF-Transform](https://github.com/donmccurdy/glTF-Transform)
- [glTF-Transform CLI](https://gltf-transform.dev/cli)
- [meshoptimizer](https://github.com/zeux/meshoptimizer)
- [gltfpack](https://github.com/zeux/meshoptimizer/tree/master/gltf)
- [Khronos glTF-Validator](https://github.com/KhronosGroup/glTF-Validator)
- [npm gltf-validator](https://www.npmjs.com/package/gltf-validator)
- [Khronos glTF-Sample-Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)

### 浏览器渲染

- [three.js GLTFLoader 文档](https://threejs.org/docs/pages/GLTFLoader.html)
- [three.js KTX2Loader 文档](https://threejs.org/docs/pages/KTX2Loader.html)
- [three.js DRACOLoader 文档](https://threejs.org/docs/pages/DRACOLoader.html)
- [three.js `GLTFLoader.setMeshoptDecoder`](https://threejs.org/docs/pages/GLTFLoader.html#setMeshoptDecoder)
- [three.js RoomEnvironment](https://threejs.org/docs/pages/RoomEnvironment.html)
- [three.js PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)
- [three.js r187 GLTFLoader 源文件](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/loaders/GLTFLoader.js)
- [three.js r187 KTX2Loader 源文件](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/loaders/KTX2Loader.js)
- [three.js r187 DRACOLoader 源文件](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/loaders/DRACOLoader.js)
- [three.js r187 meshopt decoder 源文件](https://github.com/mrdoob/three.js/blob/r187/examples/jsm/libs/meshopt_decoder.module.js)
- [Google `<model-viewer>` 文档](https://modelviewer.dev/docs/)
- [Google model-viewer 仓库](https://github.com/google/model-viewer)

### Blender 与 skill / workflow

- [Scenario Blender Expert skill](https://skills.sh/scenario-labs/skills/scenario-blender-expert)
- [Scenario Labs skills repository](https://github.com/scenario-labs/skills)
- [Blender Web Pipeline skill](https://skills.sh/freshtechbro/claudedesignskills/blender-web-pipeline)
- [freshtechbro/claudedesignskills](https://github.com/freshtechbro/claudedesignskills)
- [RobLe3 cc-blender-skill](https://github.com/RobLe3/cc-blender-skill)
- [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad)

### Blender MCP

- [MCP for Blender（原 ahujasid/blender-mcp）](https://github.com/ahujasid/mcp-for-blender)
- [PyPI `mcp-for-blender`](https://pypi.org/project/mcp-for-blender/)
