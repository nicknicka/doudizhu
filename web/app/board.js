// 牌桌的**平面**部分：座位标签（按 3D 投影定位）、机顶条、计分板、透明键热区。
// 三维形状和真屏在 machine.js 里；要读的数字留在这一层。

import { S, $ } from './state.js';
import { RANKS, NAME, label, identityLabel, isMe } from './labels.js';
import * as machine from './machine.js';

let labels = {};
let labelsKey = '';

function ensureLabels(){
  const key = Object.keys(S.meta.seats).join(',');
  if (key === labelsKey) return;
  labelsKey = key;
  labels = {};
  const box = $('screen-hud');
  box.querySelectorAll('.seat-label').forEach(el => el.remove());
  for (const player of Object.keys(S.meta.seats)){
    const el = document.createElement('div');
    el.className = 'seat-label';
    el.dataset.seat = S.meta.seats[player].relative;
    box.appendChild(el);
    labels[player] = el;
  }
}

function paintLabels(){
  const v = S.snap;
  for (const [player, el] of Object.entries(labels)){
    const seat = S.meta.seats[player];
    const mine = isMe(player);
    const acting = !v.finished && v.acting === player;
    const played = v.played[player] || [];
    el.className = `seat-label${mine ? ' is-me' : ''}${acting ? ' is-acting' : ''}`;
    el.innerHTML =
      `<span class="who"><b>${label(player)}</b>`
      + `<span class="badge ${seat.identity}">${identityLabel(player)}</span>`
      + (acting ? `<span class="turn-flag">▶ ${mine ? '该你出' : '该他出'}</span>` : '')
      + `<span class="cnt"><span class="n">${v.remaining[player]}</span><span class="u"> 张</span></span></span>`
      + `<span class="played">已出：${played.length ? played.map(x => NAME[x] || x).join(' ') : '—'}</span>`;
  }
}

/**
 * 机下那条 2D 座位状态行：420px 下屏内贴图字已经糊了，「谁是谁、还剩几张」得在 2D 层读得到。
 * 内容和屏内那份同源（S.meta.seats + S.snap.remaining），不另算一遍。
 */
function renderSeatstrip(){
  const el = $('seatstrip');
  if (!el || !S.meta || !S.snap) return;
  const v = S.snap;
  const order = { up: 0, me: 1, down: 2 };          // 按相对位置排：上家 / 我 / 下家
  const players = Object.keys(S.meta.seats).sort((a, b) =>
    (order[S.meta.seats[a].relative] ?? 9) - (order[S.meta.seats[b].relative] ?? 9));
  el.innerHTML = players.map(player => {
    const seat = S.meta.seats[player];
    const acting = !v.finished && v.acting === player;
    return `<span class="sc${isMe(player) ? ' is-me' : ''}${acting ? ' is-acting' : ''}">`
      + `<b>${label(player)}</b><span class="badge ${seat.identity}">${identityLabel(player)}</span>`
      + `<span class="cnt">${v.remaining[player]}</span></span>`;
  }).join('');
}

/** 副屏要显示什么：DOM 锚点和 3D 贴图共用这一份数据，两边不各算一次。 */
function counterModel(){
  if (S.barMode === 'prob'){
    const point = S.point;
    if (!point){
      return { mode: 'prob', empty: S.snap.finished ? '本局已结束' : '当前不是你的出牌机会',
               title: '', rows: [] };
    }
    return { mode: 'prob', empty: '',
             title: `${label(point.actor)} · 模型动作选择概率`,
             rows: (point.predictions || []).slice(0, 3) };
  }
  const pool = S.snap.pool_counts || {};
  return { mode: 'count', empty: '', title: '', rows: [],
           cells: RANKS.map(r => ({
             rank: r, text: NAME[r], n: pool[r] || 0,
             // 小王/大王挤不进一格要缩字号；『10』不缩，但它下面的红点按两个字排
             labelLong: NAME[r].length > 1 && !/^[0-9]+$/.test(NAME[r]),
             dotsLong: NAME[r].length > 1,
           })) };
}

const cssVar = name =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const PIX = px => `${Math.round(px)}px Pixel, monospace`;

