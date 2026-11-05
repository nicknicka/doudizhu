// 正面牌造型的单测。排点与分类测纯函数；绘制层拿假 context 记录每笔的用色与字形，不依赖真 canvas。
import test from 'node:test';
import assert from 'node:assert/strict';

import { drawFace, faceKind, pipLayout, FACE_W, FACE_H, CORNER } from '../app/card-face.js';

// 排点只对 2–10 有意义；10 在数据里叫 T
const PIP_RANKS = ['2','3','4','5','6','7','8','9','T'];
const COUNT = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, T: 10 };

test('2–10 各自的点数与标准扑克牌一样（10 是十个点）', () => {
  for (const rank of PIP_RANKS) {
    assert.equal(pipLayout(rank).length, COUNT[rank], `${rank} 的排点数量不对`);
  }
});

test('每个点都有它绕牌心转 180° 的对点，上下相对', () => {
  for (const rank of PIP_RANKS) {
    const pips = pipLayout(rank);
    for (const p of pips) {
      const mate = pips.find(q =>
        Math.abs(q.x - (1 - p.x)) < 1e-9 && Math.abs(q.y - (1 - p.y)) < 1e-9);
      assert.ok(mate, `${rank} 的 (${p.x}, ${p.y}) 找不到 180° 对点`);
    }
  }
});

test('排点坐标都落在牌面里，同一张牌上不重叠', () => {
  for (const rank of PIP_RANKS) {
    const pips = pipLayout(rank);
    for (const { x, y } of pips) {
      assert.ok(x > 0 && x < 1, `${rank} 的 x=${x} 跑到牌面外`);
      assert.ok(y > 0 && y < 1, `${rank} 的 y=${y} 跑到牌面外`);
    }
    const seen = new Set(pips.map(({ x, y }) => `${x},${y}`));
    assert.equal(seen.size, pips.length, `${rank} 有排点叠在一起`);
  }
});

test('下半张的点靠绕牌心转 180° 得到，牌心那一个自己就是自己的对点', () => {
  for (const rank of PIP_RANKS) {
    for (const p of pipLayout(rank)){
      assert.equal(p.flip, p.y > 0.5, `${rank} 的 (${p.x}, ${p.y}) flip 标错了`);
    }
  }
  // 3/5/7/9 正中间那一个
  for (const rank of ['3', '5', '7', '9']){
    assert.ok(pipLayout(rank).some(p => p.x === 0.5 && p.y === 0.5), `${rank} 缺牌心的点`);
  }
});

test('按点数分造型：A 独家、J/Q/K 人头、大小王、其余排点', () => {
  assert.equal(faceKind('A'), 'ace');
  for (const rank of ['J', 'Q', 'K']) assert.equal(faceKind(rank), 'court');
  for (const rank of ['B', 'R']) assert.equal(faceKind(rank), 'joker');
  for (const rank of PIP_RANKS) assert.equal(faceKind(rank), 'pip');
});

test('A、J/Q/K、大小王不排点', () => {
  for (const rank of ['A', 'J', 'Q', 'K', 'B', 'R']){
    assert.deepEqual(pipLayout(rank), [], `${rank} 不该有排点`);
  }
});

test('牌面几何：宽高比照着真牌（宽:高 ≈ 0.7），切角不越界', () => {
  assert.ok(Math.abs(FACE_W / FACE_H - 0.7) < 0.02, '宽高比偏离真牌太多');
  assert.ok(CORNER > 0 && CORNER * 2 < Math.min(FACE_W, FACE_H), '切角把牌吃没了');
});

/* ---------- 绘制层：假 context 记下 fillRect/fillText/… 调用时生效的颜色与字号 ---------- */

const INK = '#141310', ACCENT = '#e0442a', PAPER = '#fbfaf6', PAD = '#201a26';
const ALL_RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A','B','R'];

