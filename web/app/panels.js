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
      // 压一点饱和度：粒子云是配角，不该比牌桌更呛眼
      cx.globalAlpha = (focus && order[c] !== focus) ? .10 : .72;
      cx.fillStyle = row[c]===1 ? A : row[c]===2 ? B : 'transparent';
      // 留 1px 缝：格子分得开，才像像素而不是色块
      if (row[c]) cx.fillRect(c*w, y, Math.max(w-1,1), Math.max(h-1,1));
    }
  }
  cx.globalAlpha = 1;
}

/** 高亮某张牌：云里那一列亮起来，概率列表对应那行也亮起来。 */
export function focus(cardName){
  currentFocus = cardName || S.pinned;
  draw(currentFocus);
}

function togglePin(cardName){
  if (!cardName) return;
  S.pinned = (S.pinned === cardName) ? null : cardName;
  focus(null);
}

export function beginReveal(){ if (!reduce) FX.reveal = 0; }

/** 面板是点开才显示的：展开后要重新按尺寸画一次，否则画布是 0×0 */
export function resize(){ sizeCanvas(); draw(currentFocus); }

export function animateIn(){
  if (!reduce){
    // 粒子云从下往上"扫"出来；步进缓动（steps）把像素感守住
    gsap.to(FX, {reveal:1, duration:.5, ease:"steps(7)", onUpdate:()=>draw(currentFocus)});
  } else {
    FX.reveal = 1; draw(currentFocus);
  }
}

function renderCloud(){
  const p = S.point;
  $('cloud').classList.toggle('is-empty', !p);
  if (!p){
    $('la').textContent = ''; $('lb').textContent = '';
    $('la2').textContent = ''; $('lb2').textContent = '';
    return;
  }
  $('la').textContent = label(p.opponents[0]); $('lb').textContent = label(p.opponents[1]);
  $('la2').textContent = label(p.opponents[0]); $('lb2').textContent = label(p.opponents[1]);
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
  renderCloud(); renderCalib(); renderFoot();
  build(); sizeCanvas();
}

cv.addEventListener('click', () => togglePin(hoverCard));
cv.addEventListener('mousemove', e => {
  if (!order.length) return;
  const r = cv.getBoundingClientRect();
  const c = Math.floor((e.clientX - r.left) / (r.width / order.length));
  hoverCard = (c >= 0 && c < order.length) ? order[c] : null;
  focus(hoverCard);
});
cv.addEventListener('mouseleave', () => { hoverCard = null; focus(null); });