/** 把同一份数据画进 3D 副屏的纹理。 */
function paintCounter(){
  const c = machine.subDisplayCanvas();
  if (!c) return;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const ink = cssVar('--ink') || '#201a26';
  const ground = cssVar('--ground') || '#efe7d8';
  const muted = cssVar('--muted') || '#6b6357';
  const accent = cssVar('--accent') || '#e0442a';
  const m = counterModel();

  g.clearRect(0, 0, W, H);
  g.fillStyle = ground;
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle';

  if (m.mode === 'prob'){
    if (m.empty){
      g.fillStyle = muted; g.font = PIX(H * 0.30); g.textAlign = 'center';
      g.fillText(m.empty, W / 2, H / 2);
      machine.commitSubDisplay();
      return;
    }
    g.fillStyle = muted; g.font = PIX(H * 0.19); g.textAlign = 'center';
    g.fillText(m.title, W / 2, H * 0.19);
    const n = Math.max(1, m.rows.length), cw = W / n;
    m.rows.forEach((a, i) => {
      const cx = cw * (i + 0.5);
      if (i){
        g.globalAlpha = 0.22; g.fillStyle = ink;
        g.fillRect(Math.round(cw * i), H * 0.08, Math.max(2, H * 0.02), H * 0.84);
        g.globalAlpha = 1;
      }
      g.fillStyle = ink; g.font = PIX(H * 0.29); g.textAlign = 'center';
      g.fillText(a.label, cx, H * 0.55);
      const pct = `${Math.round(a.probability * 100)}%`;
      g.font = PIX(H * 0.21);
      const tw = g.measureText(a.type).width, pw = g.measureText(pct).width, gap = H * 0.09;
      let x = cx - (tw + gap + pw) / 2;
      g.textAlign = 'left';
      g.fillStyle = muted; g.fillText(a.type, x, H * 0.81);
      x += tw + gap;
      g.fillStyle = ink; g.fillText(pct, x, H * 0.81);
      g.textAlign = 'center';
    });
    machine.commitSubDisplay();
    return;
  }

  const cells = m.cells, cw = W / cells.length;
  g.textAlign = 'center';
  cells.forEach((cell, i) => {
    const cx = cw * (i + 0.5);
    if (i){
      g.globalAlpha = 0.18; g.fillStyle = ink;
      g.fillRect(Math.round(cw * i), H * 0.08, Math.max(2, H * 0.02), H * 0.84);
      g.globalAlpha = 1;
    }
    // 出完的格子整体变灰，和 DOM 版保持一致
    g.fillStyle = cell.n ? ink : muted;
    g.font = PIX(H * (cell.labelLong ? 0.40 : 0.56));
    g.fillText(cell.text, cx, H * 0.40);
    if (!cell.n) return;
    const dots = Math.min(4, cell.n);
    const ds = H * 0.09, gapDot = cell.dotsLong ? H * 0.13 : H * 0.05;
    let dx = cx - (dots * ds + (dots - 1) * gapDot) / 2;
    g.fillStyle = accent;
    for (let k = 0; k < dots; k++){ g.fillRect(dx, H * 0.79, ds, ds); dx += ds + gapDot; }
  });
  machine.commitSubDisplay();
}

/* ---------- 主屏 HUD：座位圆点画进真屏纹理 ---------- */
// 槽位就是 template.html 里 .seat-label 的百分比定位：上家左上、下家右上、我方下缘居中。
const HUD_SLOTS = {
  up:   { x: 0.05, y: 0.07, sx:  1, sy:  1 },
  down: { x: 0.95, y: 0.07, sx: -1, sy:  1 },
  me:   { x: 0.50, y: 0.98, sx:  0, sy: -1 },
};

/**
 * 把三个座位张数圆点画进主屏纹理。DOM 那层退成锚点：机身一转，圆点跟着屏一起转、
 * 被凸边框挡住、翻到背面就看不见；盖在画布上的 HTML 永远压在最上层，做不到这一点。
 */
