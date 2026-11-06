// 正面牌的造型：A 一个大花色、2–10 对称排点、J/Q/K 简化半身像、大小王王冠人像。
//
// 这里只说「正面牌长什么样」：不碰 DOM、不碰 three、不认调色板。
// 颜色、字形、点数的写法都由调用方传进来（见 app/machine.js 的 faceTexture）。
// 排点坐标是牌面归一化坐标（0..1），下半张的点由上半张绕牌心转 180° 得到，
// 所以「上下相对」是构造出来的，不是手画的。

export const FACE_W = 80, FACE_H = 114;
export const CORNER = 9;                 // 切角边长（与旧 52×74 版同比放大）

// 排点的三个列与五个行（列间距要容得下牌脚的大角标，所以比真牌略窄）
const PIP_COL = { L: 0.34, C: 0.50, R: 0.66 };
const PIP_ROW = { T: 0.16, UM: 0.38, M: 0.50, LM: 0.62, B: 0.84 };

const { L, C, R } = PIP_COL, { T, UM, M, LM, B } = PIP_ROW;

/** 这张正面牌属于哪一类造型。 */
export function faceKind(rank){
  if (rank === 'B' || rank === 'R') return 'joker';
  if (rank === 'A') return 'ace';
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 'court';
  return 'pip';
}

// 2–10 各自的排点。[列, 行]；没写出来的下半张点由上半张转 180° 补上
const LAYOUT = {
  2:  [[C, T], [C, B]],
  3:  [[C, T], [C, M], [C, B]],
  4:  [[L, T], [R, T], [L, B], [R, B]],
  5:  [[L, T], [R, T], [C, M], [L, B], [R, B]],
  6:  [[L, T], [R, T], [L, M], [R, M], [L, B], [R, B]],
  7:  [[L, T], [R, T], [L, M], [C, M], [R, M], [L, B], [R, B]],
  8:  [[L, T], [R, T], [L, UM], [R, UM], [L, LM], [R, LM], [L, B], [R, B]],
  9:  [[L, T], [R, T], [L, UM], [R, UM], [C, M], [L, LM], [R, LM], [L, B], [R, B]],
  T:  [[L, T], [R, T], [L, UM], [R, UM], [C, UM], [C, LM], [L, LM], [R, LM], [L, B], [R, B]],
};

/**
 * 某个点数的排点。扑克牌的规矩：下半张的点是上半张绕牌心转 180° 的副本，
 * 上下相对；落在牌心那一个自己就是自己的对点。A、J/Q/K、大小王不排点。
 * @returns {{x:number, y:number, flip:boolean}[]} 归一化坐标，flip 表示要转 180° 画
 */
export function pipLayout(rank){
  const rows = LAYOUT[rank];
  if (!rows) return [];
  return rows.map(([x, y]) => ({ x, y, flip: y > M }));
}

/* ---------- 画法：把上面那套坐标落到 2D 画布上 ---------- */

const PAPER = '#fbfaf6';          // 牌纸白（旧版就在用，不算新配色）
const PAD = '#201a26';                   // 切角外露的桌色
const PIP_FONT = 13;                     // 排点字号（墨迹 ≈ 13，列距 16 放得下，也不压住角标）
const ACE_FONT = 50;                     // A 的大花色
const IDX_FONT = [30, 16];               // 角标点数：单字 / 两字
const IDX_SUIT = 18;                     // 角标花色
const JOKER_IDX = 24;                    // 大小王的「小/大」比点数宽一倍，收窄才不压住王冠
const IDX_SUIT_Y = 30;

// 角标：点数在上、花色在下。坐标是牌面左上角的局部坐标，右下角把整套转 180° 复用。
function cornerIndex(g, label, glyph, color, size){
  g.fillStyle = color;
  g.textAlign = 'left'; g.textBaseline = 'top';
  g.font = `${size || (label.length > 1 ? IDX_FONT[1] : IDX_FONT[0])}px Pixel, monospace`;
  g.fillText(label, 3, 2);
  if (!glyph) return;
  g.font = `${IDX_SUIT}px Pixel, monospace`;
  g.fillText(glyph, 4, IDX_SUIT_Y);
}

function pips(g, rank, glyph, color){
  g.fillStyle = color;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `${PIP_FONT}px Pixel, monospace`;
  for (const p of pipLayout(rank)){
    g.save();
    g.translate(p.x * FACE_W, p.y * FACE_H);
    if (p.flip) g.rotate(Math.PI);
    g.fillText(glyph, 0, 0);
    g.restore();
  }
}

/* 人头牌：一块 44×74 的半身像画在牌心。
 * 三人共用「肩 + 脖子 + 头」的底子，靠头饰与饰品区分：
 *   J 尖帽 + 羽翎；Q 三尖冠 + 项链 + 披发；K 五尖冠 + 络腮胡。 */
