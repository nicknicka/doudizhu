# 网页里的高质感 3D 产品/道具：生产管线、视觉原理与代码建模提升清单

> 调研日期：2026-11-02。  
> 范围：浏览器实时渲染的 3D 产品/道具展示。  
> 规则：标为「事实」的内容来自一手规范、官方文档、官方仓库或厂商官方文档；标为「推断」的内容是基于这些事实的工程判断，不伪装成官方结论。厂商对 AI 生成质量、速度、分辨率的描述会明确写成「厂商自述/厂商宣称」。

---

## 1. 结论速览（TL;DR）

- **事实：** 高质量网页 3D 不是靠某个材质或某个后处理单点堆出来的，而是完整管线：建模/倒角/UV → PBR 材质与贴图 → glTF/GLB 导出 → 压缩与优化 → 浏览器加载 → HDRI/IBL 与阴影 → 色彩管理/色调映射 → 抗锯齿/后处理。glTF 本身就是为运行时传输与加载设计的格式，支持 PBR、纹理、动画等；three.js 官方也把 glTF 列为推荐加载格式。来源：[glTF 2.0 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)、[three.js Loading 3D Models](https://threejs.org/manual/#en/loading-3d-models)。
- **事实：** `MeshPhongMaterial` 是逐像素光照并支持高光，但它不是 glTF 标准的 metallic-roughness PBR；three.js 官方说明 `MeshStandardMaterial` 使用 Metalness-Roughness 工作流，并且「最好始终指定环境贴图」。来源：[three.js Materials 手册](https://threejs.org/manual/#en/materials)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。
- **推断：** 当前「像基本体拼出来」的主要原因通常不是几何数量少，而是缺少表面的四级信息：轮廓级（倒角/切线）、局部级（AO/接触阴影）、材质级（roughness/metalness/normal）、环境级（IBL/色调映射/抗锯齿）。几何本身可以简单，但光照响应不能简单。支撑事实见本文件第 3 节各来源。
- **事实：** 像素风不等于「关掉所有光照」。three.js 官方像素化示例仍然使用 `AmbientLight + DirectionalLight + SpotLight + shadowMap`，然后用 `RenderPixelatedPass` 做低分辨率像素化，并把发光强度主动量化到 6 个离散级别。来源：[three.js Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)。
- **推断：** 对「像素风复古掌机」，最稳的路线不是追求照片级，而是做一套**受控的分层风格化管线**：硬边/倒角几何 + flat/toon 二选一 + 低分辨率 nearest 像素化 + 少量 AO/接触阴影 + 轮廓 + 有限色阶 + 最后做色调映射。不要把「PBR、描边、低分辨率、SSAO、Bloom」无脑全部叠加，先明确哪一层负责轮廓、哪一层负责材质、哪一层负责屏幕质感。
- **推断：** 如果坚持纯代码建模，单台掌机这类**硬表面、固定造型、无复杂形变**的资产完全可行；最短升级路径是：补倒角分段/法线 → 换 PBR 材质 → 加 PMREM 环境光 → 加 AO/接触阴影 → 修色彩管理和色调映射 → 给屏幕做低分辨率 `NearestFilter` → 最后才加像素化/量化/描边。若后续需要复杂曲面、精确拓扑、稳定 UV、AO 烘焙、LOD 和多次美术迭代，Blender 会比继续堆基本体更便宜。支撑事实见本文件第 6、7 节。

---

## 2. 市面上这类展示的标准生产管线

### 2.1 管线总览

| 阶段 | 行业通常做法 | 常用工具/格式 | 为什么 | 一手来源 |
|---|---|---|---|---|
| 1. 参考/造型 | 先做剪影、比例、厚薄、按键间距；硬表面先 blockout，再做倒角/切线 | Blender；在线工具 Spline/Womp/Vectary 可作为轻量替代 | 高级感首先来自 silhouette 和 edge flow，而不是材质球 | [Blender About](https://docs.blender.org/manual/en/latest/getting_started/about/index.html)、[Spline Modeling Tools](https://docs.spline.design/designing-in-3-d/modeling/3d-modeling-tools)、[Womp](https://womp.com/) |
| 2. 倒角/切线/法线 | 给所有会被高光扫到的硬边做 bevel/chamfer；硬边显式硬，圆角显式平滑 | Blender Bevel、Shade Smooth/Flat | Bevel 是最便宜的“高级感”来源：它让高光在边缘形成一条窄带，而不是一条刀割线 | [Blender Bevel Modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html)、[Blender Shade Smooth & Flat](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/shading.html) |
| 3. UV/拓扑准备 | 对要贴图、烘焙 AO/normal 的模型做 UV；游戏/网页运行时通常最终转三角面，但可用 quad 做中间拓扑 | Blender Unwrap；glTF/GLB 要求运行时三角形 | 没有 UV，程序化图案只能靠局部坐标硬算；AO、normal、roughness 等贴图都失去稳定落点 | [Blender UV Introduction](https://docs.blender.org/manual/en/latest/modeling/meshes/uv/unwrapping/introduction.html)、[Blender glTF 2.0 Export](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html) |
| 4. 材质设计 | 用 Principled BSDF/PBR：base color、metallic、roughness、normal、AO，必要时 clearcoat | Blender + glTF PBR；three.js `MeshStandardMaterial` / `MeshPhysicalMaterial` | 让同一组几何在不同光照下保持可信，而不是“贴图一换就假” | [Blender glTF 2.0 Export](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)、[glTF Material](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials)、[three.js MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html) |
| 5. 烘焙 | 把高模细节、AO、光照或程序纹理烘到贴图，或烘到顶点色/Color Attribute | Blender Cycles Bake | AO/光照烘焙把计算从运行时挪到离线，适合静态道具；AO 还能压住缝隙和层间阴影 | [Blender Render Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)、[three.js aoMap](https://threejs.org/docs/pages/MeshStandardMaterial.html) |
| 6. 导出 | 首选 glTF/GLB；GLB 把 JSON 和二进制数据装进一个容器，不走 base64 | Blender glTF exporter、gltf-pipeline、gltfpack | glTF 是为运行时传输设计的；GLB 适合单文件部署，GLTF 分离资源适合渐进加载/共享资源 | [glTF Basics](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#gltf-basics)、[glTF Implementation Note](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#gltf-basics)、[three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) |
| 7. 压缩/优化 | 几何用 Draco 或 meshoptimizer；纹理用 KTX2/Basis；按需 LOD/实例化 | Draco、meshoptimizer/gltfpack、KTX-Software、Basis Universal | 先解决下载体积，再解决解码成本、GPU 内存和 draw call | [KHR_draco_mesh_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md)、[EXT_meshopt_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md)、[KHR_texture_basisu](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md) |
| 8. 加载 | 用 `GLTFLoader` 或 `<model-viewer>`；R3F 只是 React 封装层，不替代模型管线 | three.js、model-viewer、react-three-fiber | 加载器要处理材质、动画、皮肤、扩展和 decoder；自己解析 glTF 不划算 | [three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)、[model-viewer docs](https://modelviewer.dev/docs/)、[R3F Introduction](https://r3f.docs.pmnd.rs/getting-started/introduction) |
| 9. 灯光/环境 | 至少一个主光/轮廓光 + 一个可解释的环境；PBR 强烈建议 HDRI/IBL | three.js `PMREMGenerator`、`RoomEnvironment`；model-viewer `environment-image` | 环境光让 roughness/metalness 真的“有东西可反射”，也给边缘提供渐变 | [three.js PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)、[three.js RoomEnvironment](https://threejs.org/docs/pages/RoomEnvironment.html)、[model-viewer lighting/environment](https://modelviewer.dev/examples/lightingandenv/) |
| 10. 阴影/接触关系 | 至少一个 cast shadow 的光；或使用接触阴影/假阴影平面 | three.js `shadowMap`、model-viewer `shadow-intensity`、Drei `ContactShadows` | 物体没有接触阴影会“飘”；接触阴影负责让几何与地面发生关系 | [three.js Shadows](https://threejs.org/manual/#en/shadows)、[model-viewer docs](https://modelviewer.dev/docs/)、[Drei ContactShadows](https://drei.docs.pmnd.rs/staging/contact-shadows) |
| 11. 后处理/显示 | 色调映射、色彩空间、AA、描边、像素化、LUT/色阶量化；最后用 `OutputPass` 收口 | three.js `EffectComposer`、`OutputPass`、`OutlinePass`、`RenderPixelatedPass`、`SMAAPass` | 后处理是风格层，不是补几何缺陷的万能药；顺序和色彩空间非常重要 | [three.js Post Processing](https://threejs.org/manual/#en/post-processing)、[EffectComposer](https://threejs.org/docs/pages/EffectComposer.html)、[OutputPass](https://threejs.org/docs/pages/OutputPass.html) |

### 2.2 建模与导出阶段的事实

**事实：** Blender 官方把自己定义为免费、开源的完整 3D 创作套件，覆盖建模、绑定、动画、渲染、合成等；其 glTF 2.0 exporter 支持网格、Principled BSDF 材质、纹理、相机、灯光、动画和部分扩展。来源：[Blender About](https://docs.blender.org/manual/en/latest/getting_started/about/index.html)、[Blender glTF 2.0](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)。

**事实：** 导出 glTF 时，Blender 会把四边面/n-gon 三角化；不连续 UV 和 flat-shaded 边会导致顶点被拆开，glTF 顶点数可能比 Blender 视图中的逻辑顶点更多。来源：[Blender glTF 2.0](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)。

**事实：** glTF 的核心材质模型是 metallic-roughness PBR，核心通道包括 Base Color、Metallic、Roughness、Baked Ambient Occlusion、Normal 和 Emissive；glTF 还定义了 GLB 容器，把 JSON 与二进制资源装在一起，避免 base64 导致的额外体积。来源：[glTF Material](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials)、[glTF Implementation Note](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#gltf-basics)、[Blender glTF 2.0](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)。

**事实：** Blender 官方推荐的烘焙用途包括：把 base color/normal 烘到贴图导出到游戏引擎、把 AO/程序纹理烘成后续编辑基础、烘 lightmap 提供全局光照或加速渲染；烘焙要求 mesh 有 UV map。来源：[Blender Render Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)。

**事实：** glTF 的 occlusion texture 使用 R 通道；高值表示完整间接光，低值表示没有间接光。Blender glTF exporter 文档也说明它可以把 AO 接到 glTF Material Output 的 Occlusion 入口。来源：[glTF Occlusion Texture](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials)、[Blender glTF 2.0 Baked Ambient Occlusion](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)。

### 2.3 材质、灯光、显示阶段的事实

**事实：** `MeshPhongMaterial` 是逐像素光照并支持 specular highlight；`MeshLambertMaterial` 逐顶点光照。来源：[three.js Materials 手册](https://threejs.org/manual/#en/materials)。

**事实：** `MeshStandardMaterial` 使用 physically based metallic-roughness，官方文档说它通常比 Lambert/Phong 更准确，但计算成本更高；并且「为了最佳效果，使用该材质时应始终指定环境贴图」。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。

**事实：** `PMREMGenerator` 生成预过滤、带 mipmap 的 radiance environment map，mip 级别按 increasing roughness 存放 GGX filtered radiance，从 level 0 的 mirror 到 roughness 1。来源：[PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)。

**事实：** three.js 的颜色管理工作在 Linear-sRGB working color space；颜色纹理（如 `map`/`emissiveMap`）通常要标 `SRGBColorSpace`，非颜色数据（`normalMap`/`roughnessMap`/`aoMap`）通常标 `NoColorSpace`；使用 post-processing 时，从 linear 到显示色彩空间需要 `OutputPass`。来源：[three.js Color Management](https://threejs.org/manual/#en/color-management)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[OutputPass](https://threejs.org/docs/pages/OutputPass.html)。

**事实：** `WebGLRenderer.toneMapping` 默认是 `NoToneMapping`，也就是说如果不显式设置，强光/高亮可能在显示前没有被压亮；可选值包括 ACESFilmic、AgX、Neutral、Reinhard、Cineon 等。来源：[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)。

**事实：** model-viewer 官方文档暴露 `tone-mapping`、`exposure`、`shadow-intensity`、`shadow-softness`、`environment-image` 等属性；它当前默认 `neutral` tone mapping，之前默认 ACES，并说明 ACES 常用于影视但存在颜色准确性问题。来源：[model-viewer docs](https://modelviewer.dev/docs/)、[model-viewer lighting/environment examples](https://modelviewer.dev/examples/lightingandenv/)。

---

## 3. 为什么手写基本体拼出来的几何看起来「平、假、糙」

先给结论：**「用基本体」不是问题，「基本体只有几何、没有表面响应」才是问题。** 下面逐项拆开。每一项先给有出处的技术事实，再给对网页展示的工程推断。

### 3.1 倒角/斜切：没有一条能被高光读到的边缘

**事实：** three.js `ExtrudeGeometry` 提供 `bevelEnabled`、`bevelThickness`、`bevelSize`、`bevelOffset`、`bevelSegments`；其中 `bevelSegments` 是 bevel 的层数。来源：[three.js ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)。

**事实：** Blender 的 Bevel modifier 用于给 mesh 的边缘做 bevel，可控制 bevel 的位置与方式；官方将其描述为 Edit Mode 中 Bevel 操作的非破坏性替代。来源：[Blender Bevel Modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html)。

**推断：** 用户看到「平、假」，很大一部分来自 90° 刀割边。真实硬表面几乎没有数学上的无限锐边，手机壳、掌机壳、键帽、屏幕边框都有微小倒圆或 chamfer。倒角的作用不是“增加面数”，而是把环境光和主光在边缘处弯成一条高光带。没有这条带，边缘就只剩一个大色块结束、另一个大色块开始。  
**可执行检查：** 如果 `bevelSegments` 只有 1，或者边缘太小到在屏幕像素里不足 1 个像素，它几乎不会被看出来；先加大 bevel 到能被光照读到，再决定你要不要刻意追求像素化的硬边。来源：[ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)、[Blender Bevel Modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html)。

### 3.2 法线：硬边和平滑边混错了，表面就会“死”

**事实：** three.js `BufferGeometry.computeVertexNormals()` 对 indexed geometry 会把每个顶点法线设为共享该顶点的面法线平均值；对 non-indexed geometry，顶点不共享，法线等于 face normal。来源：[BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)。

**事实：** `Material.flatShading` 控制材质是否使用 flat shading，默认 `false`。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。

**事实：** Blender 的 Shade Smooth 会让相邻面的 face corner normals 取平均，使边界模糊；Shade Flat 会让每个 corner normal 等于 face normal，使边界尖锐。来源：[Blender Shade Smooth & Flat](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/shading.html)。

**推断：** “法线问题”经常表现为两种相反的错误：圆角/圆柱使用了硬边法线，于是看起来有棱；平面/大面使用了平滑法线，于是塑料和金属之间的转折没有明确边界。正确的硬表面模型不是一律 smooth 或 flat，而是显式建立 **sharp edges 和 smooth fillets** 的边界。纯代码构建时，没合并的 `BoxGeometry`/`CylinderGeometry` 每块往往各自独立，表面之间的法线不会连续，边缘转折也没有几何倒角承接。  
**可执行检查：** 把 `flatShading: true` 只在你要“低多边形块面感”时打开；如果开了 `flatShading` 又只给 bevel 1 段，圆角会被拆成一条条硬面，材质仍然容易显得粗糙。来源：[BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[Blender Shading](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/shading.html)。

### 3.3 UV 展开：没有 UV，贴图只能“投影上去”，不能“贴在表面上”

**事实：** Blender 文档说明，UV map 把 3D 表面投影到 2D 图像；每个 mesh face 可以有多个 UV texture，UV 坐标决定图像如何映射到面；默认新建 mesh 并不自动拥有 UV，必须先做 unwrap。来源：[Blender UV Introduction](https://docs.blender.org/manual/en/latest/modeling/meshes/uv/unwrapping/introduction.html)。

**事实：** three.js `Texture.mapping` 默认为 `UVMapping`，即用 texture 或 uv coordinates 把贴图应用到物体；`wrapS`/`wrapT` 决定 U/V 方向的重复方式。来源：[three.js Texture](https://threejs.org/docs/pages/Texture.html)。

**推断：** 如果只用 canvas 贴图加默认 UV，很容易出现同一个图案在正面、侧面、按键处被拉伸、方向不一致、texel density 不统一的问题。更隐蔽的是：没有稳定 UV，后面的 AO map、roughness map、normal map 都很难正确贴上去，因为每张 map 都需要一套共享的 UV 语义。Blender glTF exporter 官方也把 UV mapping 单独作为材质导出项，说明这不是可有可无的附加项。来源：[Blender glTF UV Mapping](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)、[three.js Texture](https://threejs.org/docs/pages/Texture.html)。

### 3.4 AO 烘焙/环境光遮蔽：凹陷和接触区没有变暗

**事实：** Blender Cycles 可以把 AO 或程序纹理烘到 image texture；烘焙需要 mesh 有 UV map，以及一个 Color Attribute 或 Image Texture 作为目标；官方明确说 Bake AO 可以作为后续纹理绘制/编辑的基础，也可以为游戏提供加速的全局光照。来源：[Blender Render Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)。

**事实：** glTF 的 occlusion texture 从 R 通道线性采样，高值表示完整间接光，低值表示没有间接光；three.js `aoMap` 使用红通道，并且需要第二套 UV。来源：[glTF Occlusion Texture](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。

**推断：** 没有 AO，缝、按键四周、凹槽、屏幕边框内侧、机身和地面的接触区不会自然变暗；所有地方都像同一张均匀打光的塑料板。对复古掌机这种有很多小层级、按钮、格栅和边缘的资产，AO 的视觉收益通常比“再加一个高模”更大。  
**可执行检查：** 如果模型是静态的，优先烘 AO 到贴图或顶点色；如果是纯代码且不想烘图，运行时至少加 `SSAOPass`/`GTAOPass`，并保留一个接触阴影平面。来源：[Blender Render Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)、[three.js SSAOPass](https://threejs.org/docs/pages/SSAOPass.html)、[three.js GTAOPass](https://threejs.org/docs/pages/GTAOPass.html)。

### 3.5 PBR 贴图：base color / roughness / metalness / normal 缺失或不成组

**事实：** `MeshStandardMaterial` 的 metallic-roughness 工作流中，`map` 是颜色贴图、`metalness` 控制多金属、`roughness` 控制粗糙度，`normalMap` 只改变光照方式，不改变实际几何；`roughnessMap`、`metalnessMap`、`normalMap`、`aoMap` 通常是非颜色数据。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。

**事实：** glTF 的 PBR Metallic-Roughness 核心材质包含 baseColor、metallic、roughness、metallicRoughnessTexture，以及 normal/occlusion/emissive 等纹理入口。来源：[glTF Material PBR Metallic Roughness](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#material-pbr-metallic-roughness)。

**推断：** 只给 base color，材质看起来像“带图案的塑料”。给 roughness 变化，材质会出现从哑光到微亮的过渡；给 metalness，金属件会与塑料件分家；给 normal 或 subtle bump，表面会出现微划痕、颗粒和磨砂感；给 AO，缝隙会变深。  
**可执行检查：** 掌机可以只用 4 张贴图/通道就显著提升：base color（有限的像素图案）、roughness（大面 vs 磨砂区域）、metallic（按键圈、螺丝等金属区）、AO（缝隙和层间）。正规管线则按 glTF/Blender 的通道打包方式组织。来源：[Blender glTF 2.0](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)、[glTF PBR](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#material-pbr-metallic-roughness)。

### 3.6 环境光照（HDRI/IBL）：没有环境，就没东西可以“反射”

**事实：** three.js 官方对 `MeshStandardMaterial` 的说明是：最佳效果下应始终指定 environment map；`envMap` 会经 `PMREMGenerator` 预过滤，roughness 会改变环境反射的清晰度。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)。

**事实：** `RoomEnvironment` 是一个可用于 `PMREMGenerator.fromScene()` 的基础房间场景；three.js 官方说明它可供 PBR 材质做 image-based lighting。来源：[RoomEnvironment](https://threejs.org/docs/pages/RoomEnvironment.html)。

**推断：** 没有环境光照时，金属、亮面塑料、屏幕玻璃只能对直接光作出响应，看起来像“被几个灯泡照着的纯色块”。有了 prefiltered environment 后，同一块 material 会在大面上出现柔和的反射渐变、在圆角上有高光扫过、在金属件上出现环境颜色变化，这就是“贵”感的主要来源之一。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)。

### 3.7 色调映射（tone mapping）：高光截断、暗部发闷

**事实：** `WebGLRenderer.toneMapping` 默认是 `NoToneMapping`；可选值包括 ACESFilmic、AgX、Neutral、Reinhard、Cineon、Linear 等。来源：[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)。

**事实：** model-viewer 把 tone mapping 和 exposure 作为独立属性暴露；它当前默认 `neutral`，并解释 ACES 常用于影视但存在颜色准确性问题。来源：[model-viewer docs](https://modelviewer.dev/docs/)、[model-viewer environment source](https://github.com/google/model-viewer/blob/master/packages/model-viewer/src/features/environment.ts)。

**推断：** 没有 tone mapping，亮部容易被硬裁成同一片白色，暗部可能缺少层次；倒角的窄高光、屏幕发光和边缘光都容易变成“白斑”。对于产品展示，Neutral/AgX/ACES 都可以试，但最终要和色彩管理、exposure 及品牌颜色一起看。  
**可执行检查：** 先用 `NeutralToneMapping` 或 `ACESFilmicToneMapping` 做 A/B，再调 `toneMappingExposure`；如果走 post-processing，记得把 `OutputPass` 放在链尾。来源：[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)、[three.js Post Processing](https://threejs.org/manual/#en/post-processing)、[OutputPass](https://threejs.org/docs/pages/OutputPass.html)。

### 3.8 抗锯齿：边缘锯齿会让“像素风”和“低质感”混在一起

**事实：** `WebGLRenderer` 构造参数 `antialias` 控制是否使用默认 MSAA，默认 `false`。来源：[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)。

**事实：** 使用 `EffectComposer` 时，three.js 提供 `SMAAPass`；官方说明它工作在 linear-srgb，因此必须在 `OutputPass` 之前执行。来源：[SMAAPass](https://threejs.org/docs/pages/SMAAPass.html)。

**推断：** 锯齿本身不一定是坏事，像素风甚至可以刻意保留硬边；但“意外的锯齿”和“有意设计的低分辨率像素”视觉上完全不同。如果目标不是像素化，MSAA/SMAA 可以显著减少边缘爬行；如果目标是像素化，应当先确定低分辨率 render target 和放大方式，再决定是否禁用 AA，避免 AA 把像素边缘糊掉。来源：[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)、[SMAAPass](https://threejs.org/docs/pages/SMAAPass.html)、[RenderPixelatedPass](https://threejs.org/docs/pages/RenderPixelatedPass.html)。

### 3.9 阴影/接触阴影：物体和地面没有发生关系

**事实：** three.js 官方说明默认使用 shadow maps；每个投射阴影的灯会把投射阴影的物体从灯光视角再渲染一遍。一个没有阴影的物体看起来更容易“飘”。来源：[three.js Shadows](https://threejs.org/manual/#en/shadows)。

**事实：** three.js 官方 Shadows 教程明确给出“假阴影”方案：在物体下方放一个带灰度纹理的 plane；也说明 lightmap/AO map 可以预计算静态光照。来源：[three.js Shadows](https://threejs.org/manual/#en/shadows)。

**事实：** model-viewer 暴露 `shadow-intensity`（0 表示关闭阴影）和 `shadow-softness`（0 表示硬阴影，越高越软，且不应每帧改变 softness，因为有性能成本；更软的阴影更快）。来源：[model-viewer docs](https://modelviewer.dev/docs/)、[model-viewer lighting/environment examples](https://modelviewer.dev/examples/lightingandenv/)。

**推断：** 对掌机这种放在桌面/地面上的物体，最重要的不是大面积软阴影，而是一个正确的接触暗部。硬边像素风可以使用低分辨率、硬边 shadow 或手绘 drop shadow plane，而不是追求高频软阴影。来源：[three.js Shadows](https://threejs.org/manual/#en/shadows)、[model-viewer docs](https://modelviewer.dev/docs/)。

### 3.10 关闭镜面/高光：视觉上等于删掉曲面提示

**事实：** `MeshPhongMaterial` 支持 specular highlights，`shininess` 决定高光锐度；把这些参数清零/关掉后，材质仍然会受到漫反射和 ambient/directional light 影响，但不再有一个随视角滑动的窄高光。来源：[three.js Materials](https://threejs.org/manual/#en/materials)、[MeshPhongMaterial](https://threejs.org/docs/pages/MeshPhongMaterial.html)。

**推断：** 如果你把 specular 和高光全关掉，又用 `flatShading: true`，那么几何的圆角、圆柱、倒角几乎失去最可读的“曲面方向提示”。像素风可以降低高光，但不能让所有材质都没有方向性反射。PBR + 轻微 roughness 变化通常比完全关闭高光更耐看。来源：[MeshPhongMaterial](https://threejs.org/docs/pages/MeshPhongMaterial.html)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。

### 3.11 贴图过滤/texel density：贴图被拉伸、糊化和闪烁

**事实：** `Texture.magFilter` 默认是 `LinearFilter`，`minFilter` 默认是 `LinearMipmapLinearFilter`；设置 `NearestFilter` 会得到更硬的像素采样，设置 `anisotropy` 可以提高斜视时的清晰度。来源：[three.js Texture](https://threejs.org/docs/pages/Texture.html)。

**事实：** `CanvasTexture` 直接从 canvas 创建 texture，适合程序化绘制；它继承了基础 texture 的过滤、wrap、mipmap、anisotropy 等设置。来源：[CanvasTexture](https://threejs.org/docs/pages/CanvasTexture.html)、[Texture](https://threejs.org/docs/pages/Texture.html)。

**推断：** “程序化 canvas 贴图看起来糙”常见原因不是 canvas 本身，而是：分辨率太低、在斜面上被拉伸、没有 mipmap/anisotropy、或者把像素图用了线性过滤导致边缘发糊。像素风屏幕应该明确用 `NearestFilter` 放大，同时让贴在斜面/侧面的材质维持可读 texel density。来源：[Texture](https://threejs.org/docs/pages/Texture.html)、[CanvasTexture](https://threejs.org/docs/pages/CanvasTexture.html)。

### 3.12 诊断优先级

**推断：** 对当前类型资产，视觉收益通常按以下顺序出现：

1. 正确倒角/斜切和法线层级；
2. 有方向性的材质（至少 roughness，必要时 metalness + normal）；
3. 环境光照与 tone mapping；
4. AO/接触阴影；
5. 纹理密度与像素化；
6. 抗锯齿与后处理；
7. 最后才是更复杂的高模/更多面数。

这个排序是工程推断，依据是 three.js 官方对 PBR、环境贴图、shadow、post-processing 和各材质能力的定义。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)、[three.js Shadows](https://threejs.org/manual/#en/shadows)、[three.js Post Processing](https://threejs.org/manual/#en/post-processing)。

---

## 4. 像素风/复古掌机的风格化做法

### 4.1 flat shading：低多边形块面感

**事实：** `flatShading` 是 material 属性，默认 `false`；设为 `true` 后材质使用 flat shading。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。

**推断：** flat shading 适合表现低多边形、铁壳、低分辨率机器、矿石/晶体等，但**不是锐边修复器**。它会让每个三角面按自己的法线着色；如果 bevel 层数很低，圆角会被“切碎”成多个硬面。复古掌机可以用它强化块面感，但应该在轮廓层面保留足够的 bevel/弧线，避免所有部件都像同一种塑料积木。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)。

### 4.2 cel/toon 分级：把连续光照映射成离散色阶

**事实：** `MeshToonMaterial` 实现 toon shading，`gradientMap` 是 required style 的 gradient map；官方明确要求使用这种 texture 时把 `minFilter` 和 `magFilter` 设为 `NearestFilter`。来源：[MeshToonMaterial](https://threejs.org/docs/pages/MeshToonMaterial.html)。

**事实：** three.js Materials 手册解释 toon material 与 Phong material 类似，但不做平滑 shading，而是用 X×1 gradient map 决定如何 shading，因此可以得到二色/多色阶卡通效果。来源：[three.js Materials](https://threejs.org/manual/#en/materials)。

**推断：** 对复古掌机，`MeshToonMaterial` 比“把 PBR 的 roughness 拉满”更可控：你可以决定亮面/暗面/边缘各占几个色阶。推荐先做一张 1D gradient map，例如 3 或 4 档；不要用平滑渐变，否则会退回普通塑料感。来源：[MeshToonMaterial](https://threejs.org/docs/pages/MeshToonMaterial.html)、[three.js Materials](https://threejs.org/manual/#en/materials)。

### 4.3 描边：inverted hull 或后处理边缘检测

**事实：** three.js 的 `OutlineEffect` 是一个面向 toon shader 的 outline effect；源码使用 `BackSide` 的 outline material，并通过 `calculateOutline()` 沿 normal 方向扩大背侧面生成外扩轮廓。它要求对象有 `geometry.attributes.normal`。来源：[OutlineEffect docs](https://threejs.org/docs/pages/OutlineEffect.html)、[OutlineEffect source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/effects/OutlineEffect.js)。

**事实：** `OutlinePass` 是一个后处理 pass，用于给选中对象画 outline；它可选 `visibleEdgeColor`、`hiddenEdgeColor`、`edgeThickness`、`edgeStrength`、`edgeGlow`，并可以按定义的分辨率 downsample。来源：[OutlinePass](https://threejs.org/docs/pages/OutlinePass.html)、[OutlinePass source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/OutlinePass.js)。

**推断：** inverted hull 更适合单个封闭硬表面，轮廓会跟着模型 scale 走；缺点是薄片、开放网格、法线不完整的几何容易穿帮。后处理 outline 更适合“选中/强调”和复杂场景，但会感知不到被遮挡的边缘，除非 shader 使用深度/法线信息。像素风的掌机更适合局部使用：机身外轮廓、屏幕框、按键高对比边缘，而不是给每个零件都描一圈黑线。来源：[OutlineEffect source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/effects/OutlineEffect.js)、[OutlinePass source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/OutlinePass.js)。

### 4.4 像素化渲染：低分辨率 render target + NearestFilter 放大

**事实：** `RenderPixelatedPass` 是一个 post-processing pass，接受 `pixelSize`；官方源码把内部 render resolution 设为 `width / pixelSize` 与 `height / pixelSize`，并给 beauty/normal render target 设置 `NearestFilter`；pass 还暴露 `normalEdgeStrength` 和 `depthEdgeStrength` 用于边缘检测。来源：[RenderPixelatedPass](https://threejs.org/docs/pages/RenderPixelatedPass.html)、[RenderPixelatedPass source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/RenderPixelatedPass.js)。

**事实：** three.js 官方像素化示例把 `RenderPixelatedPass( 6, scene, camera )` 和 `OutputPass` 放进 composer，并演示了 `pixelAlignedPanning`、`pixelAlignedObjects`、`rotationSnap`、`cameraRotationSnap`、`cameraZoomSnap` 等像素对齐选项。来源：[three.js Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)。

**推断：** 低分辨率 render target 是像素风的“物理正确”做法，比在素材上贴 fake pixel texture 更稳定。关键是同时做 camera/object snapping；否则低分辨率画面会抖、细节会跳，观看者会先感知为“糊”，而不是“有意的像素风”。来源：[three.js Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)、[RenderPixelatedPass source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/RenderPixelatedPass.js)。

### 4.5 有限调色板/色阶量化

**事实：** `ShaderPass` 可以用 raw GLSL shader 实现自定义 post-processing；`LUTPass` 可以用 lookup table 做 color grading。来源：[ShaderPass](https://threejs.org/docs/pages/ShaderPass.html)、[LUTPass](https://threejs.org/docs/pages/LUTPass.html)。

**事实：** three.js 官方像素示例在动画层把发光强度量化到少量离散亮度级别，以匹配像素化美学。来源：[three.js Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)。

**推断：** 全屏限制调色板的常见 shader 写法是按每通道量化，例如：

```glsl
vec3 q = floor(color.rgb * (levels - 1.0) + 0.5) / (levels - 1.0);
```

这段公式是本报告的工程建议，不是 three.js 官方规定的 API。实现方式可以用 `ShaderPass`、`LUTPass`，或把量化放进自定义 material；如果量化后出现 banding，可以打开 `Material.dithering` 增加 dithering 来减少色带。来源：[ShaderPass](https://threejs.org/docs/pages/ShaderPass.html)、[LUTPass](https://threejs.org/docs/pages/LUTPass.html)、[Material](https://threejs.org/docs/pages/Material.html)。

### 4.6 把 AO 烘到顶点色或贴图

**事实：** Blender Render Baking 明确支持把 AO 或程序纹理烘到 image texture；烘焙目标可以是 Color Attribute 或 Image Texture。three.js `Material.vertexColors` 设为 `true` 时可以使用 vertex color；glTF/three.js 的 AO texture 使用 R 通道，并需要对应 UV。来源：[Blender Render Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)、[Material](https://threejs.org/docs/pages/Material.html)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[glTF Occlusion Texture](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials)。

**推断：** 静态掌机的最佳做法是把 AO 烘到贴图或顶点色；如果必须在纯代码里完成，优先使用运行时 `SSAOPass`/`GTAOPass`，再把 AO 强度限制在较低的范围内，避免把像素风的清晰边缘糊掉。真正“烘到顶点色”需要在导出前有采样和 UV/顶点密度决策；纯代码实时计算顶点 AO 会比 SSAO 更复杂，不适合作为第一版升级。来源：[three.js SSAOPass](https://threejs.org/docs/pages/SSAOPass.html)、[three.js GTAOPass](https://threejs.org/docs/pages/GTAOPass.html)、[Blender Render Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)。

### 4.7 推荐的最小风格化管线

**推断：** 对「像素风复古掌机」，建议按以下顺序做 A/B，而不是一次全上：

1. 几何：所有外部硬边给可读 bevel；屏幕开孔/按键井有内倒角；
2. 法线：硬边保持硬，圆角保持平滑；如果刻意 flat shading，确认它不是用来掩盖错误；
3. 材质：机身用 `MeshStandardMaterial` + 轻微 roughness 变化；屏幕/玻璃拟用 `MeshPhysicalMaterial` clearcoat；发光屏幕用 emissive；
4. 环境：`PMREMGenerator` + `RoomEnvironment`（或自定义 HDR），低强度环境；
5. AO/阴影：一个硬 key light + 一个可控 drop shadow/contact shadow；必要时加低强度 SSAO；
6. 显示：低分辨率 render target + `NearestFilter` + 像素对齐；
7. 后处理：只保留 1–3 个：像素化、量化、局部 outline；最后 `OutputPass`；
8. 性能：低分辨率像素化本身通常反而降负载，但 SSAO/outline/多 pass 会叠成本，必须按设备测。

来源：[ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)、[three.js Shadows](https://threejs.org/manual/#en/shadows)、[RenderPixelatedPass](https://threejs.org/docs/pages/RenderPixelatedPass.html)、[OutputPass](https://threejs.org/docs/pages/OutputPass.html)。

---

## 5. 资产体积与性能：glTF/GLB、Draco、meshoptimizer、KTX2/Basis、LOD、实例化

### 5.1 先分清四类优化

**事实：** glTF/GLB 解决的是**资源容器与加载**；Draco 和 meshoptimizer 解决的是**几何/缓冲区压缩**；KTX2/Basis 解决的是**纹理传输与 GPU 显存占用**；LOD 和 InstancedMesh 解决的是**运行时绘制负载和 draw call**。来源：[glTF 2.0](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)、[KHR_draco_mesh_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md)、[EXT_meshopt_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md)、[KHR_texture_basisu](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md)、[three.js LOD](https://threejs.org/docs/pages/LOD.html)、[three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)。

### 5.2 体积与性能手段对比

| 手段 | 官方确认的事实 | 能拿到什么量级 | 什么时候必须用/优先用 | 一手来源 |
|---|---|---|---|---|
| glTF vs GLB | GLB 把 JSON 和二进制数据装进一个容器，不经过 base64；嵌入 data URI 会增加体积且不支持渐进/按需加载 | 没有统一百分比；主要省 base64 和请求组织成本，不压缩几何/纹理本身 | 单文件部署、移动端/嵌入式、需要减少请求数时优先 GLB；多资产共享 geometry/texture 时分离 GLTF 更合适 | [glTF Basics](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#gltf-basics)、[three.js Loading 3D Models](https://threejs.org/manual/#en/loading-3d-models) |
| Draco | Draco 压缩几何/点云，可压缩 positions、normals、纹理坐标、颜色和 generic attributes；glTF 通过 `KHR_draco_mesh_compression` 使用它 | 官方没有承诺统一的“压到几倍”；压缩率取决于 topology、属性、quantization bits。Draco 官方默认 position 11 bits，且说明量化越强压缩越好但偏差越大 | 原始 geometry buffer 很大、拓扑连片、能接受客户端额外 decode 时间；模型很小或 decoder 成本大于节省时不要用 | [KHR_draco_mesh_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md)、[Google Draco README](https://github.com/google/draco/blob/main/README.md)、[three.js DRACOLoader](https://threejs.org/docs/pages/DRACOLoader.html)、[model-viewer Loading](https://modelviewer.dev/examples/loading/) |
| meshoptimizer / gltfpack | meshoptimizer 针对 vertex/index/animation 等 glTF bufferView 做专用压缩；官方仓库称 vertex 数据通常 `2–4x`（对比已量化、已优化打包的数据），index 编码最好可达 `1 byte/triangle`（6x smaller than raw 16-bit index），典型 `1–1.2 bytes/triangle` | 顶点约 2–4x，索引最好约 6x，典型 1–1.2 bytes/triangle；还能量化、合并、简化、压缩动画 | 需要极快 decode、想同时优化 download 与 GPU fetch/topology、或想在 gzip 前再压一层时优先；需要为 loader 提供 MeshoptDecoder | [meshoptimizer README](https://github.com/zeux/meshoptimizer)、[gltfpack README](https://github.com/zeux/meshoptimizer/blob/master/gltf/README.md)、[EXT_meshopt_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md)、[three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) |
| KTX2 / Basis Universal | KTX2 是 GPU texture container；`KHR_texture_basisu` 允许 KTX2 image 使用 Basis Universal supercompression，官方称可让 transmission 更高效并**降低 GPU memory footprint**，运行时再 transcode 成平台支持的 block-compressed format；ETC1S 适合 color，UASTC 适合 non-color/normal 等 | 没有统一 PNG/JPEG 对比百分比；关键不是“文件一定几倍”，而是能直接提供 GPU-friendly/block-compressed 数据并减少显存。Basis 官方还给出 ETC1S/UASTC/XUASTC 等不同 bitrate/quality 模式 | 纹理多、分辨率大、移动端/低端 GPU 显存吃紧时优先；小项目、少量纹理且没有显存压力时不一定值得引入 transcode 复杂度 | [KHR_texture_basisu](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md)、[KTX-Software](https://github.com/KhronosGroup/KTX-Software)、[Basis Universal README](https://github.com/BinomialLLC/basis_universal)、[three.js KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html) |
| LOD | `THREE.LOD` 按相机距离在高/中/低细节 mesh 间切换；通常至少 far/low、mid/medium、close/high 三档 | 降低远距离三角面数和顶点处理，不直接改变下载体积 | 相机可 orbit/zoom、模型在高分辨率下需要高模、远距离仍会显示时使用；固定正交小图标不一定需要 | [three.js LOD](https://threejs.org/docs/pages/LOD.html)、[meshoptimizer simplification](https://github.com/zeux/meshoptimizer) |
| InstancedMesh | `InstancedMesh` 用于同 geometry + material、不同 world transformation 的大量对象；官方说明可减少 draw call、改善整体渲染性能 | 降低 draw call 和 CPU submission 开销，不减少 mesh 本身的下载体积 | 重复螺丝、按键、像素方块、会场/橱窗阵列时优先；不同材质/不同拓扑的对象不适合硬塞 | [three.js InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)、[Blender glTF GPU Instances](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html) |
| mipmap/anisotropy/分辨率 | `Texture.generateMipmaps` 默认 `true`；`minFilter` 默认 `LinearMipmapLinearFilter`；`anisotropy` 越高越清晰但采样成本越高 | 不改变源文件大小；改善斜视、远景清晰度并避免 shimmer | 有重复纹理、斜视表面、移动镜头时优先；像素屏幕需要显式 `NearestFilter`，这与通用贴图的 mipmap 需求要分开处理 | [three.js Texture](https://threejs.org/docs/pages/Texture.html) |

### 5.3 什么时候“必须”用

**推断：** 没有脱离预算的统一阈值。是否“必须”用某一种压缩，应看四个指标：首屏字节、解码 CPU、GPU 显存、draw call。可以用以下经验作为起点，但要在目标设备上测量：

- **geometry 原始 buffer 是主体积项**：先试 meshoptimizer/gltfpack；如果需要更强通用几何压缩且能接受 Draco decoder，再试 Draco。依据：meshoptimizer 支持 vertex/index/animation bufferView 压缩；Draco 专门压缩 geometry/point cloud。来源：[EXT_meshopt_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md)、[KHR_draco_mesh_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md)、[meshoptimizer README](https://github.com/zeux/meshoptimizer)、[Google Draco](https://github.com/google/draco)。
- **纹理是主显存项**：优先 KTX2/Basis；不要只按 PNG 文件大小判断，要按解码后的 block-compressed 显存和采样格式判断。依据：官方说明 KTX2/Basis 减少 GPU memory footprint，并在运行时 transcode 为平台支持的 block-compressed format。来源：[KHR_texture_basisu](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md)、[three.js KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html)。
- **首屏还要下载很大的 geometry**：`GLB + meshopt/gltfpack` 通常比“单文件未优化 GLB”更稳；如果首屏模型很小，额外引入 decoder 反而会让下载更慢。Draco 的 decoder 官方 model-viewer 示例提醒过 decoder 大于 100KB，应该只在节省大于 decoder 时使用。来源：[model-viewer Loading](https://modelviewer.dev/examples/loading/)、[three.js DRACOLoader](https://threejs.org/docs/pages/DRACOLoader.html)。
- **运行时是 draw call 瓶颈**：先合批/实例化，再考虑 LOD；两者不解决同一个问题。依据：`InstancedMesh` 官方定义为减少 draw call；`LOD` 官方定义为按距离切 mesh。来源：[InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)、[LOD](https://threejs.org/docs/pages/LOD.html)。

### 5.4 three.js 侧接入事实

**事实：** `GLTFLoader.setDRACOLoader()`、`.setKTX2Loader()`、`.setMeshoptDecoder()` 分别是加载 Draco、KTX2、meshopt 压缩 glTF 的必要接入点。来源：[GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)。

**事实：** `DRACOLoader` 官方建议复用一个实例，避免重复加载/创建 decoder；它会根据浏览器能力自动选择 JS 或 WASM decoder。来源：[DRACOLoader](https://threejs.org/docs/pages/DRACOLoader.html)。

**事实：** `KTX2Loader` 解析 KTX2 container 并 transcode 到支持的 GPU compressed texture format；它依赖 WASM，但这是现代浏览器的常态。来源：[KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html)。

**事实：** model-viewer 官方 loading 示例支持 glTF/GLB raw model、Draco、KTX2/Basis、meshopt，并展示对应 decoder 的按需加载/自定义 location。来源：[model-viewer Loading](https://modelviewer.dev/examples/loading/)。

---

## 6. 工具与产出渠道：Blender、Spline、Womp、Vectary、AI 生成 3D

### 6.1 传统/在线建模工具

| 工具 | 官方定位/事实 | 适合场景 | 对网页 3D 的推断 |
|---|---|---|---|
| Blender | 免费、开源、跨平台的完整 3D 创作套件；官方 glTF 2.0 importer/exporter 支持网格、PBR 材质、纹理、相机、灯光、动画和扩展。来源：[Blender About](https://docs.blender.org/manual/en/latest/getting_started/about/index.html)、[Blender glTF 2.0](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html) | 硬表面生产、复杂倒角/UV、AO/normal bake、绑定、动画、LOD、批量导出；适合需要精确控制拓扑与材质的长期资产 | 最稳的生产出口。若要做掌机的高质感版本，Blender 的主要价值不只是“建模”，而是 bevel/UV/bake/材质通道/LOD 的完整闭环。来源：[Blender Bevel](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html)、[Blender UV](https://docs.blender.org/manual/en/latest/modeling/meshes/uv/unwrapping/introduction.html)、[Blender Bake](https://docs.blender.org/manual/en/latest/render/cycles/baking.html) |
| Spline | 官方将 Spline 描述为用于设计、动画、发布 interactive 3D/2D experiences 的浏览器工具；支持 parametric objects、modeling tools、boolean、sculpting、timeline、physics、particles、collaboration，并能导出 web viewer/vanilla JS/React/Next.js/Three.js/react-three-fiber。来源：[Spline Getting Started](https://docs.spline.design/index)、[Spline Modeling](https://docs.spline.design/designing-in-3-d/modeling/3d-modeling-tools)、[Spline Exporting as Code](https://docs.spline.design/exporting-your-scene/web/exporting-as-code) | 快速做风格化交互展示、landing page、原型、简单道具；适合设计和网页团队协作 | 适合“先验证视觉方向”和轻量场景；如果最终要继续用自家 three.js 维护材质/性能，应确认导出资产能否被清理和优化，不要把在线工具生成的所有节点/运行时都带进生产包。来源：[Spline Exporting as Code](https://docs.spline.design/exporting-your-scene/web/exporting-as-code)、[Spline Optimization](https://docs.spline.design/exporting-your-scene/how-to-optimize-your-scene) |
| Womp | 官方首页将 Womp 定义为浏览器中的免费 3D modeling platform，带 AI shape generation、photoreal material library、SVG import/export、asset library 和 3D printing service。来源：[Womp](https://womp.com/) | 快速 blockout、圆润造型/角色/产品概念、3D 打印；适合非专业 3D 团队快速出形 | 对“快速做出有体积感的基础形状”有价值，但官方页面主要强调 modeling/printing 和材料库，不是成熟的网页 PBR/UV bake/LOD 管线。把它当造型工具，不要假设它自动解决网页材质和性能。来源：[Womp](https://womp.com/) |
| Vectary | 官方将 Vectary 定位为在线 3D/AR 设计、分享、嵌入平台，提供 browser-based Studio、no-code configurator builder、CAD-to-web viewer、interactions、AR、API。来源：[Vectary docs](https://docs.vectary.com/)、[Vectary Homepage](https://www.vectary.com/) | 产品配置器、CAD 转网页展示、AR、交互式产品页；适合商业展示而不是纯像素风游戏道具 | 如果未来要加颜色/配件切换、热点、配置器，Vectary 的 no-code 交互层比 three.js 手搓更省时间；但自定义像素风着色和极低端性能优化仍可能需要回到 three.js。来源：[Vectary Homepage](https://www.vectary.com/)、[Vectary CAD import](https://www.vectary.com/import-cad-file/) |

### 6.2 AI 生成 3D 现在到什么水平

以下只把厂商官方文档当成“厂商能力声明”，不把它们当作独立验证的质量结论。

| 服务 | 官方能力（事实/厂商自述） | 生产可用性的工程判断 |
|---|---|---|
| Meshy | 官方 API 文档提供 text-to-3D 的两阶段 preview→refine（先几何后贴图）、image-to-3D、remesh、rigging；text-to-3D 支持 standard/smart-topology、triangle/quad-dominant remesh、目标 face count、texture/PBR、GLB 等；rigging 明确要求 humanoid、+Z 朝向、face/triangle 限制，大于一定大小/面数可能失败。来源：[Meshy Text to 3D](https://docs.meshy.ai/en/api/text-to-3d)、[Meshy Image to 3D](https://docs.meshy.ai/en/api/image-to-3d)、[Meshy Remesh](https://docs.meshy.ai/en/api/remesh)、[Meshy Rigging](https://docs.meshy.ai/en/api/rigging) | **可用于生产中的候选生成/背景道具/快速变体**，尤其适合先拿多个造型候选再由人清理。厂商自述已经提供 topology/face-count/remesh 控制，但这些参数不等于“拓扑必然适合动画/UV/碰撞”；英雄道具仍应做 retopo、UV、法线、AO 和 LOD 验收。 |
| Tripo | 官方 API 提供 H Series / P Series text-to-3D、image-to-3D、multiview-to-3D；P Series 官方定位是 low-poly、clean topology，P2 支持 quad；可输出 PBR maps（base_color、metallic、roughness、normal）、UV、face limit，提供 texture、mesh decimate/retopology、rig、retarget，并可按 GLB/FBX 输出；官方给出 web/mobile 10k–50k face 的建议区间。来源：[Tripo Introduction](https://developers.tripo3d.ai/en/docs/introduction)、[Tripo Text to 3D P Series](https://developers.tripo3d.ai/en/docs/generation-text-to-model/p)、[Tripo Image to 3D P Series](https://developers.tripo3d.ai/en/docs/generation-image-to-model/p)、[Tripo Models Texture](https://developers.tripo3d.ai/en/docs/models-texture)、[Tripo Mesh Decimate](https://developers.tripo3d.ai/en/docs/mesh-decimate)、[Tripo Rigging](https://developers.tripo3d.ai/en/docs/animations-rig) | **比上一代更像生产工具**：有 PBR、quad、face limit、rig/retarget、web/mobile 面数建议。适合低多边形道具、风格化小物件、原型资产；但要警惕 AI 生成的“clean topology”只代表面数/面型受控，不代表布线适配你的动画、UV、碰撞和 LOD。 |
| Rodin / Hyper3D | 官方 Gen-2.5 API 提供 image-to-3D 和 text-to-3D；1–5 张图片，tier 从 Extreme-Low 到 Extreme-High，官方称 Extreme-High 额外返回最高 10M faces；texture mode 和 HighPack/UHD 可实现最高 12K texture；支持 GLB/FBX/USDZ、Raw mesh、quality/face override、Fast mode。来源：[Rodin Quick Start](https://docs.hyper3d.ai/en/get-started/quick-start)、[Rodin Gen-2.5](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5) | **适合高细节候选、道具、背景资产和 3D 打印前期**；高面数/高纹理输出对网页来说太大，必须经过 decimation、UV/纹理压缩、Draco/meshopt 和 LOD。官方文档明确有 10M faces、12K texture 这一档，意味着它更偏“生成细节”而不是“直接交网页”。 |
| Luma | 官方 Dream Machine API 索引当前列出的是 image generation、video generation、Python/JavaScript SDK、rate limits、errors、reframe/modify video；没有列 text-to-3D/image-to-3D endpoint。来源：[Luma docs index](https://docs.lumalabs.ai/llms.txt)、[Luma API](https://docs.lumalabs.ai/docs/api) | **不要把它放进当前 3D 管线假设里**。如果团队记忆里还有 Luma Genie/图片转 3D，应该先查当前产品是否有单独文档；仅凭当前官方 API 索引，Luma 不是可依赖的 3D 生成渠道。 |

### 6.3 AI 能否用于生产：结论分层

**事实：** 这些服务已经提供 API、异步任务、PBR 纹理、面数/拓扑选项、格式转换/重网格、绑定/重定向等生产能力。来源：[Meshy](https://docs.meshy.ai/en/api/text-to-3d)、[Tripo](https://developers.tripo3d.ai/en/docs/introduction)、[Rodin](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5)。

**推断：** “生产可用”不等于“一键替代美术”。合理分层是：

- **可以较放心用：** 多个风格候选、背景/远景小物、占位资产、快速做变体、概念验证、用户生成内容的预处理。
- **必须人工验收：** 主角/核心产品、需要精确轮廓和品牌识别、需要 deformation/骨骼动画、需要稳定 UV/AO/LOD、需要版权链清晰的资产。
- **一定要做的后处理：** 手动/工具化 retopo、UV 检查、三角化、法线/切线检查、贴图色空间检查、AO/normal 合规、Draco/meshopt/KTX2、LOD、碰撞体、面数和 draw call 预算。
- **不能只凭厂商宣传做决定：** 用同一套目标设备、目标尺寸、目标材质和验收截图做 A/B；AI 输出在 close-up 和金属/玻璃/透明材质上最容易暴露问题。

来源：[Blender glTF 2.0](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)、[glTF 2.0](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)、[three.js Loader](https://threejs.org/docs/pages/GLTFLoader.html)、[model-viewer Loading](https://modelviewer.dev/examples/loading/)。

---

## 7. 如果不用建模工具、只有代码：可行手法清单

### 7.1 适用边界

**事实：** three.js 官方说明 primitives 是运行时用参数生成的 3D 形状，适合实验、简单物体和快速开始；但它同时明确说，对大多数 3D app，更常见的是由 Blender/Maya/Cinema 4D 等建模工具制作模型。来源：[three.js Primitives](https://threejs.org/manual/#en/primitives)。

**推断：** 如果目标是**单台固定造型的复古掌机、硬表面、无需形变、无需复杂 UV 动画、灯光可人为控制**，纯代码路线可行。若目标是复杂有机曲面、精确拓扑、可绑定的角色、需要多次美术迭代、需要稳定 UV/AO/LOD，继续堆基本体会很快变成更高的维护成本。  
**成功标准建议：**
- 剪影在 128px 宽下仍能分辨机身、屏幕、按键；
- 1x/2x screenshot 下倒角有明确转折；
- 屏幕内容有低分辨率像素感但不糊；
- 机身上至少存在三档明暗：亮面、过渡、接触区；
- 无“纯色板贴在一起”的边界；每个分件能说明它为什么存在。

### 7.2 P0：不引入工具也能立刻拉高质感

#### A. 给所有可见边缘加倒角，并提高倒角可读性

**事实：** `ExtrudeGeometry` 有 `bevelEnabled`、`bevelThickness`、`bevelSize`、`bevelSegments`；`RoundedBoxGeometry` 是专门生成圆角边缘的 box geometry。来源：[ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)、[RoundedBoxGeometry](https://threejs.org/docs/pages/RoundedBoxGeometry.html)。

**代码示例：**

```js
const bodyGeo = new THREE.ExtrudeGeometry(shape, {
  depth,
  bevelEnabled: true,
  bevelThickness: 0.035,
  bevelSize: 0.035,
  bevelOffset: 0,
  bevelSegments: 3,   // 1 段通常太硬；2–3 段更适合读倒角
  curveSegments: 4,
  steps: 1
});
```

```js
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const chipGeo = new RoundedBoxGeometry(
  1.0, 0.2, 0.4,  // width, height, depth
  4,              // segments
  0.03            // radius
);
```

**推断：** 现有很多基本体之所以糙，是因为只用了 `bevelSegments: 1` 或零件之间靠叠起来，边缘仍然是硬碰硬。先把外轮廓和屏幕/按键井做出 2–3 段的可读倒角，通常比重新做更复杂的曲线更快见效。来源：[ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)、[Blender Bevel](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html)。

#### B. 明确硬边/平滑边，不要所有东西共用一个 flatShading

**事实：** `flatShading` 是 material 属性；`computeVertexNormals()` 在 indexed geometry 上平均共享法线，在 non-indexed geometry 上使用 face normal。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)。

**建议：**
- 机身大圆角、圆柱按键、摇杆：优先平滑法线或较细的 bevel；
- 屏幕框、机身边缘、像素块：允许 hard edge；
- 不要用全局 `flatShading: true` 把圆角也拆碎；
- 如果自己改了 position，重新调用 `geometry.computeVertexNormals()`，但要理解 indexed 与 non-indexed 的差异。

**推断：** “像素风”可以接受 flat 面，但前提是轮廓本身有清晰的设计。否则 flat shading 只是在放大几何错误，而不是在表达风格。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)、[Blender Shading](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/shading.html)。

#### C. 从 Phong 切到 Standard/Physical，并显式设置 roughness/metalness

**事实：** `MeshStandardMaterial` 是 metallic-roughness PBR；`MeshPhysicalMaterial` 在其上增加 clearcoat 等参数；官方说明 PBR 通常比 Phong/Lambert 更准确，但成本更高。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[MeshPhysicalMaterial](https://threejs.org/docs/pages/MeshPhysicalMaterial.html)、[three.js Materials](https://threejs.org/manual/#en/materials)。

```js
const shellMat = new THREE.MeshStandardMaterial({
  color: 0xd9d2c3,
  roughness: 0.58,
  metalness: 0.05,
  envMapIntensity: 0.8
});

const screenGlassMat = new THREE.MeshPhysicalMaterial({
  color: 0x101018,
  roughness: 0.18,
  metalness: 0.0,
  clearcoat: 0.8,
  clearcoatRoughness: 0.12,
  envMapIntensity: 1.0
});
```

**推断：** 复古掌机不需要所有材质都变成照片级；但机身、屏幕盖、金属圈、橡胶按键至少要分成三种表面响应。这样即使颜色很少，观者也能通过高光宽度和反射变化读懂材质。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[MeshPhysicalMaterial](https://threejs.org/docs/pages/MeshPhysicalMaterial.html)。

#### D. 加一个 PMREM 环境，不要只靠 AmbientLight + DirectLight

**事实：** `RoomEnvironment` 可作为 `PMREMGenerator.fromScene()` 的输入，产出可用于 PBR image-based lighting 的环境；three.js 官方给了直接赋值 `scene.environment = envMap` 的示例。来源：[RoomEnvironment](https://threejs.org/docs/pages/RoomEnvironment.html)、[PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)。

```js
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const envRT = pmrem.fromScene(room, 0.04);
scene.environment = envRT.texture;

// 环境贴图已生成，释放临时 scene 和 generator 的内部资源；envRT 由调用方保留。
room.dispose();
pmrem.dispose();
```

**推断：** 对像素风，不要直接把环境强度拉满；把 `envMapIntensity` 控制到 0.4–0.9，让环境负责“有一点点空间反射”，直接光负责明确的亮暗关系。这样通常比增加更多灯更便宜也更稳。来源：[PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。

#### E. 修色彩管理和 tone mapping

**事实：** three.js 的工作色彩空间是 Linear-sRGB；颜色纹理需要 `SRGBColorSpace`，非颜色数据需要 `NoColorSpace`；`WebGLRenderer.toneMapping` 默认 `NoToneMapping`；post-processing 链尾需要 `OutputPass` 做 tone mapping + color space 转换。来源：[three.js Color Management](https://threejs.org/manual/#en/color-management)、[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)、[OutputPass](https://threejs.org/docs/pages/OutputPass.html)。

```js
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping; // 或 ACESFilmic / AgX
renderer.toneMappingExposure = 1.0;

baseColorTexture.colorSpace = THREE.SRGBColorSpace;
roughnessTexture.colorSpace = THREE.NoColorSpace;
normalTexture.colorSpace = THREE.NoColorSpace;
aoTexture.colorSpace = THREE.NoColorSpace;
```

**推断：** 很多“颜色脏、边缘发白、材质像塑料”的问题，来自 base color 被当作线性数据、非颜色贴图被当作 sRGB、或 post-processing 后没有 `OutputPass`。这属于必须先修的基础问题。来源：[three.js Color Management](https://threejs.org/manual/#en/color-management)、[OutputPass](https://threejs.org/docs/pages/OutputPass.html)。

#### F. 加 AO 或接触阴影

**事实：** three.js 提供 `SSAOPass` 和 `GTAOPass`，其中 `GTAOPass` 官方称质量更好但更贵；`SSAOPass` 提供 `kernelRadius`、`minDistance`、`maxDistance` 等参数。来源：[SSAOPass](https://threejs.org/docs/pages/SSAOPass.html)、[GTAOPass](https://threejs.org/docs/pages/GTAOPass.html)。

**事实：** three.js Shadows 教程提供 fake shadow plane 方案，并说明 lightmap/AO 可以在离线预计算静态光照。来源：[three.js Shadows](https://threejs.org/manual/#en/shadows)。

**建议：**
- 如果掌机是静态的：优先烘 AO 到贴图/顶点色；
- 如果必须纯运行时：先试 `GTAOPass`，性能不合适再试 `SSAOPass`；
- 如果只想让物体落地：一个灰度 fake shadow plane + 轻微底部环境暗部，通常最便宜；
- 不要用大范围软阴影糊掉像素风轮廓。

**如果已经把 AO 烘成贴图：** three.js 的 `aoMap` 需要第二套 UV。纯代码里若已有 `uv`，可以按当前锁定的 three.js 版本把同一套 UV 复制到第二套 UV 上作为起点；不要假设任意几何都自动有它：

```js
if (geometry.attributes.uv && !geometry.attributes.uv1) {
  geometry.setAttribute('uv1', geometry.attributes.uv.clone());
}

material.aoMap = aoTexture;      // aoTexture R 通道
material.aoMapIntensity = 0.75;  // 像素风不要压得太黑
```

**如果已经把 AO 烘成顶点色：** three.js `Material.vertexColors = true` 会启用顶点颜色，geometry 需要对应 `color` attribute：

```js
geometry.setAttribute('color', new THREE.BufferAttribute(aoAsRgb, 3));
material.vertexColors = true;
```

来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[Material](https://threejs.org/docs/pages/Material.html)、[BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)、[glTF Occlusion Texture](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#materials)。

来源：[SSAOPass](https://threejs.org/docs/pages/SSAOPass.html)、[GTAOPass](https://threejs.org/docs/pages/GTAOPass.html)、[three.js Shadows](https://threejs.org/manual/#en/shadows)、[Blender Render Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)。

#### G. 给屏幕一个真正的低分辨率渲染路径

**事实：** `WebGLRenderTarget` 是一个可渲染的 texture；`Texture` 的 `magFilter`/`minFilter` 可设为 `NearestFilter`，用于硬像素采样。来源：[three.js Render Targets](https://threejs.org/manual/#en/rendertargets)、[Texture](https://threejs.org/docs/pages/Texture.html)、[RenderPixelatedPass source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/RenderPixelatedPass.js)。

**纯代码屏幕建议：**

```js
const screenRT = new THREE.WebGLRenderTarget(96, 64, {
  depthBuffer: true,
  stencilBuffer: false
});

screenRT.texture.magFilter = THREE.NearestFilter;
screenRT.texture.minFilter = THREE.NearestFilter;
screenRT.texture.generateMipmaps = false;
// WebGLRenderTarget 里是渲染结果，不是外部颜色贴图；不要想当然按 sRGB 图片处理。

const screenMat = new THREE.MeshBasicMaterial({
  map: screenRT.texture,
  toneMapped: false
});
```

**推断：** 掌机里的“屏幕”是一个小画中画，不应该和整机共享同一个分辨率策略。给它固定低分辨率 render target，比在 canvas 上画低分辨率图案再贴到几何上更容易获得稳定像素感。`toneMapped: false` 适合作为 UI/屏幕发光元素的候选设置，但是否需要取决于整机 tone mapping，必须看最终画面。来源：[Texture](https://threejs.org/docs/pages/Texture.html)、[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)、[three.js Render Targets](https://threejs.org/manual/#en/rendertargets)。

#### H. 抗锯齿：标准展示与像素化分开处理

**事实：** `WebGLRenderer` 的 `antialias` 默认 `false`；`SMAAPass` 是一个后处理抗锯齿 pass，官方要求它工作在 linear-srgb，因此要在 `OutputPass` 前。来源：[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)、[SMAAPass](https://threejs.org/docs/pages/SMAAPass.html)。

```js
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true // 普通展示：开默认 MSAA
});
```

```js
// post-processing 路线：SMAA 在 OutputPass 之前
composer.addPass(new SMAAPass());
composer.addPass(new OutputPass());
```

**推断：** 如果全屏最终目标是粗像素，不要默认开全分辨率 MSAA 再像素化；AA 可能把低分辨率边缘磨平。先在低分辨率 pass 上定义像素，再决定是否对屏幕 UI/文字局部做 AA。来源：[RenderPixelatedPass](https://threejs.org/docs/pages/RenderPixelatedPass.html)、[SMAAPass](https://threejs.org/docs/pages/SMAAPass.html)。

### 7.3 P1：程序化材质与风格化后处理

#### A. 用 CanvasTexture/DataTexture 做程序化 roughness/normal/图案

**事实：** `CanvasTexture` 可以直接从 canvas 创建 texture，并继承 base texture 的过滤、wrap、mipmap、anisotropy；three.js 官方也有 Canvas Textures 手册。来源：[CanvasTexture](https://threejs.org/docs/pages/CanvasTexture.html)、[three.js Canvas Textures](https://threejs.org/manual/#en/canvas-textures)。

**建议：**
- base color：低分辨率色块/图案，使用 `NearestFilter` 保留像素；
- roughness：低频噪声、磨砂区域、边缘磨损；
- metallic：只给真正的金属件，避免整机 metallic；
- normal/bump：微小的划痕、按键纹理、格栅；对像素风要非常克制；
- AO：优先离线/顶点，runtime 用 SSAO。

**推断：** 程序化噪声不是“随便加 grain”。它应该对应真实制程：注塑塑料有微磨砂，屏幕有反射，金属圈有各向同性高光，橡胶按键更粗糙。来源：[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[CanvasTexture](https://threejs.org/docs/pages/CanvasTexture.html)。

#### B. 用 MeshToonMaterial + gradientMap 控制色阶

**事实：** `MeshToonMaterial.gradientMap` 决定 toon shading 的色阶；官方要求把这类 texture 的 `minFilter`/`magFilter` 设为 `NearestFilter`。来源：[MeshToonMaterial](https://threejs.org/docs/pages/MeshToonMaterial.html)。

```js
function makeGradientMap(stops) {
  const data = new Uint8Array(stops.length);
  stops.forEach((v, i) => data[i] = v);
  const tex = new THREE.DataTexture(data, stops.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

const toonMat = new THREE.MeshToonMaterial({
  color: 0xd9d2c3,
  gradientMap: makeGradientMap([40, 120, 210, 255])
});
```

**推断：** 复古掌机可以机身 PBR、屏幕/按键 toon，或者全机 toon + 局部 emissive。混用材质的关键是保持光方向一致，不然不同材质会像来自不同场景。来源：[MeshToonMaterial](https://threejs.org/docs/pages/MeshToonMaterial.html)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)。

#### C. 用 OutlineEffect/OutlinePass 做局部描边

**事实：** `OutlineEffect` 是 toon outline effect，使用 BackSide 外扩，并要求 geometry 有 normal；`OutlinePass` 是后处理 outline pass，可为 selected objects 画 outline。来源：[OutlineEffect](https://threejs.org/docs/pages/OutlineEffect.html)、[OutlineEffect source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/effects/OutlineEffect.js)、[OutlinePass](https://threejs.org/docs/pages/OutlinePass.html)。

**建议：**
- 给机身外轮廓、屏幕框、键盘面板做 outline；
- 不要给每个小按钮描一圈，否则画面会变成漫画/贴纸；
- 如果几何法线不完整，优先用后处理 outline，不要指望 inverted hull；
- 描边颜色不要纯黑；用很深的机身色/墨色更高级。来源：[OutlineEffect source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/effects/OutlineEffect.js)、[OutlinePass](https://threejs.org/docs/pages/OutlinePass.html)。

#### D. 像素化 + 色阶量化 + OutputPass

**事实：** three.js 官方像素示例把 `RenderPixelatedPass` 与 `OutputPass` 组合，并用 `pixelAlignedObjects`、`rotationSnap` 等消除像素漂移。来源：[three.js Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)。

**A/B 起点：**

```js
const composer = new EffectComposer(renderer);

const pixelPass = new RenderPixelatedPass(4, scene, camera);
pixelPass.normalEdgeStrength = 0.25;
pixelPass.depthEdgeStrength = 0.35;

composer.addPass(pixelPass);
composer.addPass(new OutputPass());
```

**推断：** 如果还要自定义量化，优先把量化放在 pixel pass 之后、`OutputPass` 之前，或在材质层面先量化的 emissive，而不是在已 sRGB 编码的屏幕空间反复处理。每次改 pass 顺序都至少检查：颜色是否变脏、黑色是否有断层、发光是否溢出、暗部是否丢失。来源：[three.js Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)、[OutputPass](https://threejs.org/docs/pages/OutputPass.html)、[ShaderPass](https://threejs.org/docs/pages/ShaderPass.html)。

#### E. 像素对齐，不要只做像素化

**事实：** 官方像素化示例提供 `pixelAlignCamera`、`pixelAlignFrustum`、`pixelAlignObject`、`snapObjectRotation`，以及 GUI 中的 pixel-aligned panning/objects/rotation/camera snapping 参数。来源：[three.js Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)。

**推断：** 只做低分辨率、不做像素对齐，会出现像素抖动、物体边缘闪烁、文字抖动。对掌机这种几何边缘很多的资产，先固定相机/物体 transform 的像素网格，再叠动画；否则“像素风”会被误读为“分辨率低”。来源：[three.js Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)。

### 7.4 P2：性能闭环

**事实：** `LOD` 按相机距离切换不同 mesh；`InstancedMesh` 对同 geometry/material 的大量对象降低 draw call。来源：[LOD](https://threejs.org/docs/pages/LOD.html)、[InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)。

**推断：** 对单台掌机，最先做的不是 LOD，而是减少材质变体和 draw call：把同材质的小部件合并、把重复键帽/像素块 instances、把静态组件合并为更少的绘制单元。只有当相机允许大幅 zoom、或未来要展示多台设备/大量场景元素时，LOD 才值得引入。来源：[three.js Optimize Lots of Objects](https://threejs.org/manual/#en/optimize-lots-of-objects)、[InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)、[LOD](https://threejs.org/docs/pages/LOD.html)。

### 7.5 给当前掌机项目的最小改造顺序

**推断：** 如果只允许改 `scene.js` 里的渲染细节，按以下顺序验证：

1. 保持 `ExtrudeGeometry` 和现有分件，先把外部边缘的 `bevelSegments` 从 1 提到 2–3，并检查外轮廓剪影；
2. 把机身材质从 `MeshPhongMaterial` 切到 `MeshStandardMaterial`，给机身、屏幕盖、金属圈分别设置 roughness/metalness；需要玻璃/屏幕反光时用 `MeshPhysicalMaterial` 的 clearcoat；
3. 加 `RoomEnvironment` + `PMREMGenerator`，但把 `envMapIntensity` 压低，先观察倒角和金属圈是否开始“读得出来”；
4. 设 `renderer.outputColorSpace`、`toneMapping`，如走 composer 就确保 `OutputPass` 在链尾；
5. 加一个接触阴影/假阴影，并给机身底部规则区域压暗；不要一开始就开软阴影；
6. 给屏幕用 64×64 / 96×64 的 `WebGLRenderTarget` + `NearestFilter`，先确保屏幕内容清晰、稳定；
7. 最后再做全屏 `RenderPixelatedPass`、像素对齐和色阶量化；
8. 如果看起来仍然“糙”，优先回去检查倒角宽度、法线、环境强度和 AO，而不是继续加 Bloom/后处理。

来源：[ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)、[MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[MeshPhysicalMaterial](https://threejs.org/docs/pages/MeshPhysicalMaterial.html)、[PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)、[RoomEnvironment](https://threejs.org/docs/pages/RoomEnvironment.html)、[WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)、[OutputPass](https://threejs.org/docs/pages/OutputPass.html)、[RenderPixelatedPass](https://threejs.org/docs/pages/RenderPixelatedPass.html)。

---

## 8. 参考链接清单

### three.js 官方文档/源码

- [Installation / addons](https://threejs.org/manual/#en/installation)
- [Loading 3D Models](https://threejs.org/manual/#en/loading-3d-models)
- [Color Management](https://threejs.org/manual/#en/color-management)
- [Materials](https://threejs.org/manual/#en/materials)
- [Shadows](https://threejs.org/manual/#en/shadows)
- [Render Targets](https://threejs.org/manual/#en/rendertargets)
- [Post Processing](https://threejs.org/manual/#en/post-processing)
- [Primitives](https://threejs.org/manual/#en/primitives)
- [Canvas Textures](https://threejs.org/manual/#en/canvas-textures)
- [Optimize Lots of Objects](https://threejs.org/manual/#en/optimize-lots-of-objects)
- [WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)
- [ExtrudeGeometry](https://threejs.org/docs/pages/ExtrudeGeometry.html)
- [RoundedBoxGeometry](https://threejs.org/docs/pages/RoundedBoxGeometry.html)
- [Texture](https://threejs.org/docs/pages/Texture.html)
- [CanvasTexture](https://threejs.org/docs/pages/CanvasTexture.html)
- [Material](https://threejs.org/docs/pages/Material.html)
- [MeshPhongMaterial](https://threejs.org/docs/pages/MeshPhongMaterial.html)
- [MeshStandardMaterial](https://threejs.org/docs/pages/MeshStandardMaterial.html)
- [MeshPhysicalMaterial](https://threejs.org/docs/pages/MeshPhysicalMaterial.html)
- [MeshToonMaterial](https://threejs.org/docs/pages/MeshToonMaterial.html)
- [PMREMGenerator](https://threejs.org/docs/pages/PMREMGenerator.html)
- [RoomEnvironment](https://threejs.org/docs/pages/RoomEnvironment.html)
- [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)
- [DRACOLoader](https://threejs.org/docs/pages/DRACOLoader.html)
- [KTX2Loader](https://threejs.org/docs/pages/KTX2Loader.html)
- [LOD](https://threejs.org/docs/pages/LOD.html)
- [InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
- [EffectComposer](https://threejs.org/docs/pages/EffectComposer.html)
- [OutputPass](https://threejs.org/docs/pages/OutputPass.html)
- [SMAAPass](https://threejs.org/docs/pages/SMAAPass.html)
- [SSAOPass](https://threejs.org/docs/pages/SSAOPass.html)
- [GTAOPass](https://threejs.org/docs/pages/GTAOPass.html)
- [OutlineEffect](https://threejs.org/docs/pages/OutlineEffect.html)
- [OutlinePass](https://threejs.org/docs/pages/OutlinePass.html)
- [RenderPixelatedPass](https://threejs.org/docs/pages/RenderPixelatedPass.html)
- [ShaderPass](https://threejs.org/docs/pages/ShaderPass.html)
- [LUTPass](https://threejs.org/docs/pages/LUTPass.html)
- [Pixelation example](https://threejs.org/examples/webgl_postprocessing_pixel.html)
- [OutlineEffect source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/effects/OutlineEffect.js)
- [OutlinePass source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/OutlinePass.js)
- [RenderPixelatedPass source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/postprocessing/RenderPixelatedPass.js)

### glTF / Khronos

- [glTF 2.0 Specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- [glTF GitHub README](https://github.com/KhronosGroup/glTF/blob/main/README.md)
- [KHR_draco_mesh_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md)
- [KHR_texture_basisu](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_texture_basisu/README.md)
- [EXT_meshopt_compression](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md)
- [KTX 2.0 Specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html)
- [KTX-Software](https://github.com/KhronosGroup/KTX-Software)

### Blender 官方手册

- [About Blender](https://docs.blender.org/manual/en/latest/getting_started/about/index.html)
- [Bevel Modifier](https://docs.blender.org/manual/en/latest/modeling/modifiers/generate/bevel.html)
- [Shade Smooth & Flat](https://docs.blender.org/manual/en/latest/modeling/meshes/editing/face/shading.html)
- [UV Unwrapping Introduction](https://docs.blender.org/manual/en/latest/modeling/meshes/uv/unwrapping/introduction.html)
- [Render Baking](https://docs.blender.org/manual/en/latest/render/cycles/baking.html)
- [glTF 2.0 Export/Import](https://docs.blender.org/manual/en/4.5/addons/import_export/scene_gltf2.html)

### 压缩/优化官方仓库

- [Google Draco](https://github.com/google/draco)
- [Draco Bitstream Spec](https://google.github.io/draco/spec/)
- [meshoptimizer](https://github.com/zeux/meshoptimizer)
- [gltfpack](https://github.com/zeux/meshoptimizer/blob/master/gltf/README.md)
- [Basis Universal](https://github.com/BinomialLLC/basis_universal)

### Google model-viewer / R3F / Drei

- [model-viewer docs](https://modelviewer.dev/docs/)
- [model-viewer Lighting and Environment examples](https://modelviewer.dev/examples/lightingandenv/)
- [model-viewer Loading examples](https://modelviewer.dev/examples/loading/)
- [model-viewer environment feature source](https://github.com/google/model-viewer/blob/master/packages/model-viewer/src/features/environment.ts)
- [R3F Introduction](https://r3f.docs.pmnd.rs/getting-started/introduction)
- [R3F Hooks](https://r3f.docs.pmnd.rs/api/hooks)
- [Drei ContactShadows](https://drei.docs.pmnd.rs/staging/contact-shadows)
- [Drei Environment](https://drei.docs.pmnd.rs/staging/environment)

### 在线建模工具官方页面

- [Spline Getting Started](https://docs.spline.design/index)
- [Spline Modeling Tools](https://docs.spline.design/designing-in-3-d/modeling/3d-modeling-tools)
- [Spline Exporting as Code](https://docs.spline.design/exporting-your-scene/web/exporting-as-code)
- [Spline Optimization](https://docs.spline.design/exporting-your-scene/how-to-optimize-your-scene)
- [Womp](https://womp.com/)
- [Vectary docs](https://docs.vectary.com/)
- [Vectary Homepage](https://www.vectary.com/)
- [Vectary CAD import](https://www.vectary.com/import-cad-file/)

### AI 生成 3D 官方文档

- [Meshy Text to 3D](https://docs.meshy.ai/en/api/text-to-3d)
- [Meshy Image to 3D](https://docs.meshy.ai/en/api/image-to-3d)
- [Meshy Remesh](https://docs.meshy.ai/en/api/remesh)
- [Meshy Rigging](https://docs.meshy.ai/en/api/rigging)
- [Tripo API Introduction](https://developers.tripo3d.ai/en/docs/introduction)
- [Tripo Text to 3D H Series](https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard)
- [Tripo Text to 3D P Series](https://developers.tripo3d.ai/en/docs/generation-text-to-model/p)
- [Tripo Image to 3D P Series](https://developers.tripo3d.ai/en/docs/generation-image-to-model/p)
- [Tripo Models Texture](https://developers.tripo3d.ai/en/docs/models-texture)
- [Tripo Mesh Decimate](https://developers.tripo3d.ai/en/docs/mesh-decimate)
- [Tripo Rigging](https://developers.tripo3d.ai/en/docs/animations-rig)
- [Tripo Retarget](https://developers.tripo3d.ai/en/docs/animations-retarget)
- [Rodin Quick Start](https://docs.hyper3d.ai/en/get-started/quick-start)
- [Rodin Gen-2.5 API](https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5)
- [Luma docs index](https://docs.lumalabs.ai/llms.txt)
- [Luma API](https://docs.lumalabs.ai/docs/api)