function paintScreenHud(){
  const c = machine.mainHudCanvas();
  if (!c) return;
  const v = S.snap;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  const ink = cssVar('--ink') || '#201a26';
  const ground = cssVar('--ground') || '#efe7d8';
  const accent = cssVar('--accent') || '#e0442a';
  const muted = cssVar('--muted') || '#6b6357';
  g.clearRect(0, 0, W, H);
  // 圆点大小照 DOM 那颗 28px 圆点折算：CSS 一改，纹理跟着走，不各写一个常量。
  const box = $('screen-hud').getBoundingClientRect();
  const domDot = Object.values(labels)[0]?.getBoundingClientRect().width || 0;
  const r = box.width > 0 && domDot > 0 ? (domDot / 2) * (W / box.width) : W * 0.02;
  const edge = Math.max(2, r * 0.16);
  // 窄屏手牌排成两排时，屏的下缘已经被牌面占满，再落一颗「我」的圆章必然压住牌；
  // 我的张数在计分板和机顶条里都有，这里直接把槽位让出来。行数取排牌那一份数据，
  // 不再按宽度猜一次，省得两边规则各自漂移。
  const meDotHidden = (machine.machineStatus().handRows || []).length > 1;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const [player, el] of Object.entries(labels)){
    if (!el || el.style.display === 'none') continue;      // board.place 会把缺席的座位藏掉
    const seat = S.meta.seats[player];
    const slot = HUD_SLOTS[seat.relative] || HUD_SLOTS.up;
    if (meDotHidden && slot === HUD_SLOTS.me) continue;
    const cx = slot.x * W + slot.sx * r, cy = slot.y * H + slot.sy * r;
    if (!v.finished && v.acting === player){               // DOM 版用脉冲，纹理里用一圈静态光环
      g.beginPath(); g.arc(cx, cy, r + edge, 0, Math.PI * 2);
      g.lineWidth = edge * 1.2; g.strokeStyle = accent; g.stroke();
    }
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = isMe(player) ? accent : ink; g.fill();
    g.beginPath(); g.arc(cx, cy, r - edge / 2, 0, Math.PI * 2);
    g.lineWidth = edge; g.strokeStyle = ground; g.stroke();   // 底色描边（CSS 的 border 也在盒内）
    g.fillStyle = ground;
    g.font = `600 ${Math.round(r * 0.79)}px Pixel, monospace`;
    g.fillText(String(v.remaining[player]), cx, cy);
    // 座位名与身份钉在圆点外侧：不悬停也知道"谁是谁"（#49 评估第 2 条）。
    // 它落在牌桌皮与牌面上，背景颜色不可控，所以先垫一块底色板再写字；
    // 不垫的话墨色字压到深桌皮上就糊了。字号照圆点折算，不另写常量。
    const who = label(player), ident = identityLabel(player);
    const fs = Math.round(r * 0.72);
    g.font = `600 ${fs}px Pixel, monospace`;
    const wW = g.measureText(who).width, wI = g.measureText(ident).width;
    const pad = Math.round(r * 0.24), gap = Math.round(r * 0.3);
    const bw = wW + gap + wI + pad * 2, bh = fs + pad * 2;
    // 圆点在右半屏就往右排字，否则往左排 —— 字永远落在圆点外侧，不压回屏心。
    const bx = slot.sx > 0 ? cx + r + 8 : cx - r - 8 - bw;
    const by = Math.min(Math.max(cy - bh / 2, 2), H - bh - 2);   // 别被屏沿切掉
    g.fillStyle = ground; g.fillRect(bx, by, bw, bh);
    g.lineWidth = Math.max(1, r * 0.08); g.strokeStyle = ink;
    g.strokeRect(bx + g.lineWidth / 2, by + g.lineWidth / 2, bw - g.lineWidth, bh - g.lineWidth);
    g.textAlign = 'left';
    g.fillStyle = ink; g.fillText(who, bx + pad, by + bh / 2);
    g.fillStyle = seat.identity === 'landlord' ? accent : muted;
    g.fillText(ident, bx + pad + wW + gap, by + bh / 2);
    g.textAlign = 'center';
  }
  machine.commitMainHud();
}

/** 副屏 DOM：仍是记牌/概率的内容源与几何锚点，真 3D 面就绪后它隐身不再压住机身。 */
function renderCounterDom(){
  const counter = $('counter');
  counter.dataset.mode = S.barMode;
  const cells = $('counter-cells');
  const m = counterModel();

  if (m.mode === 'prob'){
    if (m.empty){
      cells.innerHTML = `<p class="prob-empty">${m.empty}</p>`;
      return;
    }
    cells.innerHTML = `<p class="prob-title">${m.title}</p>`
      + `<div class="prob-list" style="--prob-count:${Math.max(1, m.rows.length)}">`
      + m.rows.map(a =>
        `<p class="prob-row"><span class="prob-action">${a.label}</span>`
        + `<span class="prob-meta"><span class="prob-type">${a.type}</span>`
        + `<span class="prob-pct">${Math.round(a.probability * 100)}%</span></span></p>`).join('')
      + '</div>';
    return;
  }

  cells.innerHTML = m.cells.map(cell =>
    `<span class="cc${cell.n ? '' : ' is-out'}" title="${NAME[cell.rank]} 还剩 ${cell.n} 张">`
    + `<b class="${cell.labelLong ? 'long' : ''}">${cell.text}</b>`
    + `<i class="${cell.dotsLong ? 'i long' : 'i'}">`
    + Array.from({ length: Math.min(4, cell.n) }, () => '<s></s>').join('')
    + '</i></span>').join('');
}

