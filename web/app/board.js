// 牌桌的**平面**部分：座位标签（按 3D 投影定位）、机顶条、计分板、透明键热区。
// 三维形状和真屏在 machine.js 里；要读的数字留在这一层。

import { S, $ } from './state.js';
import { RANKS, NAME, label, identityLabel, isMe, overText } from './labels.js';
import * as machine from './machine.js';

let labels = {};
let labelsKey = '';

/** 抬头：说明"现在看的是哪一手、我方是谁"。 */
function renderWho(){
  const m = S.meta, v = S.snap;
  const latest = v.step === m.total_steps;
  const k = m.my_steps.indexOf(v.step);
  $('who').innerHTML = `${m.record_id} · ${m.source} · 全局第 ${v.step}/${m.total_steps} 手`
    + (k >= 0 ? ` · <b>我的第 ${k + 1} 次出牌机会</b>` : '')
    + ` · 我方是${identityLabel(m.me)}`
    + (v.finished ? ` · <b>${overText(v.winner)}</b>` : '');
  $('tool-note').textContent = latest ? '' : '· 看历史局面时不能续录';
}

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

/** 副屏：记牌模式显示剩余张数；概率模式显示当前行动者 Top-3 完整动作。 */
function renderCounter(){
  const counter = $('counter');
  counter.dataset.mode = S.barMode;
  const cells = $('counter-cells');

  if (S.barMode === 'prob'){
    const point = S.point;
    if (!point){
      const message = S.snap.finished ? '本局已结束' : '当前不是你的出牌机会';
      cells.innerHTML = `<p class="prob-empty">${message}</p>`;
      return;
    }
    const predictions = (point.predictions || []).slice(0, 3);
    const title = `${label(point.actor)} · 模型动作选择概率`;
    cells.innerHTML = `<p class="prob-title">${title}</p>`
      + `<div class="prob-list" style="--prob-count:${Math.max(1, predictions.length)}">`
      + predictions.map(a =>
        `<p class="prob-row"><span class="prob-action">${a.label}</span>`
        + `<span class="prob-meta"><span class="prob-type">${a.type}</span>`
        + `<span class="prob-pct">${Math.round(a.probability * 100)}%</span></span></p>`).join('')
      + '</div>';
    return;
  }

  const pool = S.snap.pool_counts || {};
  const nm = r => NAME[r];
  const cls = r => (nm(r).length > 1 && !/^[0-9]+$/.test(nm(r)) ? 'long' : '');
  cells.innerHTML = RANKS.map(r => {
    const n = pool[r] || 0;
    const dots = Array.from({ length: Math.min(4, n) }, () => '<s></s>').join('');
    // 双字点数（小王/大王）的红点按字排：一个字底下一个点
    const iw = nm(r).length > 1 ? ' class="i long"' : ' class="i"';
    return `<span class="cc${n ? '' : ' is-out'}" title="${NAME[r]} 还剩 ${n} 张">`
      + `<b class="${cls(r)}">${nm(r)}</b><i${iw}>${dots}</i></span>`;
  }).join('');
}

export function renderBar(){ renderCounter(); }

/** 窄屏用的计分板：把座位名牌从屏里搬出来，排成一条，避免互相压。 */
function renderScoreboard(){
  const v = S.snap;
  const rank = { up: 0, me: 1, down: 2 };
  const players = Object.keys(S.meta.seats).slice().sort((a, b) =>
    (rank[S.meta.seats[a].relative] ?? 3) - (rank[S.meta.seats[b].relative] ?? 3));
  $('scoreboard').innerHTML = players.map(player => {
    const seat = S.meta.seats[player];
    const mine = isMe(player), acting = !v.finished && v.acting === player;
    const played = v.played[player] || [];
    return `<div class="sc${mine ? ' is-me' : ''}${acting ? ' is-acting' : ''}">`
      + `<span class="who"><b>${label(player)}</b>`
      + `<span class="badge ${seat.identity}">${identityLabel(player)}</span>`
      + `<span class="cnt">${v.remaining[player]} 张</span>`
      + (acting ? `<span class="turn-flag">▶ ${mine ? '该你出' : '该他出'}</span>` : '')
      + `</span>`
      + `<span class="played">已出：${played.length ? played.map(x => NAME[x] || x).join(' ') : '—'}</span>`
      + `</div>`;
  }).join('');
}

/** 我的手牌在平面上的可读副本；3D 牌面负责点选。 */
function renderHandLine(){
  const hand = (S.snap && S.snap.my_hand) || [];
  $('handline').innerHTML = `<span class="lb">我的牌（${hand.length} 张）</span>`
    + hand.map(r => `<i>${NAME[r] || r}</i>`).join('');
}

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
  const { status, error, seats = {}, rects = {}, buttons = [] } = payload;
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

  const sh = $('screen-hud');
  sh.style.left = `${s.x}px`; sh.style.top = `${s.y}px`;
  sh.style.width = `${s.w}px`; sh.style.height = `${s.h}px`;
  for (const [player, el] of Object.entries(labels)) el.style.display = seats[player] ? '' : 'none';

  const top = rects.top, quad = rects.topQuad;
  const counter = $('counter');
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
  renderWho();
  ensureLabels();
  paintLabels();
  renderCounter();
  renderScoreboard();
  renderHandLine();
  machine.apply(S.snap, S.meta);
}
