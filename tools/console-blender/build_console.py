#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""路线 B：Blender headless 建掌机 → AO 烘培 → GLB。

跑法（无 GUI，幂等，删掉 GLB 也能一键重建）：

    blender -b --factory-startup --python-exit-code 1 \
            -P tools/console-blender/build_console.py

尺度约定（和路线 A / web/app/scene.js 一致）：建模单位 = 毫米，
1 three.js 单位 = 20 mm。下面所有常数照抄 scene.js 顶部常量块 × 20。

坐标：Blender 原生 Z-up，正面朝 -Y。导出 GLB 用 glTF 的 Y-up，
正面就变成 three.js 的 +Z，和 scene.js 的 FRONT_Z 对齐。

产出：
    web/assets/console-b.glb
    tools/console-blender/preview/front.png, three-quarter.png
    tools/console-blender/ao_shell.png    （AO 图，也内嵌进 GLB）
"""

import bpy
import bmesh
import math
import os

from mathutils import Matrix, Vector

# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, os.pardir, os.pardir))
OUT_GLB = os.path.join(REPO, "web", "assets", "console-b.glb")
PREVIEW_DIR = os.path.join(HERE, "preview")
AO_PNG = os.path.join(HERE, "ao_shell.png")
BLEND_OUT = os.path.join(HERE, "console.blend")

# --------------------------------------------------------------------------
# 比例：web/app/scene.js 顶部常量块（单位 mm）
# --------------------------------------------------------------------------
MM = 20.0

BODY_W = 10.00 * MM          # 200.0
BODY_H = 4.20 * MM           # 84.0
BODY_D = 0.95 * MM           # 19.0

FRONT_Y = -BODY_D / 2.0      # 正面
BACK_Y = BODY_D / 2.0

SCREEN_W = 5.20 * MM         # 104.0
SCREEN_H = 2.72 * MM         # 54.4
SCREEN_CY = -0.24 * MM       # -4.8

# ---- A2/C1/D1 正面顶部降沉带：带底脚印 z +29.3..+38.0，下沉 0.7mm，口沿 45° 倒角 ----
# D1：整体下移，使带口上沿 +38.5 落在面板顶边(+39.6)下方 1.1mm → 四条边都有 0.5mm 过渡
BAND_Z0, BAND_Z1 = 29.3, 38.0        # 8.7mm 高（全部落在面板平面顶边 +38.9 以内）
BAND_DEPTH = 0.7                     # C1：带底相对正面下沉（原 1.2）
BAND_CHAMFER = 0.5                   # C1：口沿 45° 倒角（水平/垂直各 0.5mm）
BAND_CZ = (BAND_Z0 + BAND_Z1) / 2.0  # +33.65 带子中线 = 带内三件共享中线

CTRL_X = 3.90 * MM           # 78.0
CTRL_W = 2.05 * MM           # 41.0
CTRL_CY = -0.18 * MM         # -3.6
CTRL_H = 3.10 * MM           # 62.0

# ---- 像素阶梯外轮廓 ----
# 新参考图的关键比例：短上斜 → 水平断台 → 明显更长的下斜 → 竖边。
# 像素描边本身保持每阶约 4×4px，避免用几何的平滑斜边冒充像素阶梯。
DESIGN_PX = 0.15
OUTLINE_COLOR = "#3B3747"
OUTLINE_WIDTH = 4.0 * DESIGN_PX
OUTLINE_OUTSET = 0.20
HIGHLIGHT_WIDTH = 2.0 * DESIGN_PX
CORNER_TOP_LEAD = 20.0 * DESIGN_PX
CORNER_UPPER_DIAG = 8.0
CORNER_SHELF = 6.0
CORNER_LOWER_DIAG = 15.0
CORNER_ANGLE = math.radians(48.0)
PIXEL_STAIR_SIZE = 4.0 * DESIGN_PX

# ---- 厚度方向派生量（scene.js 用 bevel 参数隐式表达） ----
SB_BEV = 1.8                 # 侧边带前后大倒角
# v4：参考图的侧面是米色厚边 + 前后各一道暗缝，不是整面黑 ——
# 所以暗色包边只在前后边缘各留一条细缝，而不是整圈深色侧墙。
PIPE_W = 1.6                 # 前后暗缝沿厚度方向的宽度
SHELL_INSET = 2.6            # 正面米白板相对整机轮廓内缩
SHELL_FRONT = FRONT_Y - 1.0  # 米白板面，比侧边带最前点再突出 1mm
SHELL_W = BODY_W - 2 * SHELL_INSET + 0.4   # 195.2 面板轮廓
SHELL_H = BODY_H - 2 * SHELL_INSET + 0.4   # 79.2
SHELL_TOP_Z = SHELL_H / 2.0                # +39.6 面板顶边（不是 +42）

# C4：带内三件按带子脚印垂直居中（D1 后带子完全落在面板内，不再被裁）
# D1 净空校核：唇边 = SHELL_TOP_Z(39.6) - (BAND_Z1 38.0 + 倒角 0.5) = 1.1mm

# 挖孔/分层尺寸（比 scene.js 原值收 1~2mm，见交付报告的偏差说明）
SCR_OPEN_W = SCREEN_W + 0.52 * MM      # 114.8 黑框外 = 挖孔口
SCR_OPEN_H = SCREEN_H + 0.48 * MM      # 66.6
SCR_GOLD_W = 0.30                      # 屏框金线视觉宽（B3 第2轮：2.0px @1440，含AA≈2.3px）
SCR_TRIM_W = SCREEN_W + 2 * SCR_GOLD_W  # 104.7 金线外（内缘仍贴玻璃 104.0）
SCR_TRIM_H = SCREEN_H + 2 * SCR_GOLD_W  # 55.1
SCR_GLASS_W = SCREEN_W                 # 104.0
SCR_GLASS_H = SCREEN_H                 # 54.4

# ---- 带内三件：扬声器孔阵 / 副显示屏（记牌条）/ ← 返回键（共用 BAND_CZ 中线）----
SUB_W = SCR_OPEN_W                   # 114.8 副显示屏宽 = 主屏黑框外框宽
SUB_H = 8.0                          # 副显示屏高
SUB_CZ = BAND_CZ                     # 中心 (0, +33.65)
SUB_DEPTH = 0.35                     # D2：比带底仅深 0.35mm（离面共 1.05mm，原 1.5）
SUB_TRIM = 0.30                      # 槽口细金线宽（与屏框同一档）

BACKKEY_W, BACKKEY_H = 12.1, 6.4     # C2：← 返回键（原 17x10）
BACKKEY_CX, BACKKEY_CZ = 69.0, BAND_CZ
BACKKEY_EDGE = 0.4                   # C2：金边 0.4mm（原 0.6）
BACKKEY_RAISE = 0.35                 # 黑键面高出带底

# 扬声器孔阵 9x7：横向间距 1.25，纵向间距 1.0，孔半径 0.32，深 1.2
SPK_COLS, SPK_ROWS = 9, 7
SPK_PITCH_X, SPK_PITCH_Z = 1.25, 1.0
SPK_R = 0.32
SPK_DEPTH = 1.2
SPK_CX, SPK_CZ = -66.0, BAND_CZ        # A3：孔阵只留在沉降带内、靠左

# 沉降带左右收口（评审第2轮）：只包住孔阵与返回键，不再横贯整面
BAND_X0 = SPK_CX - (SPK_COLS - 1) * SPK_PITCH_X / 2.0 - SPK_R - 1.3   # -72.6
BAND_X1 = BACKKEY_CX + BACKKEY_W / 2.0 + 1.5                          # +76.55

# 四角螺丝（浅凹坑 + 亮金属环 + 更深中心）
SCR_X = 86.0                           # 位置保持原来的 x
SCR_ZT, SCR_ZB = 26.0, -24.0           # 下排上移，避开像素双折角的长下斜

# 左握把 D-pad：整体 26x26，臂宽 9，厚 3.5；中心方键 8x8 再凸 1
DPAD_CX, DPAD_CZ = -77.0, 9.0
DPAD_W, DPAD_ARM = 26.0, 9.0
DPAD_DEPTH = 3.5
DPAD_EDGE = 0.6                        # 金色描边宽
DPAD_KEY = 8.0
DPAD_SYM_SIDE = 4.5                    # 白色三角边长
DPAD_SYM_H = 0.4                       # 符号凸起

# 右握把四个菱形键（B4）：旋转 45° 的方块，厚 3，中心 ±11
DIAMOND_CX, DIAMOND_CZ = 77.0, 7.0
DIAMOND_OFF = 11.0                     # B4：相邻中心距 11*sqrt2 = 15.6 ≥ 13
DIAMOND_HW, DIAMOND_HH = 5.6, 5.6      # 对角线 11.2 ≤ 12
DIAMOND_DEPTH = 3.0

# 方形键：只保留左侧一颗（A5），9x9，厚 3
SQ_W = 9.0
SQ_DEPTH = 3.0
SQ_L_CX, SQ_L_CZ = -68.0, -18.8        # A4：D-pad 中心右 10mm、下 23.7mm

# 键井（B1 已去背板）：只保留 KeyWell_L/R 命名节点，位置取原键井中心
WELL_X0, WELL_X1 = 62.0, 92.0          # 左：x -92..-62；右：62..92
WELL_Z0, WELL_Z1 = -25.0, 26.0

# --------------------------------------------------------------------------
# 颜色（web/tokens.json）
# --------------------------------------------------------------------------
C_GROUND = "#f2ecdd"
C_INK = "#141310"
C_OUTLINE = OUTLINE_COLOR
C_BAND = "#dccda6"       # ground 压暗 15%
C_GOLD = "#d2a15f"       # side_b 向 ground 靠拢
C_BEZEL = "#17161a"
C_INNER = "#2a2036"
C_GLASS = "#0b0f18"
C_KEY_EDGE = "#d9d5cc"   # P0：键的描边从金改成浅灰哑光（参考图键沿是浅色阶梯）


def log(msg):
    print("[build-console] %s" % msg, flush=True)


# ==========================================================================
# 通用工具
# ==========================================================================
def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_lin(h):
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16)) for i in (0, 2, 4))


def wipe_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials,
                 bpy.data.images, bpy.data.cameras, bpy.data.lights,
                 bpy.data.worlds, bpy.data.node_groups):
        for item in list(coll):
            try:
                coll.remove(item)
            except Exception:
                pass


def activate(obj):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj


def recalc_normals(obj):
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()


def new_object(name, verts, faces, mats=None):
    me = bpy.data.meshes.new(name)
    if verts or faces:
        me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
        me.validate(verbose=False)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for m in (mats or []):
        me.materials.append(m)
    if faces:
        recalc_normals(ob)
    return ob


def apply_transform(obj):
    activate(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def shade_by_angle(obj, angle_deg=30.0):
    """硬边平、圆角平滑：面全部 smooth，夹角超过阈值的边标 sharp。"""
    me = obj.data
    if not me.polygons:
        return
    for poly in me.polygons:
        poly.use_smooth = True
    limit = math.radians(angle_deg)
    bm = bmesh.new()
    bm.from_mesh(me)
    for edge in bm.edges:
        if len(edge.link_faces) == 2:
            ang = edge.calc_face_angle(None)
            edge.smooth = bool(ang is not None and ang < limit)
        else:
            edge.smooth = False
    bm.to_mesh(me)
    bm.free()
    me.update()


def apply_modifier(obj, mod_name=None):
    activate(obj)
    names = [mod_name] if mod_name else [m.name for m in obj.modifiers]
    for name in names:
        bpy.ops.object.modifier_apply(modifier=name)


def add_bevel(obj, width, segments=2, angle=30.0, clamp=True):
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    mod.use_clamp_overlap = clamp
    return mod


def try_bevel(obj, width, segments, angle):
    try:
        add_bevel(obj, width, segments, angle)
        apply_modifier(obj)
        return True
    except Exception as exc:                                  # noqa: BLE001
        log("bevel(%s) 跳过：%s" % (obj.name, exc))
        for m in list(obj.modifiers):
            obj.modifiers.remove(m)
        return False


def boolean(obj, cutter, op="DIFFERENCE"):
    mod = obj.modifiers.new("bool", "BOOLEAN")
    mod.operation = op
    mod.solver = "EXACT"
    mod.object = cutter
    apply_modifier(obj, mod.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def join_into(target, others):
    if not others:
        return target
    activate(target)
    for o in others:
        o.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()
    return target


# ==========================================================================
# 轮廓 / 实体
# ==========================================================================
def twenty_outline(w, h):
    """二十边外轮廓；左上角为短上斜、水平断台、长下斜的双折角。

    四角镜像，四条长边各保留一段 20px 的直段，使二十个顶点在几何上稳定可测。
    """
    upper_dx = CORNER_UPPER_DIAG * math.cos(CORNER_ANGLE)
    upper_dz = CORNER_UPPER_DIAG * math.sin(CORNER_ANGLE)
    lower_dx = CORNER_LOWER_DIAG * math.cos(CORNER_ANGLE)
    lower_dz = CORNER_LOWER_DIAG * math.sin(CORNER_ANGLE)
    inset_x = upper_dx + CORNER_SHELF + lower_dx
    inset_z = upper_dz + lower_dz
    hx, hz = w / 2.0, h / 2.0
    if 2.0 * (max(inset_x, inset_z) + CORNER_TOP_LEAD) >= min(w, h):
        raise ValueError("pixel twenty-gon does not fit this outline")

    # 从左上角顺时针绕行：每角五个顶点（直段、48°、断台阶、48°、竖边）。
    pts = [
        (-hx + inset_x + CORNER_TOP_LEAD, hz),
        (-hx + inset_x, hz),
        (-hx + inset_x - upper_dx, hz - upper_dz),
        (-hx + lower_dx, hz - upper_dz),
        (-hx, hz - inset_z),
        (-hx, -hz + inset_z + CORNER_TOP_LEAD),
        (-hx, -hz + inset_z),
        (-hx + upper_dx, -hz + inset_z - upper_dz),
        (-hx + upper_dx + CORNER_SHELF, -hz + inset_z - upper_dz),
        (-hx + inset_x, -hz),
        (hx - inset_x - CORNER_TOP_LEAD, -hz),
        (hx - inset_x, -hz),
        (hx - inset_x + upper_dx, -hz + upper_dz),
        (hx - lower_dx, -hz + upper_dz),
        (hx, -hz + inset_z),
        (hx, hz - inset_z - CORNER_TOP_LEAD),
        (hx, hz - inset_z),
        (hx - upper_dx, hz - inset_z + upper_dz),
        (hx - upper_dx - CORNER_SHELF, hz - inset_z + upper_dz),
        (hx - inset_x, hz),
    ]
    if len(pts) != 20:
        raise AssertionError("pixel outline must have exactly 20 vertices")
    return pts


def stairify(pts, step=PIXEL_STAIR_SIZE):
    """把多边形里所有非水平/垂直的边换成阶梯（每阶约 step 毫米）。"""
    out = []
    for a, b in zip(pts, pts[1:] + pts[:1]):
        out.append(a)
        dx, dz = b[0] - a[0], b[1] - a[1]
        if abs(dx) < 1e-6 or abs(dz) < 1e-6:
            continue
        steps = max(1, round(max(abs(dx), abs(dz)) / step))
        for k in range(1, steps + 1):
            # 先走水平那一格，再走竖直那一格
            out.append((a[0] + dx * k / steps, a[1] + dz * (k - 1) / steps))
            if k < steps:
                out.append((a[0] + dx * k / steps, a[1] + dz * k / steps))
    return out


def stepped_round_rect(w, h, r, step=PIXEL_STAIR_SIZE, steps=None):
    """圆角矩形，但四个角是 45° 阶梯（和机身外轮廓同一套台阶语言）。"""
    r = max(0.01, min(r, min(w, h) / 2.0 - 0.01))
    n = steps or max(1, int(round(r / step)))
    hx, hz = w / 2.0 - r, h / 2.0 - r
    corners = [
        ((hx + r, hz), (hx, hz + r)),        # 右上：先上、后左
        ((-hx, hz + r), (-hx - r, hz)),      # 左上：先左、后下
        ((-hx - r, -hz), (-hx, -hz - r)),    # 左下：先下、后右
        ((hx, -hz - r), (hx + r, -hz)),      # 右下：先右、后上
    ]
    first_move = [False, True, False, True]
    pts = [corners[0][0]]
    for ((sx, sz), (ex, ez)), horizontal_first in zip(corners, first_move):
        if pts[-1] != (sx, sz):
            pts.append((sx, sz))
        dx, dz = (ex - sx) / n, (ez - sz) / n
        x, z = pts[-1]
        for _ in range(n):
            if horizontal_first:
                x += dx
                pts.append((x, z))
                z += dz
                pts.append((x, z))
            else:
                z += dz
                pts.append((x, z))
                x += dx
                pts.append((x, z))
    return pts


def pixel_stair_outline(w, h):
    """在二十边外轮廓的斜边换成约 4×4px 的硬阶梯。"""
    return stairify(twenty_outline(w, h))


def ribbon_solid(a, b, width, y0, y1):
    """沿 CCW 轮廓内侧贴一条扁平高光带。"""
    dx, dz = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dz)
    nx, nz = -dz / length, dx / length  # CCW 轮廓的内法线
    cx, cz = nx * width / 2.0, nz * width / 2.0
    pts = [
        (a[0] + cx - nx * width / 2.0, a[1] + cz - nz * width / 2.0),
        (b[0] + cx - nx * width / 2.0, b[1] + cz - nz * width / 2.0),
        (b[0] + cx + nx * width / 2.0, b[1] + cz + nz * width / 2.0),
        (a[0] + cx + nx * width / 2.0, a[1] + cz + nz * width / 2.0),
    ]
    return prism_solid(pts, y0, y1)


def rounded_rect(w, h, r, seg=5):
    r = max(0.01, min(r, min(w, h) / 2.0 - 0.01))
    hw, hh = w / 2.0 - r, h / 2.0 - r
    pts = []
    for (cx, cz), a0 in zip([(hw, hh), (-hw, hh), (-hw, -hh), (hw, -hh)],
                            [0.0, 90.0, 180.0, 270.0]):
        for i in range(seg + 1):
            a = math.radians(a0 + 90.0 * i / seg)
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    return pts


def resample_poly(pts, n):
    """按弧长把多边形重采样成 n 个点：外圈改阶梯后，内圈用这个对齐点数。"""
    m = len(pts)
    if m == n:
        return list(pts)
    seg = []
    total = 0.0
    for i in range(m):
        a, b = pts[i], pts[(i + 1) % m]
        d = math.hypot(b[0] - a[0], b[1] - a[1])
        seg.append(d)
        total += d
    out = []
    for k in range(n):
        target = total * k / n
        acc = 0.0
        for i, d in enumerate(seg):
            if acc + d >= target or i == m - 1:
                t = (target - acc) / d if d > 1e-12 else 0.0
                a, b = pts[i], pts[(i + 1) % m]
                out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                break
            acc += d
    return out


def prism_solid(pts, y0, y1):
    n = len(pts)
    verts = [(p[0], y0, p[1]) for p in pts] + [(p[0], y1, p[1]) for p in pts]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    return verts, faces


def loft_solid(layers):
    """多层同点数的棱柱/棱台：layers = [(pts, y), ...]，pts 为 (x, z)。"""
    n = len(layers[0][0])
    verts = []
    for pts, y in layers:
        verts += [(p[0], y, p[1]) for p in pts]
    faces = []
    for k in range(len(layers) - 1):
        a, b = k * n, (k + 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((a + i, a + j, b + j, b + i))
    faces.append(tuple(range(n - 1, -1, -1)))
    last = (len(layers) - 1) * n
    faces.append(tuple(range(last, last + n)))
    return verts, faces


def rect_pts(w, h):
    hw, hh = w / 2.0, h / 2.0
    return [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]


def loft_ring_solid(profiles):
    """外圈带倒角的环：profiles = [(outer_pts, inner_pts, y), ...]"""
    n = len(profiles[0][0])
    layers = len(profiles)
    verts = []
    for outer, inner, y in profiles:
        verts += [(p[0], y, p[1]) for p in outer]
        verts += [(p[0], y, p[1]) for p in inner]
    faces = []
    for k in range(layers - 1):
        oa, ia = k * 2 * n, k * 2 * n + n
        ob, ib = (k + 1) * 2 * n, (k + 1) * 2 * n + n
        for i in range(n):
            j = (i + 1) % n
            faces.append((oa + i, oa + j, ob + j, ob + i))
            faces.append((ia + j, ia + i, ib + i, ib + j))
    oa, ia = 0, n
    for i in range(n):
        j = (i + 1) % n
        faces.append((oa + i, ia + i, ia + j, oa + j))
    oa, ia = (layers - 1) * 2 * n, (layers - 1) * 2 * n + n
    for i in range(n):
        j = (i + 1) % n
        faces.append((oa + j, ia + j, ia + i, oa + i))
    return verts, faces


def ring_solid(outer, inner, y0, y1):
    if len(outer) != len(inner):
        raise ValueError("ring_solid 内外圈点数必须一致：%d vs %d"
                         % (len(outer), len(inner)))
    n = len(outer)
    verts = ([(p[0], y0, p[1]) for p in outer] + [(p[0], y1, p[1]) for p in outer]
             + [(p[0], y0, p[1]) for p in inner] + [(p[0], y1, p[1]) for p in inner])
    o0, o1, i0, i1 = 0, n, 2 * n, 3 * n
    faces = []
    for i in range(n):
        j = (i + 1) % n
        faces.append((o0 + i, o0 + j, i0 + j, i0 + i))
        faces.append((o1 + j, o1 + i, i1 + i, i1 + j))
        faces.append((o0 + i, o1 + i, o1 + j, o0 + j))
        faces.append((i0 + j, i1 + j, i1 + i, i0 + i))
    return verts, faces


def cylinder_solid(r, y0, y1, x, z, seg=16):
    verts, faces = [], []
    for y in (y0, y1):
        for i in range(seg):
            a = 2.0 * math.pi * i / seg
            verts.append((x + r * math.cos(a), y, z + r * math.sin(a)))
    faces.append(tuple(range(seg - 1, -1, -1)))
    faces.append(tuple(range(seg, 2 * seg)))
    for i in range(seg):
        j = (i + 1) % seg
        faces.append((i, j, seg + j, seg + i))
    return verts, faces


def box_solid(w, h, d, center, rot_y=0.0):
    cx, cy, cz = center
    hw, hh, hd = w / 2.0, h / 2.0, d / 2.0
    mat = Matrix.Rotation(rot_y, 3, "Y")
    verts = []
    for y in (-hd, hd):
        for (u, v) in [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]:
            p = mat @ Vector((u, 0.0, v))
            verts.append((cx + p.x, cy + y, cz + p.z))
    faces = [(3, 2, 1, 0), (4, 5, 6, 7),
             (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return verts, faces


def make_mat(name, hex_col, rough, metal):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    r, g, b = hex_lin(hex_col)
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    mat.diffuse_color = (r, g, b, 1.0)
    return mat


# ==========================================================================
# 建模
# ==========================================================================
def build_side_band(mats):
    """侧边带：二十边米色厚边 + 像素阶梯深色描边 + 内侧白色高光。"""
    inner = twenty_outline(BODY_W - 2 * SHELL_INSET, BODY_H - 2 * SHELL_INSET)
    outer_f = twenty_outline(BODY_W - 2 * SB_BEV, BODY_H - 2 * SB_BEV)
    outer_m = twenty_outline(BODY_W, BODY_H)
    # 比深色环内缘外扩一格，确保阶梯内缘的凹口也被唇边压住；
    # 仍留在深色环外缘以内，因此正视时黑边依然是最外圈。
    lip_w = BODY_W - 2 * (OUTLINE_WIDTH - OUTLINE_OUTSET) + PIXEL_STAIR_SIZE
    lip_h = BODY_H - 2 * (OUTLINE_WIDTH - OUTLINE_OUTSET) + PIXEL_STAIR_SIZE
    outer_lip = twenty_outline(lip_w, lip_h)
    v, f = loft_ring_solid([
        (outer_lip, inner, SHELL_FRONT - 0.02),
        (outer_lip, inner, FRONT_Y),
        (outer_m, inner, FRONT_Y + SB_BEV),
        (outer_m, inner, BACK_Y - SB_BEV),
        (outer_f, inner, BACK_Y),
    ])
    obj = new_object("SideBand", v, f, mats=[mats["band"]])
    add_bevel(obj, 0.5, segments=2, angle=25.0)
    apply_modifier(obj)

    # 深紫黑描边：正面/背面各一道 3–4px 的像素阶梯实线。
    # 不倒角，避免 4×4px 的台阶被磨圆。
    g_out = pixel_stair_outline(BODY_W + 2 * OUTLINE_OUTSET,
                                BODY_H + 2 * OUTLINE_OUTSET)
    inset = OUTLINE_WIDTH - OUTLINE_OUTSET
    g_in = pixel_stair_outline(BODY_W - 2 * inset, BODY_H - 2 * inset)

    pipes = []
    for y0, y1 in ((SHELL_FRONT - 0.10, SHELL_FRONT + 0.04),
                   (BACK_Y - SB_BEV - 0.15 - PIPE_W, BACK_Y - SB_BEV - 0.15)):
        v, f = ring_solid(g_out, g_in, y0, y1)
        pipes.append(new_object("PixelOutline", v, f, mats=[mats["outline"]]))

    # 2px 白高光只走斜边和竖边；水平边（包括顶部）严格留空。
    highlights = []
    light_pts = twenty_outline(BODY_W - 2 * inset, BODY_H - 2 * inset)
    for a, b in zip(light_pts, light_pts[1:] + light_pts[:1]):
        if abs(b[1] - a[1]) < 1e-6:
            continue
        v, f = ribbon_solid(a, b, HIGHLIGHT_WIDTH,
                            SHELL_FRONT - 0.16, SHELL_FRONT - 0.11)
        highlights.append(new_object("OutlineHighlight", v, f, mats=[mats["highlight"]]))
    join_into(obj, pipes + highlights)
    return obj


def screen_open_outline():
    """屏幕挖孔与 Bezel 外圈共用的像素阶梯轮廓。"""
    return stepped_round_rect(SCR_OPEN_W, SCR_OPEN_H, 3.0)


def build_shell(mats):
    """正面米白板：屏幕孔 / 顶部沉降带 / 副屏凹槽 / 扬声器孔 / 螺丝凹点 / 分隔缝。"""
    pts = pixel_stair_outline(SHELL_W, SHELL_H)      # P3：正面板跟机身同一套台阶
    v, f = prism_solid(pts, SHELL_FRONT, BACK_Y)
    obj = new_object("Shell", v, f, mats=[mats["shell"]])
    add_bevel(obj, 0.45, segments=2, angle=28.0)     # 台阶只有 0.6mm，倒角收窄
    apply_modifier(obj)

    cutters = []

    # ① 屏幕：真布尔通孔
    v, f = prism_solid(screen_open_outline(),
                       SHELL_FRONT - 1.0, SHELL_FRONT + 5.0)
    c = new_object("cut_screen", v, f)
    c.location = (0.0, 0.0, SCREEN_CY)
    apply_transform(c)
    cutters.append(c)

    # ② 降沉带（C1）：深 0.7mm；口沿 0.5mm 水平 × 0.5mm 深 = 45° 倒角，再 0.2mm 直壁到带底
    band_cx = (BAND_X0 + BAND_X1) / 2.0
    band_w, band_h = BAND_X1 - BAND_X0, BAND_Z1 - BAND_Z0
    small = rect_pts(band_w, band_h)
    big = rect_pts(band_w + 2 * BAND_CHAMFER, band_h + 2 * BAND_CHAMFER)
    v, f = loft_solid([(big, SHELL_FRONT - 1.0),
                       (big, SHELL_FRONT),
                       (small, SHELL_FRONT + BAND_CHAMFER),
                       (small, SHELL_FRONT + BAND_DEPTH)])
    c = new_object("cut_band", v, f)
    c.location = (band_cx, 0.0, BAND_CZ)
    apply_transform(c)
    cutters.append(c)

    # ③ 副显示屏（记牌条）凹槽：比带底再深 0.35mm（D2）
    v, f = prism_solid(rounded_rect(SUB_W, SUB_H, 1.4, seg=4),
                       SHELL_FRONT - 1.0, SHELL_FRONT + BAND_DEPTH + SUB_DEPTH)
    c = new_object("cut_sub", v, f)
    c.location = (0.0, 0.0, SUB_CZ)
    apply_transform(c)
    cutters.append(c)

    # ④ 扬声器孔阵 9x7（真孔）：完全落在沉降带内、靠左
    sv, sf = [], []
    spk_x0 = SPK_CX - (SPK_COLS - 1) * SPK_PITCH_X / 2.0
    spk_z0 = SPK_CZ + (SPK_ROWS - 1) * SPK_PITCH_Z / 2.0
    for r in range(SPK_ROWS):
        for cc in range(SPK_COLS):
            cv, cf = cylinder_solid(SPK_R, SHELL_FRONT - 1.0,
                                    SHELL_FRONT + BAND_DEPTH + SPK_DEPTH,
                                    spk_x0 + cc * SPK_PITCH_X,
                                    spk_z0 - r * SPK_PITCH_Z, seg=10)
            off = len(sv)
            sv += cv
            sf += [tuple(i + off for i in face) for face in cf]
    cutters.append(new_object("cut_speakers", sv, sf))

    # ⑤ 四角螺丝：浅圆柱凹坑（金属环/中心在 build_screws 里补）
    sv, sf = [], []
    for sz in (SCR_ZT, SCR_ZB):
        for sx in (-1, 1):
            cv, cf = cylinder_solid(1.9, SHELL_FRONT - 1.0,
                                    SHELL_FRONT + 0.7, sx * SCR_X, sz, seg=20)
            off = len(sv)
            sv += cv
            sf += [tuple(i + off for i in face) for face in cf]
    cutters.append(new_object("cut_screws", sv, sf))

    # ⑥ 中段分隔竖缝
    for sgn in (-1, 1):
        v, f = box_solid(1.0, 74.0, 1.0, (sgn * 58.1, 0.0, -1.0))
        c = new_object("cut_seam", v, f)
        c.location = (0.0, SHELL_FRONT - 0.15, 0.0)
        cutters.append(c)

    for c in cutters:
        boolean(obj, c)

    try_bevel(obj, 0.12, 1, 45.0)

    return obj


def build_screen(mats):
    """屏幕分层：黑框 Bezel / 金细线 Trim / 深色内衬 / 玻璃 Screen。"""
    bezel_front = SHELL_FRONT - 0.25
    bezel_back = bezel_front + 3.2
    bezel_outer = screen_open_outline()
    bezel_inner = resample_poly(rounded_rect(SCR_TRIM_W, SCR_TRIM_H, 2.6, seg=6),
                                len(bezel_outer))
    v, f = ring_solid(bezel_outer, bezel_inner, bezel_front, bezel_back)
    bezel = new_object("Bezel", v, f, mats=[mats["bezel"], mats["inner"]])
    try_bevel(bezel, 0.25, 1, 30.0)

    v, f = prism_solid(rounded_rect(SCR_TRIM_W, SCR_TRIM_H, 2.6, seg=6),
                       bezel_back - 1.0, bezel_back + 0.6)
    join_into(bezel, [new_object("Lining", v, f, mats=[mats["inner"]])])

    v, f = ring_solid(rounded_rect(SCR_TRIM_W, SCR_TRIM_H, 2.6, seg=6),
                      rounded_rect(SCR_GLASS_W, SCR_GLASS_H, 2.4, seg=6),
                      bezel_front + 0.15, bezel_front + 0.75)
    trim = new_object("TrimScreen", v, f, mats=[mats["gold"]])

    v, f = prism_solid(rounded_rect(SCR_GLASS_W, SCR_GLASS_H, 2.4, seg=6),
                       bezel_front + 0.5, bezel_front + 1.7)
    glass = new_object("Screen", v, f, mats=[mats["glass"]])
    try_bevel(glass, 0.2, 1, 30.0)

    # 屏幕分层统一落到 SCREEN_CY（挖孔就是按这个中心切的）
    for ob in (bezel, trim, glass):
        ob.location.z = SCREEN_CY
        apply_transform(ob)
        shade_by_angle(ob, 25.0)
    return bezel, trim, glass


def build_trim(mats, screen_trim):
    """Trim：只剩屏框金线（C3：底部金条已删，下沿只留侧边带斜面 + 暗色分模缝）。"""
    trim = new_object("Trim", [], [])
    return join_into(trim, [screen_trim])


def build_band_inset(mats):
    """沉降带内新增件（挂 Shell 下）：副显示屏 + ← 返回键。"""
    mouth_y = SHELL_FRONT + BAND_DEPTH            # 槽口平面
    floor_y = mouth_y + SUB_DEPTH                 # 副屏屏面（比带底深 0.35）

    # 槽口内一圈 0.30mm 细金线：贴槽壁，不越出沉降带上沿
    v, f = ring_solid(rounded_rect(SUB_W - 0.06, SUB_H - 0.06, 1.4, seg=4),
                      rounded_rect(SUB_W - 2 * SUB_TRIM, SUB_H - 2 * SUB_TRIM,
                                   1.1, seg=4),
                      mouth_y - 0.02, floor_y + 0.1)
    lip = new_object("SubDisplay_lip", v, f, mats=[mats["key_edge"]])
    lip.location = (0.0, 0.0, SUB_CZ)
    apply_transform(lip)
    shade_by_angle(lip, 25.0)

    v, f = prism_solid(rounded_rect(SUB_W - 2 * SUB_TRIM + 0.1,
                                    SUB_H - 2 * SUB_TRIM + 0.1, 1.1, seg=4),
                       floor_y - 0.02, floor_y + 0.8)
    sub = new_object("SubDisplay", v, f, mats=[mats["dark"]])
    sub.location = (0.0, 0.0, SUB_CZ)
    apply_transform(sub)
    join_into(sub, [lip])
    shade_by_angle(sub, 25.0)

    # C2/D1：← 返回键 12.1x6.4 @ (+69, +33.65)，与副屏同一水平中线；金边 0.4mm
    gold = front_piece("BackKey_edge", stepped_round_rect(BACKKEY_W, BACKKEY_H, 1.5),
                       SHELL_FRONT + BAND_DEPTH - BACKKEY_RAISE + 0.15,
                       SHELL_FRONT + BAND_DEPTH + 2.2, [mats["key_edge"]], bevel=0.08)
    black = front_piece("BackKey_black",
                        stepped_round_rect(BACKKEY_W - 2 * BACKKEY_EDGE,
                                           BACKKEY_H - 2 * BACKKEY_EDGE, 1.2),
                        SHELL_FRONT + BAND_DEPTH - BACKKEY_RAISE,
                        SHELL_FRONT + BAND_DEPTH + 2.05, [mats["key"]], bevel=0.14)
    for ob in (gold, black):
        ob.location = (BACKKEY_CX, 0.0, BACKKEY_CZ)
        apply_transform(ob)
        shade_by_angle(ob, 28.0)
    back = new_object("BackKey", [], [])
    join_into(back, [gold, black])

    return [sub, back]


def build_key_wells():
    """左右键井：B1 去掉背板几何，只保留 KeyWell_L / KeyWell_R 命名节点。"""
    out = []
    for tag, sgn in (("L", -1), ("R", 1)):
        ob = bpy.data.objects.new("KeyWell_%s" % tag, None)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = (sgn * (WELL_X0 + WELL_X1) / 2.0, 0.0,
                       (WELL_Z0 + WELL_Z1) / 2.0)
        out.append(ob)
    return out


# ==========================================================================
# 握把按键 / 螺丝
# ==========================================================================
def ring_poly(w, h, bw):
    """矩形边框环（按钮金边用）。"""
    return ([(w / 2, h / 2), (-w / 2, h / 2), (-w / 2, -h / 2), (w / 2, -h / 2)],
            [(w / 2 - bw, h / 2 - bw), (-w / 2 + bw, h / 2 - bw),
             (-w / 2 + bw, -h / 2 + bw), (w / 2 - bw, -h / 2 + bw)])


def cross_outline(w, arm):
    """26x26 十字轮廓（12 点），臂宽 arm。"""
    a = arm / 2.0
    b = w / 2.0
    return [(a, b), (a, a), (b, a), (b, -a), (a, -a), (a, -b),
            (-a, -b), (-a, -a), (-b, -a), (-b, a), (-a, a), (-a, b)]


def stepped_diamond(hw, hh, steps):
    """左右/上下镜像的像素菱形：顶点各有半格平台，阶梯不偏向任一侧。"""
    steps = max(1, int(steps))
    qx = hw / (steps + 0.5)
    qz = hh / (steps + 0.5)
    ax, az = qx / 2.0, qz / 2.0

    # 从顶边右端顺时针走到右顶点，再镜像出其余三段。
    right = [(ax, hh)]
    for i in range(steps):
        x = ax + i * qx
        z = hh - i * qz
        right.append((x, z - qz))
        right.append((x + qx, z - qz))

    pts = [(-ax, hh)] + right
    pts.append((hw, -az))
    bottom_right = [(x, -z) for x, z in reversed(right)]
    pts += bottom_right[1:]
    pts.append((-ax, -hh))
    bottom_left = [(-x, z) for x, z in reversed(bottom_right)]
    pts += bottom_left[1:]
    pts.append((-hw, az))
    top_left = [(-x, z) for x, z in reversed(right)]
    pts += top_left[1:]
    if pts[-1] == pts[0]:
        pts.pop()
    return pts


def diamond_key_outlines(hw, hh, edge):
    """菱形键外/内轮廓：同一 qx/qz 网格，内圈比外圈均匀内缩一格。"""
    outer_hw, outer_hh = hw + edge, hh + edge
    steps = max(2, int(round(outer_hw / PIXEL_STAIR_SIZE - 0.5)))
    qx = outer_hw / (steps + 0.5)
    qz = outer_hh / (steps + 0.5)
    outer = stepped_diamond(outer_hw, outer_hh, steps)
    inner = stepped_diamond(outer_hw - qx, outer_hh - qz, steps - 1)
    return outer, inner


def star_poly(radius, inner=0.44, points=5, rot=90.0):
    """★：一个角朝上的五角星（键面图案）。"""
    pts = []
    for i in range(points * 2):
        a = math.radians(rot + i * 180.0 / points)
        rr = radius if i % 2 == 0 else radius * inner
        pts.append((rr * math.cos(a), rr * math.sin(a)))
    return pts


def tri_poly(radius, rot_deg, cx=0.0, cz=0.0):
    """三角形：radius 外接圆，rot_deg 指向。"""
    return [(cx + radius * math.cos(math.radians(rot_deg + i * 120.0)),
             cz + radius * math.sin(math.radians(rot_deg + i * 120.0)))
            for i in range(3)]


def arc_band_poly(r_out, r_in, a0, a1, seg=16):
    """圆环的一段（↺ 的弧）：外弧走一遍，再沿内弧走回来。"""
    pts = []
    for k in range(seg + 1):
        a = math.radians(a0 + (a1 - a0) * k / seg)
        pts.append((r_out * math.cos(a), r_out * math.sin(a)))
    for k in range(seg, -1, -1):
        a = math.radians(a0 + (a1 - a0) * k / seg)
        pts.append((r_in * math.cos(a), r_in * math.sin(a)))
    return pts


def x_poly(arm, length):
    """✕：把十字多边形转 45°。"""
    c = math.cos(math.radians(45.0))
    return [(x * c - z * c, x * c + z * c) for x, z in cross_outline(length, arm)]


def front_piece(name, pts, front, back, mats, bevel=0.12):
    """XY 平面多边形沿 -Y 挤出；front 比 back 更靠前（更负）。"""
    v, f = prism_solid(pts, min(front, back), max(front, back))
    ob = new_object(name, v, f, mats=mats)
    if bevel:
        try_bevel(ob, bevel, 1, 35.0)
    return ob


def triangle_prism(p0, p1, p2, front, back, mats):
    """三角符号薄片；点按标准方向给出朝前(-Y)的法线。"""
    verts = [(p0[0], front, p0[1]), (p1[0], front, p1[1]),
             (p2[0], front, p2[1]), (p0[0], back, p0[1]),
             (p1[0], back, p1[1]), (p2[0], back, p2[1])]
    faces = [(0, 1, 2), (3, 5, 4),
             (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
    return new_object("Symbol", verts, faces, mats=mats)


def build_dpad(mats, shell):
    """左握把 D-pad：26x26、臂宽 9、厚 3.5；8x8 中心键再凸 1；四面白三角。"""
    front = SHELL_FRONT - DPAD_DEPTH
    gold_out = cross_outline(DPAD_W + 2 * DPAD_EDGE, DPAD_ARM + 2 * DPAD_EDGE)
    black = cross_outline(DPAD_W, DPAD_ARM)
    key_front = front - 1.0

    pieces = [
        front_piece("dpad_edge", gold_out, front + 0.30,
                    SHELL_FRONT + 0.05, [mats["key_edge"]], bevel=0.10),
        front_piece("dpad_black", black, front - 0.10, front + 0.32,
                    [mats["key"]], bevel=0.22),
        front_piece("key_edge",
                    stepped_round_rect(DPAD_KEY + 2 * DPAD_EDGE,
                                       DPAD_KEY + 2 * DPAD_EDGE, 1.2, steps=2),
                    key_front + 0.25, front + 0.10, [mats["key_edge"]], bevel=0.08),
        front_piece("key_center",
                    stepped_round_rect(DPAD_KEY, DPAD_KEY, 0.6, steps=1),
                    key_front - 0.05, key_front + 0.30,
                    [mats["key_center"]], bevel=0.10),
        # P1：参考图十字键中心是亮色方块（我们原来是纯黑）
        front_piece("key_center_face", rounded_rect(4.4, 4.4, 0.5, seg=2),
                    key_front - 0.20, key_front + 0.02,
                    [mats["symbol"]], bevel=0.04),
    ]

    # 四个白色三角形：上/下/左/右，顶点朝外，落在十字臂上
    t = DPAD_SYM_SIDE
    h = t * math.sqrt(3.0) / 2.0
    r = DPAD_W / 2.0 - 0.6
    tri_front, tri_back = front - DPAD_SYM_H, front + 0.05
    symbols = [
        ((0.0, r), (-t / 2, r - h), (t / 2, r - h)),
        ((0.0, -r), (t / 2, -r + h), (-t / 2, -r + h)),
        ((-r, 0.0), (-r + h, t / 2), (-r + h, -t / 2)),
        ((r, 0.0), (r - h, -t / 2), (r - h, t / 2)),
    ]
    for i, tri in enumerate(symbols):
        symbols_ob = triangle_prism(tri[0], tri[1], tri[2],
                                   tri_front, tri_back, [mats["symbol"]])
        symbols_ob.name = "DPad_Symbol_%d" % i
        pieces.append(symbols_ob)

    dpad = new_object("DPad", [], [])
    for ob in pieces:
        ob.location = (DPAD_CX, 0.0, DPAD_CZ)
        apply_transform(ob)
        shade_by_angle(ob, 28.0)
    join_into(dpad, pieces)
    return dpad


def build_right_keys(mats):
    """右握把四菱形键：浅灰阶梯描边 + 键面图案（★推荐 / ↺撤销 / ▶出牌 / ✕不要）。"""
    out = []
    half_w = DIAMOND_HW
    half_h = DIAMOND_HH
    cap_front = SHELL_FRONT - DIAMOND_DEPTH - 0.10        # 黑键面的正面
    sym_front, sym_back = cap_front - 0.15, cap_front + 0.05   # P1：图案微凸 0.15mm

    # 图案用符号不用文字：和左边十字键的白三角是同一套语言
    glyphs = {
        "Up": [star_poly(2.40, 0.44, rot=90.0)],                    # ★ 推荐
        "Left": [arc_band_poly(2.10, 1.45, 75.0, 330.0, 16),        # ↺ 撤销
                 tri_poly(1.30, 150.0, 1.15, 1.92)],
        "Right": [tri_poly(2.50, 0.0, -0.625, 0.0)],               # ▶ 出牌
        "Down": [x_poly(1.00, 4.20)],                               # ✕ 不要
    }
    positions = [
        ("Up", 0.0, DIAMOND_OFF),
        ("Left", -DIAMOND_OFF, 0.0),
        ("Right", DIAMOND_OFF, 0.0),
        ("Down", 0.0, -DIAMOND_OFF),
    ]
    edge_pts, black_pts = diamond_key_outlines(half_w, half_h, DPAD_EDGE)
    for name, dx, dz in positions:
        edge = front_piece("diamond_edge_" + name,
                           edge_pts,
                           SHELL_FRONT - DIAMOND_DEPTH + 0.30,
                           SHELL_FRONT + 0.05, [mats["key_edge"]], bevel=0.10)
        black = front_piece("diamond_black_" + name,
                            black_pts,
                            cap_front, SHELL_FRONT + 0.32,
                            [mats["key"]], bevel=0.16)
        for ob in (edge, black):
            ob.location = (DIAMOND_CX + dx, 0.0, DIAMOND_CZ + dz)
            apply_transform(ob)
            shade_by_angle(ob, 28.0)
        out += [edge, black]
        for i, poly in enumerate(glyphs[name]):
            sym = front_piece("KeySymbol_%s_%d" % (name, i), poly,
                              sym_front, sym_back, [mats["symbol"]], bevel=0.0)
            sym.location = (DIAMOND_CX + dx, 0.0, DIAMOND_CZ + dz)
            apply_transform(sym)
            shade_by_angle(sym, 28.0)
            out.append(sym)
    return out


def build_square_key(name, mats, cx, cz):
    front = SHELL_FRONT - SQ_DEPTH
    gold = front_piece(name + "_edge",
                       stepped_round_rect(SQ_W + 2 * DPAD_EDGE,
                                          SQ_W + 2 * DPAD_EDGE, 1.2),
                       front + 0.30, SHELL_FRONT + 0.05,
                       [mats["key_edge"]], bevel=0.10)
    black = front_piece(name,
                        stepped_round_rect(SQ_W, SQ_W, 0.6, steps=1),
                        front - 0.10, front + 0.32,
                        [mats["key"]], bevel=0.18)
    for ob in (gold, black):
        ob.location = (cx, 0.0, cz)
        apply_transform(ob)
        shade_by_angle(ob, 28.0)
    return [gold, black]


def parent_children(parent, children):
    for child in children:
        child.parent = parent
        child.matrix_parent_inverse = parent.matrix_world.inverted()


def build_screws(mats, shell):
    """四颗螺丝：浅灰阶梯圆盘 + 深色凹点（P0 哑光浅色 / P2 阶梯）。

    4.6mm 的小圆环做阶梯会自交（台阶会切进内圈），所以改成"阶梯圆盘 + 深色凹点"，
    看上去仍是参考图那种"浅色环 + 深色点"。
    """
    pieces = []
    for sz in (SCR_ZT, SCR_ZB):
        for sx in (-1, 1):
            x, z = sx * SCR_X, sz
            # 16 边像素化圆盘：比 4 阶方角盘更接近参考图的浅色圆环。
            v, f = cylinder_solid(2.3, SHELL_FRONT - 0.32,
                                  SHELL_FRONT + 0.22, x, z, seg=16)
            ring = new_object("screw_ring", v, f, mats=[mats["screw"]])
            try_bevel(ring, 0.04, 1, 35.0)
            v, f = cylinder_solid(0.90, SHELL_FRONT - 0.40,
                                  SHELL_FRONT + 0.05, x, z, seg=20)
            center = new_object("screw_center", v, f, mats=[mats["screw_dark"]])
            pieces += [ring, center]
    screws = new_object("Screws", [], [])
    return join_into(screws, pieces)


# ==========================================================================
# UV + AO
# ==========================================================================
def smart_uv(obj, angle=66.0, margin=0.02):
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")


def find_tex_node(mat):
    for n in mat.node_tree.nodes:
        if n.type == "TEX_IMAGE":
            return n
    return None


def planar_uv_front(obj, size_x, size_z, cx, cz):
    """Screen 正面固定 0..1 平面 UV：前端把 RenderTarget 贴上来时方向可预期。"""
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    uvl = obj.data.uv_layers.active.data
    me = obj.data
    for poly in me.polygons:
        front = poly.normal.y < -0.9
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if front:
                u = (co.x - (cx - size_x / 2.0)) / size_x
                v = (co.z - (cz - size_z / 2.0)) / size_z
            else:
                u = v = 0.5
            uvl[li].uv = (u, v)


def bake_ao(obj, size=1024):
    img = bpy.data.images.new("console_ao", width=size, height=size)
    img.colorspace_settings.name = "sRGB"

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 64
    scene.render.bake.target = "IMAGE_TEXTURES"
    scene.render.bake.margin = 8
    scene.render.bake.use_clear = True

    for i, slot in enumerate(obj.material_slots):
        mat = slot.material
        if mat is None:
            log("  slot %d 为空，跳过" % i)
            continue
        node = find_tex_node(mat)
        if node is None:
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = img
        mat.node_tree.nodes.active = node
        node.select = True
        log("  slot %d -> %s (%s)" % (i, mat.name, node.name))

    activate(obj)
    bpy.ops.object.bake(type="AO")
    img.filepath_raw = AO_PNG
    img.file_format = "PNG"
    img.save()
    log("AO 烘好 -> %s" % AO_PNG)
    return img


def hook_ao(mat, img):
    """AO 乘进 Base Color：Blender 里能直接看到，导出成 baseColorTexture。"""
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tex = find_tex_node(mat) or nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Linear"
    tex.location = (-760, 260)

    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.location = (-420, 260)
    mix.inputs[0].default_value = 1.0                       # Factor
    base = bsdf.inputs["Base Color"].default_value[:3]
    mix.inputs[6].default_value = (base[0], base[1], base[2], 1.0)   # A
    nt.links.new(tex.outputs["Color"], mix.inputs[7])                # B
    nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])


# ==========================================================================
# 预览渲染
# ==========================================================================
def aim(obj, target):
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def add_area(name, loc, energy, size, target=(0, 0, 0)):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = size
    ob = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(ob)
    ob.location = loc
    aim(ob, target)
    return ob


def setup_preview_scene():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 72
    scene.cycles.use_denoising = True
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "PNG"

    # 环境光用「上亮下暗」的渐变，不是纯平色块 ——
    # 纯平背景下金属只能反射出同一个灰，看起来就像涂料；有梯度才读得出金属/玻璃
    world = bpy.data.worlds.new("preview")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    bg.inputs[1].default_value = 1.0
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapn = nt.nodes.new("ShaderNodeMapping")
    mapn.inputs["Rotation"].default_value = (math.radians(90.0), 0.0, math.radians(90.0))
    grad = nt.nodes.new("ShaderNodeTexGradient")
    grad.gradient_type = "EASING"
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.elements[0].position = 0.0
    cr.elements[0].color = (0.74, 0.73, 0.71, 1.0)     # 下：略暗
    cr.elements[1].position = 1.0
    cr.elements[1].color = (1.28, 1.26, 1.20, 1.0)     # 上：亮（金属有高光可反射）
    mid = cr.elements.new(0.55)
    mid.color = (1.00, 0.99, 0.96, 1.0)                 # 中段：主照明
    nt.links.new(coord.outputs["Generated"], mapn.inputs["Vector"])
    nt.links.new(mapn.outputs["Vector"], grad.inputs["Vector"])
    nt.links.new(grad.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs[0])

    add_area("key", (-260, -380, 320), 240, 320)
    add_area("fill", (380, -300, 40), 110, 380)
    add_area("top", (40, -80, 460), 130, 300)

    # 反射源（一块发光横条，落在相机背后 → 不进画面，但会被玻璃/键帽反射到）：
    # 纯渐变是低频环境，竖直玻璃反射出来还是一块平色，读不出"玻璃"；
    # 有一个具体形状可反射，玻璃才有高光带、键帽才有缎面高光。
    sm = bpy.data.meshes.new("softbox")
    sw, sh = 340.0, 70.0
    sm.from_pydata([(-sw, 0.0, -sh), (sw, 0.0, -sh), (sw, 0.0, sh), (-sw, 0.0, sh)],
                   [], [(0, 1, 2, 3)])
    smat = bpy.data.materials.new("softboxMat")
    smat.use_nodes = True
    snt = smat.node_tree
    for node in list(snt.nodes):
        snt.nodes.remove(node)
    em = snt.nodes.new("ShaderNodeEmission")
    em.inputs[0].default_value = (1.0, 0.99, 0.96, 1.0)
    em.inputs[1].default_value = 1.1
    sout = snt.nodes.new("ShaderNodeOutputMaterial")
    snt.links.new(em.outputs[0], sout.inputs[0])
    sm.materials.append(smat)
    softbox = bpy.data.objects.new("softbox", sm)
    bpy.context.scene.collection.objects.link(softbox)
    softbox.location = (-40.0, -660.0, 150.0)
    # 只让它被"反射光线"看见：参与照明或进画面都会把整机打爆/穿帮
    softbox.visible_camera = False
    softbox.visible_diffuse = False
    softbox.visible_shadow = False
    softbox.visible_transmission = False
    softbox.visible_glossy = True

    me = bpy.data.meshes.new("ground")
    me.from_pydata([(-700, -700, 0), (700, -700, 0), (700, 700, 0), (-700, 700, 0)],
                   [], [(0, 1, 2, 3)])
    gm = bpy.data.materials.new("groundMat")
    gm.use_nodes = True
    gb = gm.node_tree.nodes["Principled BSDF"]
    gb.inputs["Base Color"].default_value = (0.86, 0.85, 0.82, 1.0)
    gb.inputs["Roughness"].default_value = 0.85
    me.materials.append(gm)
    ground = bpy.data.objects.new("ground", me)
    bpy.context.scene.collection.objects.link(ground)
    ground.location = (0.0, 0.0, -BODY_H / 2.0 - 3.0)


def shoot(name, loc, target, res, ortho_scale=None, lens=52.0):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new(name)
    cam_data.lens = lens
    if ortho_scale is not None:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = ortho_scale
    cam = bpy.data.objects.new(name, cam_data)
    scene.collection.objects.link(cam)
    cam.location = loc
    aim(cam, target)
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = os.path.join(PREVIEW_DIR, name + ".png")
    bpy.ops.render.render(write_still=True)
    log("render -> %s" % scene.render.filepath)


def render_previews():
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    shoot("front", (0.0, -600.0, 2.0), (0.0, 0.0, 2.0), (1440, 720),
          ortho_scale=216.0)
    shoot("three-quarter", (-235.0, -400.0, 175.0), (0.0, 0.0, -2.0), (1440, 900))


# ==========================================================================
# 导出
# ==========================================================================
def export_glb():
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        use_selection=False,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_extras=False,
        export_image_format="AUTO",
    )
    log("GLB -> %s (%d bytes)" % (OUT_GLB, os.path.getsize(OUT_GLB)))


# ==========================================================================
def main():
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)

    wipe_scene()

    # v4 材质分层：塑料 / 金属 / 玻璃 / 按键各有自己的反射性格，不能共用一个灰
    mats = {
        "shell": make_mat("shellMat", C_GROUND, 0.46, 0.0),      # 正面：哑光米白塑料
        "band": make_mat("bandMat", C_BAND, 0.54, 0.0),          # 侧边：略暖的米色厚边
        "outline": make_mat("outlineMat", C_OUTLINE, 0.42, 0.0), # 3–4px 深紫黑像素外轮廓
        "highlight": make_mat("highlightMat", "#fffdf5", 0.30, 0.0),
        "gold": make_mat("goldMat", C_GOLD, 0.22, 0.0),          # 金线：只剩屏内细线，金属度 0（无 IBL 不发黑）
        "key_edge": make_mat("keyEdgeMat", C_KEY_EDGE, 0.50, 0.0),  # P0：按键描边，浅灰哑光
        "glass": make_mat("screenMat", C_GLASS, 0.03, 0.15),     # 玻璃：镜面
        "bezel": make_mat("bezelMat", C_BEZEL, 0.44, 0.10),      # 屏框：哑光近黑（和键帽分开）
        "inner": make_mat("innerMat", C_INNER, 0.66, 0.05),
        "dark": make_mat("inkMat", C_INK, 0.55, 0.05),           # 副屏等死黑件：更哑
        "rim": make_mat("rimMat", C_INK, 0.52, 0.05),
        "key": make_mat("keyMat", "#191817", 0.32, 0.08),        # 键帽：缎面黑，高光锐
        "key_center": make_mat("keyCenterMat", "#10100f", 0.28, 0.10),
        "symbol": make_mat("symbolMat", "#f4efe3", 0.50, 0.0),
        "screw": make_mat("Screw", C_KEY_EDGE, 0.50, 0.0),       # P0：螺丝环改浅灰哑光
        "screw_dark": make_mat("screwDarkMat", "#211c18", 0.50, 0.0),  # P0：凹点去金属
    }

    # 清漆层：塑料有一层很薄的面漆高光，金属不要（否则像塑料）
    coat = {
        "glass": (1.00, 0.02),      # 玻璃：几乎全镜面
        "shell": (0.16, 0.30),
        "band": (0.20, 0.26),
        "key": (0.40, 0.08),        # 键帽：清漆高光最锐
        "key_center": (0.45, 0.06),
        "bezel": (0.08, 0.30),      # 屏框：几乎不上清漆 → 读哑光
    }
    for key, (weight, rough) in coat.items():
        bsdf = mats[key].node_tree.nodes["Principled BSDF"]
        for name, value in (("Coat Weight", weight), ("Coat Roughness", rough)):
            if name in bsdf.inputs:
                bsdf.inputs[name].default_value = value

    log("① 侧边带 / 二十边像素阶梯剪影")
    band = build_side_band(mats)
    shade_by_angle(band, 28.0)

    log("② 正面米白板 + 布尔挖孔")
    shell = build_shell(mats)
    shade_by_angle(shell, 26.0)

    log("③ 屏幕分层")
    bezel, screen_trim, glass = build_screen(mats)

    log("④ 金饰（屏框金线 / 下沿金线）")
    trim = build_trim(mats, screen_trim)

    log("⑤ 键井(空节点) / D-pad / 菱形键 / 方形键 / 螺丝")
    wells = build_key_wells()
    dpad = build_dpad(mats, shell)
    button_parts = [dpad]
    button_parts += build_right_keys(mats)
    button_parts += build_square_key("SquareKey_L", mats, SQ_L_CX, SQ_L_CZ)
    buttons = new_object("Buttons", [], [])
    join_into(buttons, button_parts)
    screws = build_screws(mats, shell)
    band_inset = build_band_inset(mats)
    parent_children(shell, wells + [buttons, screws] + band_inset)

    mesh_objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for ob in mesh_objs:
        activate(ob)
        bpy.ops.object.material_slot_remove_unused()

    log("⑥ UV 展开（全部件）+ AO 烘培（Shell）")
    for ob in mesh_objs:
        smart_uv(ob, angle=66.0, margin=0.02)
    planar_uv_front(glass, SCR_GLASS_W, SCR_GLASS_H, 0.0, SCREEN_CY)
    ao_img = bake_ao(shell, size=1024)
    for slot in shell.material_slots:
        if slot.material:
            hook_ao(slot.material, ao_img)

    log("⑦ 导出 GLB")
    export_glb()

    log("⑧ 保存 .blend")
    bpy.context.preferences.filepaths.save_version = 0   # 不要 .blend1 备份
    bpy.ops.wm.save_as_mainfile(filepath=BLEND_OUT)

    log("⑨ 预览渲染")
    if os.environ.get("CONSOLE_SKIP_PREVIEW") == "1":
        log("（CONSOLE_SKIP_PREVIEW=1，跳过预览渲染）")
    else:
        setup_preview_scene()
        render_previews()

    log("完成：%s" % OUT_GLB)
    log("节点：%s" % [o.name for o in bpy.context.scene.objects
                     if o.type == "MESH"])


if __name__ == "__main__":
    main()