function renderCounter(){
  renderCounterDom();
  paintCounter();
}

export function renderBar(){ renderCounter(); }

/** 窄屏用的计分板：把座位名牌从屏里搬出来，排成一条，避免互相压。 */
function setMachineError(status, error){
  const box = $('machine-error');
  if (!box) return;
  const failed = status === 'error' || status === 'no-webgl';
  // 只有真的失败才亮这块面板：加载中亮出来会显示「3D 机身不可用」，与事实矛盾。
  box.hidden = !failed;
  $('machine-retry').hidden = !failed;       // loading 时隐藏，避免重复发起加载
  $('machine-error-text').textContent = failed
    ? (error || '机身加载失败。')
    : (status === 'loading' ? '正在加载 3D 机身…' : '');
}

/* ---------- 四边形贴片 ----------
   机身一转，副屏的投影就是斜的四边形；AABB 贴上去必然顶出槽位。
   这里求 3x3 单应矩阵（矩形 → 四角），再翻成 CSS matrix3d。 */
function m3adj(m){
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}
function m3mul(a, b){
  const c = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++){
    c[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return c;
}
function m3mulv(m, v){
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
          m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
          m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}
function basisToPoints(p){
  const m = [p[0].x, p[1].x, p[2].x, p[0].y, p[1].y, p[2].y, 1, 1, 1];
  const v = m3mulv(m3adj(m), [p[3].x, p[3].y, 1]);
  return m3mul(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]);
}
/** (0,0)-(w,h) 的矩形 → 四角 [tl,tr,br,bl]，返回 CSS transform 值。 */
function quadMatrix(w, h, quad){
  const src = basisToPoints([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
  const t = m3mul(basisToPoints(quad), m3adj(src));
  const k = 1 / t[8];
  const m = t.map(v => v * k);
  // matrix3d 是列主序：x'=(m0·x+m1·y+m2)/(m6·x+m7·y+m8)
  return `matrix3d(${m[0]},${m[3]},0,${m[6]},`
    + `${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,${m[8]})`;
}
function placeHotspots(items){
  const ready = items.length > 0;
  const controls = $('controls');
  controls.classList.toggle('is-unavailable', !ready);
  for (const item of items){
    const el = $(item.id);
    if (!el) continue;
    el.style.left = `${item.x}px`;
    el.style.top = `${item.y}px`;
    el.style.width = `${item.w}px`;
    el.style.height = `${item.h}px`;
    el.style.clipPath = item.clip || 'none';
  }
}

function place(payload){
  const { status, error, seats = {}, rects = {}, buttons = [], sub3d = false, screen3d = false } = payload;
  const machineEl = $('board');
  const stage = $('stage');
  const stacked = window.innerWidth < 950;
  machineEl.classList.toggle('is-stacked', stacked);
  setMachineError(status, error);
  placeHotspots(status === 'ready' ? buttons : []);

  const s = rects.screen;
  if (!s) return;
  const ov = $('overlay');
  ov.classList.toggle('is-compact', stage.clientWidth < 900);
  ov.style.fontSize = `${Math.max(7, Math.min(13, s.w * 0.025)).toFixed(1)}px`;

  // 机下那条 2D 状态行要贴住机身下沿。机身投影在 stage 里的位置只有 machine 知道，
  // 把"机身底到 stage 底还差多少"量成变量交给 CSS，免得两边各写一个魔法数。
  //
  // 注意 tablet 是机身盒**前面四角**的投影，比看得见的剪影还低一点（底沿那条轨）。
  // 实测 360 / 420 / 480 / 620 四个视口，这段差值稳定在屏宽的 ≈4.7%，跟着机身一起缩放 ——
  // 不补的话状态层和机身之间会留一条亮缝，读起来就像贴在机器下面的一张卡片。
  const tablet = rects.tablet;
  const BOX_OVERHANG = 0.047;
  // 变量要设在 .stage 和状态行的共同祖先上（状态行是 .stage 的兄弟，设在自己身上传不过去）。
  if (tablet) machineEl.style.setProperty('--machine-bleed', `${Math.max(0,
    stage.clientHeight - (tablet.y + tablet.h) + stage.clientWidth * BOX_OVERHANG).toFixed(1)}px`);

  const sh = $('screen-hud');
  // 座位圆点已经画进主屏纹理：DOM 只留悬停展开的完整卡片，别再压一层盖在模型上。
  sh.classList.toggle('is-3d', Boolean(screen3d));
  sh.style.left = `${s.x}px`; sh.style.top = `${s.y}px`;
  sh.style.width = `${s.w}px`; sh.style.height = `${s.h}px`;
  for (const [player, el] of Object.entries(labels)) el.style.display = seats[player] ? '' : 'none';

  const top = rects.top, quad = rects.topQuad;
  const counter = $('counter');
  // 副屏已经贴进 3D 机身：DOM 只留几何与断言，别再画一层盖在模型上。
  counter.classList.toggle('is-3d', Boolean(sub3d));
  if (quad){
    // 副屏的投影是四边形：按四角做透视映射，机身怎么转它怎么跟，
    // 不会像 AABB 那样顶出槽位。宽度严格贴合副屏，高度只沿副屏自身
    // 的高度方向伸缩——窄屏要两行排 15 格，撑高比压成糊线好。
    const ux = quad.tr.x - quad.tl.x, uy = quad.tr.y - quad.tl.y;
    const vx = quad.bl.x - quad.tl.x, vy = quad.bl.y - quad.tl.y;
    const qw = Math.hypot(ux, uy) || 1;
    const qh = Math.hypot(vx, vy) || 1;
    const th = Math.max(stacked ? 26 : 0, Math.min(qh * 0.82, 64));
    const k = th / qh;
    const ox = quad.tl.x - vx * (k - 1) / 2, oy = quad.tl.y - vy * (k - 1) / 2;
    counter.hidden = false;
    counter.style.left = '0px';
    counter.style.top = '0px';
    counter.style.width = `${qw.toFixed(2)}px`;
    counter.style.height = `${th.toFixed(2)}px`;
    counter.style.transformOrigin = '0 0';
    counter.style.transform = quadMatrix(qw, th, [
      { x: ox, y: oy },
      { x: ox + ux, y: oy + uy },
      { x: ox + ux + vx * k, y: oy + uy + vy * k },
      { x: ox + vx * k, y: oy + vy * k },
    ]);
    counter.style.fontSize = `${Math.max(stacked ? 10 : 8, Math.min(15, th * 0.34)).toFixed(1)}px`;
  } else if (top){
    // 没量到四边形（旧模型/异常）时退回 AABB，别让机顶条整个消失。
    const th = Math.max(stacked ? 26 : 0, Math.min(top.h * 0.82, 64));
    counter.hidden = false;
    counter.style.transform = 'none';
    counter.style.left = `${top.x}px`;
    counter.style.width = `${top.w}px`;
    counter.style.top = `${top.y + (top.h - th) / 2}px`;
    counter.style.height = `${th}px`;
    counter.style.fontSize = `${Math.max(stacked ? 10 : 8, Math.min(15, th * 0.34)).toFixed(1)}px`;
  } else {
    counter.hidden = true;
  }

  // 开局面板是临时模态，仍可盖在屏上；数据面板由 CSS 固定在机侧/机下。
  const ng = $('newgame');
  const w = Math.min(Math.max(s.w, 380), Math.max(280, stage.clientWidth - 16));
  const h = Math.min(Math.max(s.h, 320), Math.max(200, stage.clientHeight - 8));
  ng.style.left = `${s.x + (s.w - w) / 2}px`;
  ng.style.top = `${s.y + (s.h - h) / 2}px`;
  ng.style.width = `${w}px`;
  ng.style.height = `${h}px`;
}

export function init(){
  return machine.init($('scene'), place);
}

export function render(){
  ensureLabels();
  paintLabels();
  renderSeatstrip();
  renderCounter();
  machine.apply(S.snap, S.meta);
  // 画座位圆章要读排好的手牌行数，所以放在 apply 之后，别吃到上一帧的布局。
  paintScreenHud();
}
