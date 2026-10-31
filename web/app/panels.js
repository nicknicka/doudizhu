// 机身侧面的几块面板：粒子云、逐张概率、校准、页脚指标。
// 它们共享同一套"点某张牌 → 高亮"的交互，所以放在一起。

import { S, reduce, $ } from './state.js';
import { RANKS, NAME, label, countIn } from './labels.js';

const ROWS = 64;
const cv = $('cloud'), cx = cv.getContext('2d');
let order = [], grid = [], hoverCard = null;
let rowStride = 1, rowCount = 0, currentFocus = null;
const FX = {reveal:1};                       // 0→1 的扫描式入场

function build(){
  const p = S.point;
  if (!p){ order = []; grid = []; rowCount = 0; return; }
  order = [];
  for (const r of RANKS){
    const n = Math.max(0, ...p.particles.map(([a, b]) => countIn(a, r) + countIn(b, r)));
    for (let i = 0; i < n; i++) order.push(r);
  }
  grid = p.particles.map(([a,b]) => {
    const seen = {};
    return order.map(c=>{
      seen[c] = (seen[c]||0) + 1;
      if (seen[c] <= countIn(a,c)) return 1;
      return seen[c] <= countIn(a,c) + countIn(b,c) ? 2 : 0;
    });
  });
  grid.sort((x,y)=>{
    const sx = x.reduce((acc,v)=>acc+(v===1),0), sy = y.reduce((acc,v)=>acc+(v===1),0);
    return sx - sy || x.join('').localeCompare(y.join(''));
  });
  rowStride = Math.max(1, Math.ceil(grid.length / ROWS));
  rowCount = Math.ceil(grid.length / rowStride);
}

function sizeCanvas(){
  const r = devicePixelRatio || 1;
  cv.width = cv.clientWidth * r; cv.height = cv.clientHeight * r;
  cx.setTransform(r,0,0,r,0,0);
}

function draw(focus){
  if (!order.length || !rowCount) return;
  const w = cv.clientWidth / order.length, h = cv.clientHeight / rowCount;
  cx.clearRect(0,0,cv.clientWidth,cv.clientHeight);
  const A = getComputedStyle(document.documentElement).getPropertyValue('--side-a').trim();
  const B = getComputedStyle(document.documentElement).getPropertyValue('--side-b').trim();
  const limit = Math.max(1, Math.ceil(rowCount * FX.reveal));
  for (let i=0;i<limit;i++){
    const row = grid[i * rowStride], y = i * h;
    for (let c=0;c<order.length;c++){
      cx.globalAlpha = (focus && order[c] !== focus) ? .12 : 1;
      cx.fillStyle = row[c]===1 ? A : row[c]===2 ? B : 'transparent';
      // 留 1px 缝：格子分得开，才像像素而不是色块
      if (row[c]) cx.fillRect(c*w, y, Math.max(w-1,1), Math.max(h-1,1));
    }
  }
  cx.globalAlpha = 1;
}

/** 高亮某张牌：云里那一列亮起来，概率列表对应那行也亮起来。 */
export function focus(cardName){
  const active = cardName || S.pinned;
  currentFocus = active;
  draw(active);
  document.querySelectorAll('#plist li[data-card]').forEach(li =>
    li.classList.toggle('is-focus', li.dataset.card === active));
}

function togglePin(cardName){
  if (!cardName) return;
  S.pinned = (S.pinned === cardName) ? null : cardName;
  focus(null);
}

export function beginReveal(){ if (!reduce) FX.reveal = 0; }

export function animateIn(){
  if (!reduce){
    // 粒子云从下往上"扫"出来；步进缓动（steps）把像素感守住
    gsap.to(FX, {reveal:1, duration:.5, ease:"steps(7)", onUpdate:()=>draw(currentFocus)});
  } else {
    FX.reveal = 1; draw(currentFocus);
  }
}

