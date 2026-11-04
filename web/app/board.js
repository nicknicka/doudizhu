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
      + `<span class="cnt">${v.remaining[player]} 张</span></span>`
      + `<span class="played">已出：${played.length ? played.map(x => NAME[x] || x).join(' ') : '—'}</span>`;
  }
}

/** 机顶窄屏：记牌模式 = 点数 + 红点（剩几张）；概率模式 = 点数 + 上家/下家双色条。 */
function renderCounter(){
  const pool = S.snap.pool_counts || {};
  const point = S.point;
  const prob = {};
  if (point && point.cards) for (const row of point.cards) prob[row.card] = row.by;
  const opps = (point && point.opponents) || [];
  const nm = r => NAME[r];
  const cls = r => (nm(r).length > 1 && !/^[0-9]+$/.test(nm(r)) ? 'long' : '');
  $('counter-cells').innerHTML = RANKS.map(r => {
    if (S.barMode === 'prob'){
      const by = prob[r];
      if (!by || !opps.length) return `<span class="cc is-out"><b class="${cls(r)}">${nm(r)}</b><i></i></span>`;
      const a = by[opps[0]] || { expected: 0 }, b = by[opps[1]] || { expected: 0 };
      const total = Math.max(0.001, a.expected + b.expected);
      const aw = Math.round((a.expected / total) * 100);
      return `<span class="cc" title="${label(opps[0])} ${a.expected.toFixed(2)} 张 · `
        + `${label(opps[1])} ${b.expected.toFixed(2)} 张">`
        + `<b class="${cls(r)}">${nm(r)}</b>`
        + `<i class="bar"><s style="width:${aw}%"></s></i>`
        + `<em>${a.expected.toFixed(1)}|${b.expected.toFixed(1)}</em>`
        + `</span>`;
    }
    const n = pool[r] || 0;
    const dots = Array.from({ length: Math.min(4, n) }, () => '<s></s>').join('');
    return `<span class="cc${n ? '' : ' is-out'}" title="${NAME[r]} 还剩 ${n} 张">`
      + `<b class="${cls(r)}">${nm(r)}</b><i>${dots}</i></span>`;
  }).join('');

  $('bar-mode').textContent = S.barMode === 'prob' ? '出牌概率' : '记牌';
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

  // 操作台托盘贴合机身下沿：机身底边（stage 局部坐标）到 stage 底还有一段空画布，
  // 用等量的负 margin 把它收掉（留 8px 给机底接触阴影），托盘就成了机身下沿的延伸。
  const tb = rects.tablet;
  if (tb){
    const lip = Math.max(0, stage.clientHeight - (tb.y + tb.h) - 8);
    machineEl.style.setProperty('--lip', `${lip.toFixed(1)}px`);
  } else {
    machineEl.style.removeProperty('--lip');
  }

  const s = rects.screen;
  if (!s) return;
  const ov = $('overlay');
  ov.classList.toggle('is-compact', stage.clientWidth < 900);
  ov.style.fontSize = `${Math.max(7, Math.min(13, s.w * 0.025)).toFixed(1)}px`;

  const sh = $('screen-hud');
  sh.style.left = `${s.x}px`; sh.style.top = `${s.y}px`;
  sh.style.width = `${s.w}px`; sh.style.height = `${s.h}px`;
  for (const [player, el] of Object.entries(labels)) el.style.display = seats[player] ? '' : 'none';

  const top = rects.top;
  const counter = $('counter');
  if (top){
    // 窄屏机顶条必须两行排 15 格；给足高度，文字才不会被压成糊线。
    const th = Math.max(stacked ? 26 : 0, Math.min(top.h * 0.82, 64));
    counter.hidden = false;
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
