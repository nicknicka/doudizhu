"""像素风掌机 —— **代码路线 A**（build123d / cadgen）。

形状基准：docs/refs/console-3view/ 的三视图。
尺寸基准：web/app/scene.js 顶部常量（1 three.js 单位 = 20 mm），改一处两边一起对。

重建：  cadgen run   tools/console-code/build_console.py
预览：  cadgen snapshot <id> /tmp/a.png
导出：  cadgen export  <id> web/assets/console-a.glb
"""
import build123d as bd
from cadgen import model

MM = 20.0

# —— 与 scene.js 常量一一对应（单位：mm）——
BODY_W, BODY_H, BODY_D = 10.0 * MM, 4.20 * MM, 0.95 * MM
CHAMFER = 0.78 * MM                      # 轮廓切角
SCREEN_W, SCREEN_H, SCREEN_CY = 5.20 * MM, 2.72 * MM, -0.24 * MM
BAND_H = 0.68 * MM                       # 机顶记牌槽
BAND_TOP = (4.20 / 2 - 0.14) * MM
BAND_X0, BAND_X1 = -2.92 * MM, 4.30 * MM
CTRL_X, CTRL_W = 3.90 * MM, 2.05 * MM    # 左右控制区
CTRL_CY, CTRL_H = -0.18 * MM, 3.10 * MM

BEZEL_BAR = 5.5          # 屏框条宽
PLASTIC_R = 2.6          # 正面边缘的塑料倒角
BAND_DEPTH = 2.2         # 记牌槽下沉
WELL_DEPTH = 1.6         # 按键井下沉

# —— Z 层次（关键：屏框要嵌进正面，不能凸出来）——
SHELL_FRONT = 12.0       # 正面板的外表面
POCKET_D = 6.0           # 屏幕凹槽深度
BEZEL_T = 5.0            # 屏框厚度 → 前表面 12.5，只在正面之外 0.5
SCREEN_T = 1.2
TRIM_T = 1.6

COL_SHELL, COL_SIDEBAND = "#f2ecdd", "#dcd2bc"
COL_BEZEL, COL_TRIM, COL_SCREEN = "#15141a", "#c9994f", "#0e1a24"


def octa(w, h, ch):
    """切角矩形（八角轮廓）—— 对应 scene.js 的 octaShape。"""
    c = max(0.5, min(ch, w / 2 - 0.5, h / 2 - 0.5))
    pts = [(-w / 2 + c, -h / 2), (w / 2 - c, -h / 2), (w / 2, -h / 2 + c),
           (w / 2, h / 2 - c), (w / 2 - c, h / 2), (-w / 2 + c, h / 2),
           (-w / 2, h / 2 - c), (-w / 2, -h / 2 + c)]
    return bd.Polygon(*pts, align=None)


def prism(w, h, ch, d, z):
    """八角柱：底面在 z-depth/2，顶面在 z+depth/2（z 是中心）。"""
    return bd.extrude(octa(w, h, ch), amount=d).moved(bd.Location((0, 0, z - d / 2)))


def block(w, h, d, x, y, z):
    """轴对齐方块，中心在 (x, y, z)。"""
    return bd.Box(w, h, d).moved(bd.Location((x, y, z)))


def safe_fillet(shape, edges, radius, fallback=None):
    """OCCT 的倒角经常因为半径过大直接失败 —— 试几个半径，全失败就原样返回。"""
    for r in (radius, radius * 0.6, radius * 0.35, radius * 0.18):
        try:
            out = bd.fillet(edges, radius=r)
            if out.is_valid:
                return out
        except Exception:
            continue
    return fallback if fallback is not None else shape


def side_band():
    """侧边带：完整轮廓、比正面暗一档。
    只占**后半**厚度 —— 正面那一层留给 shell，不然侧边带的正面会把屏幕盖住。"""
    z0, z1 = -BODY_D / 2, 4.0
    b = prism(BODY_W, BODY_H, CHAMFER, z1 - z0, (z0 + z1) / 2)
    b = safe_fillet(b, b.edges().filter_by(bd.Axis.Z), 1.4, fallback=b)
    b.label, b.color = "SideBand", COL_SIDEBAND
    return b


