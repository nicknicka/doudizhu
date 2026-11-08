// 座位上那三个「扑克牌拟人」角色：只画站姿，不碰 DOM、不碰 three、不认调色板。
//
// 和 card-face.js 一样，这里只说「角色长什么样」：颜色由调用方传进来
// （见 app/machine.js 的 characterTexture）。造型沿用牌面的那套画法 ——
// 整数像素矩形 + 平涂限色，没有渐变、没有抗锯齿，缩放到屏幕上仍是硬边。
//
// 身份不用读字：地主戴三尖王冠，农民戴斗笠。底色区分「谁」，
// 胸前的花色跟着座位走（上家 ♠ / 我 ♥ / 下家 ♦）。

export const CHAR_W = 44, CHAR_H = 60;

// 逻辑画布上的一次填充：坐标都取整，保证放大后还是整块像素。
const rect = (g, x, y, w, h, color) => { g.fillStyle = color; g.fillRect(x, y, w, h); };

/** 三尖王冠：地主。 */
function crown(g, c){
  // 先铺一层墨色再压金：不用描边，外轮廓自然多出一像素黑边
  g.fillStyle = c.ink;
  for (const [x, y, w, h] of [[11, 1, 5, 8], [19, 0, 6, 9], [28, 1, 5, 8], [11, 5, 22, 4]]) {
    g.fillRect(x - 1, y - 1, w + 2, h + 2);
  }
  for (const [x, y, w, h] of [[12, 2, 3, 6], [20, 1, 4, 7], [29, 2, 3, 6], [12, 6, 20, 2]]) {
    rect(g, x, y, w, h, c.gold);
  }
}

/** 斗笠：农民。宽檐 + 圆顶，一眼和细高的王冠分开。 */
function strawHat(g, c){
  // 阶梯三角 = 圆锥斗笠；先铺一遍墨色当轮廓，再把草色往里收一像素
  const cone = [[20, 1, 4], [18, 3, 8], [16, 5, 12]];
  g.fillStyle = c.ink;
  for (const [x, y, w] of cone) g.fillRect(x - 1, y - 1, w + 2, 3);
  g.fillRect(9, 5, 26, 5);
  g.fillStyle = c.hat;
  for (const [x, y, w] of cone) g.fillRect(x, y, w, 2);
  g.fillRect(10, 6, 24, 3);
  g.fillStyle = c.hatBand;
  g.fillRect(10, 8, 24, 1);             // 檐口那圈草绳
}

function head(g, c, tone){
  rect(g, 15, 9, 14, 13, tone);            // 头
  rect(g, 17, 12, 10, 8, c.paper);         // 脸掏成牌纸色
  rect(g, 19, 14, 2, 2, c.ink);            // 眼
  rect(g, 24, 14, 2, 2, c.ink);
  rect(g, 21, 17, 3, 1, c.ink);            // 嘴
  rect(g, 20, 21, 5, 3, tone);             // 脖子
}

/** 牌身：切角矩形 + 硬描边，胸前一个花色。 */
function body(g, c, tone, glyph){
  const x0 = 11, x1 = 33, y0 = 23, y1 = 50, k = 3;
  g.fillStyle = tone;
  g.beginPath();
  g.moveTo(x0, y0 + k); g.lineTo(x0 + k, y0); g.lineTo(x1 - k, y0); g.lineTo(x1, y0 + k);
  g.lineTo(x1, y1 - k); g.lineTo(x1 - k, y1); g.lineTo(x0 + k, y1); g.lineTo(x0, y1 - k);
  g.closePath(); g.fill();
  rect(g, x0 + 2, y0 + 2, x1 - x0 - 4, y1 - y0 - 4, c.paper);
  g.fillStyle = tone; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '15px Pixel, monospace';
  g.fillText(glyph, (x0 + x1) / 2, (y0 + y1) / 2 + 1);
  rect(g, 5, 29, 8, 4, tone);              // 手臂（左右各一）
  rect(g, 31, 29, 8, 4, tone);
  rect(g, 3, 30, 4, 4, c.paper);           // 手
  rect(g, 37, 30, 4, 4, c.paper);
}

function legs(g, c){
  rect(g, 16, 30, 3, 28, c.ink);           // 腿（从牌身背后伸出来）
  rect(g, 25, 30, 3, 28, c.ink);
  rect(g, 13, 55, 8, 4, c.ink);            // 鞋
  rect(g, 23, 55, 8, 4, c.ink);
}

/**
 * 把一个角色画进 2D 画布（逻辑尺寸 CHAR_W×CHAR_H，调用方自己按倍数放大）。
 * @param seat 'up' | 'me' | 'down' —— 决定底色与胸前花色
 * @param identity 'landlord' | 'peasant' —— 决定头顶戴什么
 * @param palette 颜色全部由调用方给：{ ink, paper, gold, hat, hatBand, tone }
 */
export function drawCharacter(g, { seat, identity, palette }){
  const c = palette;
  const tone = c.tone;
  legs(g, c);
  body(g, c, tone, { up: '♠', me: '♥', down: '♦' }[seat] || '♠');
  head(g, c, tone);
  if (identity === 'landlord') crown(g, c);
  else strawHat(g, c);
}