function renderCloudAndList(){
  const p = S.point;
  $('cloud').classList.toggle('is-empty', !p);
  if (!p){ $('la').textContent = ''; $('lb').textContent = ''; $('plist').innerHTML = ''; return; }
  $('la').textContent = p.opponents[0]; $('lb').textContent = p.opponents[1];
  const head = '<li class="head"><span></span>'
    + p.opponents.map((o,i)=>`<span class="p ${i?'b':'a'}">${label(o)}</span>`).join('') + '</li>';
  const rows = list => head + list.map(r =>
    `<li data-card="${r.card}" tabindex="0" role="button" aria-label="${NAME[r.card]} 在谁手上">`
    + `<span class="c">${NAME[r.card]}</span>`
    + p.opponents.map((o,i)=>{
        const v = r.by[o];
        return `<span class="p ${i?'b':'a'}"><b>${(v.p*100).toFixed(0)}%</b>`
             + `<small>${v.expected.toFixed(2)} 张</small></span>`;
      }).join('') + '</li>').join('');
  // 分两栏，每栏各带一次表头 —— 否则读者不知道哪一列是哪一家
  const half = Math.ceil(p.cards.length / 2);
  $('plist').innerHTML =
    `<ul class="plist">${rows(p.cards.slice(0, half))}</ul>`
    + `<ul class="plist">${rows(p.cards.slice(half))}</ul>`;
}

function renderCalib(){
  const c = S.calibration;
  if (!c){ $('calib').innerHTML = ''; $('calib-src').textContent = ''; $('calib-caveat').textContent = ''; return; }
  $('calib').innerHTML =
    '<tr><th>估计区间</th><th>样本</th><th>平均</th><th>实际</th></tr>'
    + c.buckets.map(b=>
        `<tr><td>${b.low.toFixed(2)}~${b.high.toFixed(2)}</td><td>${b.n}</td>`
        + `<td>${b.mean_estimate.toFixed(3)}</td><td>${b.actual_rate.toFixed(3)}</td></tr>`
      ).join('')
    + `<tr><td>合计</td><td>${c.n_samples}</td>`
    + `<td>${c.mean_estimate.toFixed(3)}</td><td>${c.actual_rate.toFixed(3)}</td></tr>`;
  $('calib-src').textContent = '演示数据集（8 局仿真），与当前记录无关。';
  $('calib-caveat').textContent = S.caveat;
}

function renderFoot(){
  const m = S.metrics;
  if (!m){ $('foot').innerHTML = ''; return; }
  $('foot').innerHTML = [
    ['Top-1', (m.top1*100).toFixed(1)+'%', `基线 ${(m.top1_base*100).toFixed(1)}%`],
    ['对数似然', m.ll, `基线 ${m.ll_base}`],
    ['决策点', m.n_positions, `${m.n_cards} 计分项`],
  ].map(([k,v,s])=>`<div><div class="k">${k}</div><div class="v">${v}<small>${s}</small></div></div>`).join('');
  $('foot').insertAdjacentHTML('afterbegin',
    '<div class="k" style="align-self:center">演示数据集<br>（10 局仿真）</div>');
}

export function render(){
  S.pinned = null;
  renderCloudAndList(); renderCalib(); renderFoot();
  build(); sizeCanvas(); focus(null);
}

$('plist').addEventListener('mouseover', e => {
  const li = e.target.closest('li[data-card]'); if (li) focus(li.dataset.card);
});
$('plist').addEventListener('mouseleave', () => focus(null));
$('plist').addEventListener('click', e => {
  const li = e.target.closest('li[data-card]'); if (li) togglePin(li.dataset.card);
});
$('plist').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const li = e.target.closest('li[data-card]'); if (!li) return;
  e.preventDefault(); togglePin(li.dataset.card);
});
cv.addEventListener('click', () => togglePin(hoverCard));
cv.addEventListener('mousemove', e => {
  if (!order.length) return;
  const r = cv.getBoundingClientRect();
  const c = Math.floor((e.clientX - r.left) / (r.width / order.length));
  hoverCard = (c >= 0 && c < order.length) ? order[c] : null;
  focus(hoverCard);
});
cv.addEventListener('mouseleave', () => { hoverCard = null; focus(null); });