def shell():
    """正面板：切角轮廓 + 屏幕凹槽 + 记牌槽 + 按键井 + 扬声器孔 + 螺丝凹点。"""
    z0 = -2.0
    s = prism(BODY_W - 4.0, BODY_H - 4.0, CHAMFER * 0.92, SHELL_FRONT - z0, (SHELL_FRONT + z0) / 2)

    # 屏幕上方的凹槽（只到 POCKET_D 深，底下留给玻璃）
    s = s - block(SCREEN_W + 2 * BEZEL_BAR, SCREEN_H + 2 * BEZEL_BAR, POCKET_D,
                  0, SCREEN_CY, SHELL_FRONT - POCKET_D / 2 + 0.6)
    # 机顶记牌槽
    s = s - block((BAND_X1 - BAND_X0), BAND_H, BAND_DEPTH * 2,
                  (BAND_X0 + BAND_X1) / 2, BAND_TOP - BAND_H / 2, SHELL_FRONT + 0.6)
    # 左右按键井
    for sx in (-1, 1):
        s = s - block(CTRL_W, CTRL_H, WELL_DEPTH * 2,
                      sx * CTRL_X, CTRL_CY, SHELL_FRONT + 0.6)
    # 扬声器孔阵（真孔）
    for r in range(6):
        for c in range(5):
            x = -4.18 * MM + c * 0.185 * MM
            y = BAND_TOP - 0.10 * MM - r * 0.150 * MM
            # 孔轴沿 +Z 扎进正面（默认轴就是 Z，不要再转）
            s = s - bd.Cylinder(0.038 * MM * 1.7, 5.0).moved(
                bd.Location((x, y, SHELL_FRONT + 0.2)))
    # 螺丝凹点
    for sx, sy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        s = s - bd.Cylinder(0.095 * MM, 2.6).moved(
            bd.Location((sx * 4.30 * MM, sy * (BODY_H / 2 - 0.95 * MM), SHELL_FRONT + 0.1)))

    # 正面最外圈做塑料倒角
    front_edges = list(s.faces().sort_by(bd.Axis.Z)[-1].edges())
    s = safe_fillet(s, front_edges, PLASTIC_R, fallback=s)
    s.label, s.color = "Shell", COL_SHELL
    return s


def bezel():
    """屏框：坐在凹槽里，前表面只比正面高 0.5 —— 玻璃于是显得凹。"""
    zc = SHELL_FRONT - POCKET_D + BEZEL_T / 2 + 0.5
    outer = block(SCREEN_W + 2 * BEZEL_BAR, SCREEN_H + 2 * BEZEL_BAR, BEZEL_T,
                  0, SCREEN_CY, zc)
    inner = block(SCREEN_W, SCREEN_H, BEZEL_T * 3, 0, SCREEN_CY, zc)
    b = outer - inner
    b = bd.chamfer(b.faces().sort_by(bd.Axis.Z)[-1].edges(), length=1.0)
    b.label, b.color = "Bezel", COL_BEZEL
    return b


def screen():
    """屏幕玻璃面：运行时把它的材质换成 RenderTarget 贴图。"""
    zc = SHELL_FRONT - POCKET_D + SCREEN_T / 2 + 1.6
    g = block(SCREEN_W + 1.2, SCREEN_H + 1.2, SCREEN_T, 0, SCREEN_CY, zc)
    g.label, g.color = "Screen", COL_SCREEN
    return g


def trim():
    """金线：屏框内圈一条细边，压在玻璃边上。"""
    zc = SHELL_FRONT + 0.7
    outer = block(SCREEN_W + 2.4, SCREEN_H + 2.4, TRIM_T, 0, SCREEN_CY, zc)
    inner = block(SCREEN_W + 0.6, SCREEN_H + 0.6, TRIM_T * 3, 0, SCREEN_CY, zc)
    t = outer - inner
    t.label, t.color = "Trim", COL_TRIM
    return t


@model
def console():
    parts = [side_band(), shell(), screen(), bezel(), trim()]
    assembly = bd.Compound(children=parts, label="console")
    return assembly


if __name__ == "__main__":
    console()