// save/restore 按真 canvas 的栈语义还原状态 —— 白字画在白纸上的那个 bug 就藏在这条语义里。
function spy(){
  const ctx = { fillStyle: null, strokeStyle: null, lineWidth: 1, font: '', textAlign: '', textBaseline: '', calls: [] };
  const stack = [];
  const snap = () => ({ fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth,
                        font: ctx.font, textAlign: ctx.textAlign, textBaseline: ctx.textBaseline });
  for (const op of ['fillRect','fillText','beginPath','moveTo','lineTo','closePath','fill','stroke','translate','rotate'])
    ctx[op] = (...args) => ctx.calls.push({ op, args, fillStyle: ctx.fillStyle, strokeStyle: ctx.strokeStyle, font: ctx.font });
  ctx.save = () => stack.push(snap());
  ctx.restore = () => Object.assign(ctx, stack.pop());
  // 牌面是平涂：真去调渐变或图案就直接炸，不让测试悄悄放过
  ctx.createLinearGradient = ctx.createRadialGradient = ctx.createPattern = () => {
    throw new Error('牌面不该用渐变或图案');
  };
  return ctx;
}

const draw = (rank, color, extra = {}) => {
  const ctx = spy();
  drawFace(ctx, { rank, glyph: '♠', label: rank, color, accent: ACCENT, ...extra });
  return ctx;
};
const glyphs = (ctx, ch) => ctx.calls.filter(c => c.op === 'fillText' && c.args[0] === ch);
const px = c => Number(/(\d+)px/.exec(c.font)[1]);

test('每种点数都画得出来，而且只用平涂', () => {
  for (const rank of ALL_RANKS){
    const ctx = spy();                       // 一旦碰渐变/图案就会抛
    assert.doesNotThrow(() => drawFace(ctx, { rank, glyph: '♠', label: rank, color: INK, accent: ACCENT }),
      `${rank} 画不出来`);
  }
});

test('大小王写上 JOKER，那一笔是牌面主色 —— 不能被 save/restore 还原成纸色', () => {
  for (const [rank, color] of [['B', INK], ['R', ACCENT]]){
    const strokes = glyphs(draw(rank, color, { glyph: undefined }), 'JOKER');
    assert.equal(strokes.length, 1, `${rank} 应该写一次 JOKER`);
    assert.equal(strokes[0].fillStyle, color, `${rank} 的 JOKER 必须用主色，不能是牌纸色`);
  }
});

test('红色牌只用强调色、黑色牌只用墨色，不新增调色板颜色', () => {
  const cases = [['7', '♠', INK], ['7', '♥', ACCENT], ['A', '♦', ACCENT], ['K', '♣', INK],
                 ['B', undefined, INK], ['R', undefined, ACCENT]];
  for (const [rank, glyph, color] of cases){
    const allowed = new Set([PAD, PAPER, color, ACCENT]);
    for (const c of draw(rank, color, { glyph }).calls){
      if (c.fillStyle) assert.ok(allowed.has(c.fillStyle), `${rank} 用了调色板外的填充色 ${c.fillStyle}`);
      if (c.strokeStyle) assert.ok(allowed.has(c.strokeStyle), `${rank} 用了调色板外的描边色 ${c.strokeStyle}`);
    }
  }
});

test('J/Q/K 三张半身像的图元各不相同，轮廓与饰品可区分', () => {
  const shape = rank => JSON.stringify(draw(rank, INK).calls
    .filter(c => c.op === 'fillRect' || c.op === 'fill').map(c => [c.op, ...c.args]));
  const [j, q, k] = ['J', 'Q', 'K'].map(shape);
  assert.notEqual(j, q, 'J 和 Q 画得一样');
  assert.notEqual(q, k, 'Q 和 K 画得一样');
  assert.notEqual(j, k, 'J 和 K 画得一样');
});

test('A 在牌心画一个大花色，左上右下角标各一个小花色', () => {
  const hearts = glyphs(draw('A', ACCENT, { glyph: '♥' }), '♥');
  assert.equal(hearts.length, 3, 'A = 牌心 1 个 + 两个角标');
  assert.ok(px(hearts[0]) >= 40, '牌心那个花色要明显比角标大');
});