const P = { x: 18, y: 20, w: 44, h: 74 };
const px = u => P.x + u * P.w;
const py = v => P.y + v * P.h;
const box = (g, u0, v0, u1, v1) => g.fillRect(px(u0), py(v0), (u1 - u0) * P.w, (v1 - v0) * P.h);
function poly(g, pts){
  g.beginPath();
  pts.forEach(([u, v], i) => i ? g.lineTo(px(u), py(v)) : g.moveTo(px(u), py(v)));
  g.closePath(); g.fill();
}
function bust(g, rank, color){
  g.fillStyle = color;
  poly(g, [[0.00, 1], [0.05, 0.68], [0.28, 0.57], [0.72, 0.57], [0.95, 0.68], [1.00, 1]]);  // 肩
  box(g, 0.40, 0.44, 0.60, 0.66);                                     // 脖子
  box(g, 0.30, 0.16, 0.70, 0.52);                                     // 头
  g.fillStyle = PAPER;                                                // 脸掏成牌纸色
  box(g, 0.35, 0.22, 0.65, 0.47);
  g.fillStyle = color;
  if (rank === 'J'){                       // 尖帽 + 朝右的羽翎
    poly(g, [[0.24, 0.19], [0.50, -0.02], [0.76, 0.19]]);
    box(g, 0.22, 0.17, 0.78, 0.23);
    g.fillRect(px(0.76), py(-0.04), 3, py(0.16) - py(-0.04));         // 翎
  } else if (rank === 'Q'){                // 三尖冠 + 披发 + 项链
    poly(g, [[0.26, 0.19], [0.26, 0.05], [0.38, 0.14], [0.50, 0.01], [0.62, 0.14], [0.74, 0.05], [0.74, 0.19]]);
    box(g, 0.25, 0.17, 0.75, 0.23);
    box(g, 0.22, 0.20, 0.30, 0.55); box(g, 0.70, 0.20, 0.78, 0.55);
    for (let i = 0; i < 5; i++) box(g, 0.32 + i * 0.09, 0.62, 0.37 + i * 0.09, 0.66);
  } else {                                 // K：五尖冠 + 络腮胡
    poly(g, [[0.20, 0.19], [0.20, 0.02], [0.32, 0.12], [0.50, -0.01], [0.68, 0.12], [0.80, 0.02], [0.80, 0.19]]);
    box(g, 0.19, 0.17, 0.81, 0.23);
    box(g, 0.26, 0.10, 0.32, 0.18); box(g, 0.47, 0.07, 0.53, 0.17); box(g, 0.68, 0.10, 0.74, 0.18);
    poly(g, [[0.34, 0.44], [0.66, 0.44], [0.60, 0.62], [0.50, 0.68], [0.40, 0.62]]);
  }
}

/* 大小王：王冠 + 人像剪影，右侧竖排 JOKER。 */
function joker(g, rank, color){
  g.save();
  g.translate(3, 6);                    // 让开左上角的「小 / 大」，右手边留给竖排 JOKER
  g.fillStyle = color;
  poly(g, [[0.05, 0.72], [0.22, 0.55], [0.78, 0.55], [0.95, 0.72], [0.95, 1], [0.05, 1]]);   // 肩
  g.fillRect(px(0.42), py(0.44), P.w * 0.16, P.h * 0.12);                                     // 脖子
  g.fillRect(px(0.30), py(0.18), P.w * 0.40, P.h * 0.28);                                     // 头
  g.fillStyle = PAPER; box(g, 0.35, 0.23, 0.65, 0.41); g.fillStyle = color;
  poly(g, [[0.22, 0.20], [0.22, 0.02], [0.34, 0.13], [0.50, -0.02], [0.66, 0.13], [0.78, 0.02], [0.78, 0.20]]);
  g.fillRect(px(0.20), py(0.17), P.w * 0.60, P.h * 0.06);                                     // 冠箍
  g.fillRect(px(0.30), py(0.55), 3, P.h * 0.06); g.fillRect(px(0.68), py(0.55), 3, P.h * 0.06); // 衣领
  g.restore();
  g.save();                                                                                    // 竖排 JOKER
  g.translate(FACE_W - 15, FACE_H - 8);
  g.rotate(-Math.PI / 2);
  g.fillStyle = color;                  // 上一段 restore 把 fillStyle 还原成牌纸色，这里必须重设，否则白字画在白纸上
  g.textAlign = 'left'; g.textBaseline = 'top';
  g.font = '13px Pixel, monospace';
  g.fillText('JOKER', 0, 0);
  g.restore();
}

/**
 * 把一张正面牌画进 2D 画布（逻辑尺寸 FACE_W×FACE_H，调用方自己按倍数放大）。
 * @param color 这张牌的主色：红桃方片给强调色，其余给墨色
 * @param accent 强调色（只在角上两颗小方点是它自己，和主色无关）
 */
export function drawFace(g, { rank, glyph, label, color, accent }){
  // 切角贴纸 + 硬描边
  g.fillStyle = PAD; g.fillRect(0, 0, FACE_W, FACE_H);
  g.fillStyle = PAPER;
  g.beginPath();
  g.moveTo(0, CORNER); g.lineTo(CORNER, 0); g.lineTo(FACE_W - CORNER, 0); g.lineTo(FACE_W, CORNER);
  g.lineTo(FACE_W, FACE_H - CORNER); g.lineTo(FACE_W - CORNER, FACE_H);
  g.lineTo(CORNER, FACE_H); g.lineTo(0, FACE_H - CORNER);
  g.closePath(); g.fill();
  g.strokeStyle = color; g.lineWidth = 3; g.stroke();

  const kind = faceKind(rank);
  if (kind === 'pip') pips(g, rank, glyph, color);
  else if (kind === 'ace'){
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `${ACE_FONT}px Pixel, monospace`;
    g.fillText(glyph, FACE_W / 2, FACE_H / 2 + 2);
  }
  else if (kind === 'court') bust(g, rank, color);
  else joker(g, rank, color);

  cornerIndex(g, label, glyph, color, kind === 'joker' ? JOKER_IDX : 0);
  if (kind !== 'joker'){                  // 右下角同款角标，整块转 180°
    g.save();
    g.translate(FACE_W - 3, FACE_H - 2);
    g.rotate(Math.PI);
    cornerIndex(g, label, glyph, color);
    g.restore();
  }
  g.fillStyle = accent;                   // 角上两颗小方点：旧版的质感锚点
  g.fillRect(FACE_W - 7, 6, 4, 4);
  g.fillRect(3, FACE_H - 10, 4, 4);
}
