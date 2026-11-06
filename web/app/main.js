// 启动与串联：把取数、牌桌、面板、操作台接起来。
// 这里没有业务规则 —— 上面四个模块各管一件事。

import { S, SEL, reduce, $ } from './state.js';
import { api, setBanner, idleNote } from './api.js';
import * as board from './board.js';
import * as panels from './panels.js';
import * as consolePanel from './console.js';
import * as machine from './machine.js';
import { initDeskPixels } from './deskbg.js';
import { turnText, overText } from './labels.js';
import { resetSession } from './virtual-cards.js';

function renderAll(){
  board.render();
  consolePanel.render();
  panels.render();
}

async function refresh(target, note){
  if (S.busy || !S.record) return false;
  S.busy = true;
  setBanner('分析中…', '');
  let ok = false;
  try {
    const view = await api('/api/analyze', {record: S.record, step: target ?? null});
    S.meta = view; S.snap = view.snapshot; S.point = view.point;
    SEL.play = [];
    consolePanel.resetHint();
    panels.beginReveal();
    renderAll();
    setBanner(note || idleNote(), '');
    ok = true;
  } catch (err){
    setBanner(err.message, 'error');
  } finally {
    S.busy = false;
  }
  panels.animateIn();
  return ok;
}

async function mutate(path, body, note){
  if (S.busy) return false;
  const previous = S.record;
  S.busy = true;
  setBanner('提交中…', '');
  try {
    S.record = (await api(path, body)).record;
  } catch (err){
    S.busy = false;
    setBanner(err.message, 'error');
    return false;
  }
  S.busy = false;
  // 录完一手要看"当前位置"，不是默认视图 —— 牌桌得跟着动
  const ok = await refresh(S.record.steps.length, note);
  if (!ok) S.record = previous;
  return ok;
}

/* 演示局只把记录接到开屏那一手 —— 后端把整局完整下发（回放/终局用例照旧
   拿得到），这里切到 ``opening_step``，让首页直接落在「轮到我方、真有得选」
   的局面，接着录就是用户的牌局。步号不合法（0 / 越界 / 缺省）就原样返回。 */
function openingRecord(record, step){
  if (!Number.isInteger(step) || step <= 0 || step >= record.steps.length) return record;
  return {...record, steps: record.steps.slice(0, step)};
}

async function loadRecord(record, note, viewStep){
  const previous = S.record;
  resetSession();                       // 换 / 重开记录：花色回到 record_id 确定性重推（#48）
  S.record = record;
  // 不指定就看后端挑的默认局面；演示局会指定"开屏那一手"，让首页直接落在能出牌的地方
  if (!(await refresh(viewStep ?? null, note))) S.record = previous;
}

function stepTo(delta){
  if (S.busy || !S.meta) return;
  // 同 console.js：当前位置不一定落在 my_steps 里，按方向取最近的出牌机会。
  const list = S.meta.my_steps, cur = S.snap.step;
  const next = delta < 0
    ? [...list].reverse().find(st => st < cur)
    : list.find(st => st > cur);
  if (next !== undefined) refresh(next);
}

/* ---------- 工具条 ---------- */
$('new-toggle').addEventListener('click', () => {
  if (consolePanel.isNewPanelOpen()) consolePanel.hideNewPanel();
  else consolePanel.showNewPanel();
});
// 左握把那个方键：开新一轮（在屏幕里录入，不跳页）
$('new-round').addEventListener('click', () => consolePanel.showNewPanel());
$('newgame-close').addEventListener('click', () => consolePanel.hideNewPanel());
$('undo').addEventListener('click', () =>
  mutate('/api/game/undo', {record:S.record}, '已撤销最后一手。'));
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(S.record, null, 2) + '\n'], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${S.record.record_id || 'record'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------- 打开记录 ---------- */
async function readFile(file){
  if (!file) return;
  try {
    await loadRecord(JSON.parse(await file.text()),
                     `已载入 ${file.name}（校准表与页脚指标仍来自演示数据集）`);
  } catch (err){
    setBanner(err instanceof SyntaxError ? `${file.name} 不是合法 JSON` : err.message, 'error');
  }
}
$('file').addEventListener('change', e => { readFile(e.target.files[0]); e.target.value = ''; });
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', e => {
  e.preventDefault(); document.body.classList.remove('dragging');
  readFile(e.dataTransfer.files[0]);
});

/* ---------- 透明热区：悬浮（或触摸长按）0.5 秒才弹功能气泡 ---------- */
const tip = $('tip');
let tipTimer = null;
const hideTip = () => {
  if (tipTimer){ clearTimeout(tipTimer); tipTimer = null; }
  if (tip) tip.classList.remove('is-on');
};
const showTip = el => {
  if (!tip || !el.dataset.tip) return;
  tip.textContent = el.dataset.tip;
  tip.classList.add('is-on');                    // 先显示再量：display:none 时 offsetWidth 是 0，夹不住边
  const r = el.getBoundingClientRect(), sr = $('stage').getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const half = tip.offsetWidth / 2 + 4;          // 贴到边缘时夹住，别把气泡顶出机身
  tip.style.left = `${Math.min(Math.max(cx, half), sr.width - half)}px`;
  // 下方放不下就翻到键帽上面，别被机身边缘裁掉
  const below = r.bottom - sr.top + 6;
  const over = below + tip.offsetHeight > sr.height;
  tip.style.top = `${over ? r.top - sr.top - tip.offsetHeight - 6 : below}px`;
};
const armTip = el => { hideTip(); tipTimer = setTimeout(() => showTip(el), 500); };
document.querySelectorAll('[data-tip]').forEach(el => {
  el.addEventListener('mouseenter', () => armTip(el));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') armTip(el); });
  ['pointerup', 'pointercancel', 'click'].forEach(ev => el.addEventListener(ev, hideTip));
});

/* ---------- 数据面板：宽屏机侧、窄屏机下，不覆盖屏幕 ---------- */
const crtPanel = $('crt');
const machineEl = $('board');
const closeData = () => {
  crtPanel && crtPanel.classList.remove('is-open');
  machineEl && machineEl.classList.remove('panel-open');
};
$('data-toggle').addEventListener('click', () => {
  crtPanel.classList.toggle('is-open');
  machineEl.classList.toggle('panel-open', crtPanel.classList.contains('is-open'));
  if (crtPanel.classList.contains('is-open')) panels.resize();
});
$('data-close').addEventListener('click', closeData);
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeData();
  if (consolePanel.isNewPanelOpen()) consolePanel.hideNewPanel();
});

/* ---------- 模型失败：明确提示 + 重试，不回退程序化壳子 ---------- */
$('machine-retry').addEventListener('click', () => machine.retry());

/* ---------- 按键反馈：机身沉一下弹回，桌面光池亮一下、从按压点荡出一圈 ---------- */
const desk = $('desk');
const bgpix = initDeskPixels($('bg-pixels'));
let deskPulseTimer = null;
function deskPulse(clientX, clientY){
  bgpix.pulse(clientX, clientY);
  if (!desk) return;
  desk.classList.add('is-pulsing');
  clearTimeout(deskPulseTimer);
  deskPulseTimer = setTimeout(() => desk.classList.remove('is-pulsing'), 200);
  if (clientX === undefined || clientY === undefined) return;
  const r = $('stage').getBoundingClientRect();
  const sp = document.createElement('span');
  sp.className = 'ripple';
  sp.style.left = `${clientX - r.left}px`;
  sp.style.top = `${clientY - r.top}px`;
  desk.appendChild(sp);
  setTimeout(() => sp.remove(), 700);
}
$('controls')?.addEventListener('pointerdown', e => {
  const key = e.target.closest('.key');
  // 灰着的键按了也没有动作（后端不认非最新/非我方的那一手），就不该给它按下反馈
  if (!key || key.disabled) return;
  machine.pressFeedback(key.id);
  deskPulse(e.clientX, e.clientY);
});

/* ---------- 窄屏操作条：同功能、独立 id，转发到主热区 ---------- */
const touchbar = $('touchbar');
touchbar.addEventListener('click', e => {
  const b = e.target.closest('button[data-control]');
  if (!b) return;
  const main = $(b.dataset.control);
  if (main && !main.disabled){
    machine.pressFeedback(main.id);
    const r = b.getBoundingClientRect();
    deskPulse(r.left + r.width / 2, r.top + r.height / 2);
    main.click();
  }
});
const touchButtons = [...touchbar.querySelectorAll('button[data-control]')];
// 机身键帽自己不会变灰：把 DOM 热区的 disabled 状态同步到 3D 键帽上（只压暗，不改材质响应）
const keyHotspots = [...document.querySelectorAll('#controls .key')];
const syncTouch = () => {
  for (const b of touchButtons){
    const main = $(b.dataset.control);
    b.disabled = !main || main.disabled || machine.machineStatus().status !== 'ready';
  }
  for (const el of keyHotspots) machine.setKeyDisabled(el.id, el.disabled);
};
new MutationObserver(syncTouch).observe($('controls'), {
  subtree: true, attributes: true, attributeFilter: ['disabled'],
});
setInterval(syncTouch, 300);

/* ---------- 屏幕里点牌 / 拖牌 = 选牌 ----------
   拖拽语义：**进入一张牌的区域就反转它**。所以滑过几张已选中的牌会逐张取消，
   滑出去再滑回同一张牌会再反转一次。用 lastCard 记住"当前正压着哪张"，
   指针落在牌之外（或两张牌之间）时清空，重新进入就重新反转。 */
let draggingCard = false, lastCard = null;
// pickCardAt 吃的是 .stage 局部坐标（屏热区、手牌落点都在这个坐标系里）。
// 画布铺满视口后画布比 .stage 大，所以基准必须取 .stage 而不是画布。
const cardAt = e => {
  const r = $('stage').getBoundingClientRect();
  return machine.pickCardAt(e.clientX - r.left, e.clientY - r.top);
};
$('stage').addEventListener('pointerdown', e => {
  if (e.target.closest('button')) return;
  const i = cardAt(e);
  if (i === null) return;
  draggingCard = true;
  lastCard = i;
  consolePanel.toggleCard(i);
  e.preventDefault();
  // 牌上按下只做选牌，不能再启动机身拖拽并抢走 pointer capture。
  e.stopPropagation();
});
$('stage').addEventListener('pointermove', e => {
  if (!draggingCard) return;
  const i = cardAt(e);
  if (i === lastCard) return;      // 同一张牌里移动不算重新进入
  lastCard = i;
  if (i !== null) consolePanel.toggleCard(i);
});
const endCardDrag = () => { draggingCard = false; lastCard = null; };
addEventListener('pointerup', endCardDrag);
addEventListener('pointercancel', endCardDrag);
addEventListener('keydown', e => {
  const t = document.activeElement.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') stepTo(-1);
  else if (e.key === 'ArrowRight') stepTo(1);
});


/* ---------- 极简模式：首屏只剩机身 + 底部 Dock ---------- */
document.body.classList.add('is-minimal');
// 把数据面板按钮移到 body 直接子级，脱离 .page 的 stacking context，确保可点击
const dataToggle = $('data-toggle');
if (dataToggle) document.body.appendChild(dataToggle);

// 操作台：状态行常驻在 dock，deckbar 作为独立浮层从 dock 上沿拉起
const panel = $('panel');
const stripWho = $('strip-who');
const stripSub = $('strip-sub');

// 更新状态带文字：主=现在该谁，副=进度/终局；不显示内部 record_id
function updateStatusStrip(){
  if (!stripWho || !stripSub) return;
  const v = S.snap, m = S.meta;
  if (!m || !v || !m.total_steps){ stripWho.textContent = '正在加载…'; stripSub.textContent = ''; return; }
  stripWho.textContent = v.finished ? overText(v.winner) : turnText(v.acting);
  const k = m.my_steps.indexOf(v.step);
  stripSub.textContent = `全局第 ${v.step}/${m.total_steps} 手`
    + (k >= 0 ? ` · 我的第 ${k + 1} 次出牌机会` : '');
}
// 用 MutationObserver 监听 #who 的变化
const whoEl = $('who');
if (whoEl){
  new MutationObserver(updateStatusStrip).observe(whoEl, { childList: true, characterData: true, subtree: true });
}

// Dock 按钮事件
const dockMap = {
  'dock-steps': () => {
    // 开关操作台；状态行始终留在 dock 上
    panel?.classList.toggle('is-open');
    syncDockActive();
  },
  'dock-data': () => { $('data-toggle')?.click(); },
  'dock-new': () => { $('new-toggle')?.click(); },
  'dock-export': () => { $('export')?.click(); },
};
document.querySelectorAll('.dock-btn').forEach(btn => {
  const id = btn.id;
  if (id === 'dock-open'){
    const fileInput = btn.querySelector('input[type="file"]');
    btn.addEventListener('click', e => {
      if (e.target.tagName !== 'INPUT') fileInput?.click();
    });
    fileInput?.addEventListener('change', e => {
      // 转发给页面原始的 file input
      const origFile = $('file');
      if (origFile && e.target.files?.length){
        const dt = new DataTransfer();
        dt.items.add(e.target.files[0]);
        origFile.files = dt.files;
        origFile.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    return;
  }
  const fn = dockMap[id];
  if (fn) btn.addEventListener('click', fn);
});

// 同步 dock 按钮 active 态
const syncDockActive = () => {
  // 数据面板
  const dataBtn = $('dock-data');
  if (dataBtn) dataBtn.classList.toggle('is-active', !!$('crt')?.classList.contains('is-open'));
  // 操作台
  const stepsBtn = $('dock-steps');
  if (stepsBtn) stepsBtn.classList.toggle('is-active', !!panel?.classList.contains('is-open'));
};
if ($('crt')) new MutationObserver(syncDockActive).observe($('crt'), { attributes: true, attributeFilter: ['class'] });
if (panel) new MutationObserver(syncDockActive).observe(panel, { attributes: true, attributeFilter: ['class'] });
syncDockActive();

// 拖拽提示：拖过一次就隐藏
const dragHint = $('drag-hint');
let hintHidden = false;
const hideDragHint = () => {
  if (hintHidden) return;
  hintHidden = true;
  dragHint?.classList.add('is-hidden');
  setTimeout(() => { if (dragHint) dragHint.style.display = 'none'; }, 600);
};

/* ---------- stage 拖拽：机身边框 = 转，空白背景 = 平移 ---------- */
let rigDragActive = false;
let rigDragMoved = false;
let panActive = false;
const sceneEl = $('scene');
const setCursor = c => { if (sceneEl) sceneEl.style.cursor = c; };
// 首次悬停机身也淡化提示（用户发现了就够了）
let hintHovered = false;
$('stage').addEventListener('pointerenter', () => {
  if (hintHovered) return;
  hintHovered = true;
  if (dragHint) dragHint.style.opacity = '.35';
});

// 屏幕范围（牌桌）：按住它是在看牌/点牌，不该转机身
const onScreen = (x, y) => {
  const r = $('screen-hud').getBoundingClientRect();
  return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};

$('stage').addEventListener('pointerdown', e => {
  // 点到牌/按钮/控件上就不拖
  if (e.target.closest('button') || e.target.closest('.key') || e.target.closest('.seat-label')) return;
  // 只有左键 / 触摸才拖
  if (e.button !== undefined && e.button !== 0) return;
  // 只有按住机身本体（且不是屏幕）才转；机身外空场、牌桌都不接管
  if (!machine.isOnBody(e.clientX, e.clientY) || onScreen(e.clientX, e.clientY)) return;
  rigDragActive = true;
  rigDragMoved = false;
  machine.startDrag(e.clientX, e.clientY);
  try { e.target.setPointerCapture(e.pointerId); } catch {}
});
$('stage').addEventListener('pointermove', e => {
  if (!rigDragActive) return;
  rigDragMoved = true;
  machine.moveDrag(e.clientX, e.clientY);
  hideDragHint();
});
// 机身外的空白背景 = 平移；松手弹回原位
$('stage').addEventListener('pointerdown', e => {
  if (e.target.closest('button') || e.target.closest('.key') || e.target.closest('.seat-label')) return;
  if (e.button !== undefined && e.button !== 0) return;
  if (onScreen(e.clientX, e.clientY) || machine.isOnBody(e.clientX, e.clientY)) return;
  panActive = true;
  setCursor('grabbing');
  machine.startPan(e.clientX, e.clientY);
  try { e.target.setPointerCapture(e.pointerId); } catch {}
});
$('stage').addEventListener('pointermove', e => {
  if (panActive){
    machine.movePan(e.clientX, e.clientY);
    hideDragHint();
    return;
  }
  if (rigDragActive) return;
  // 悬在空白背景上给个 grab，提示这里能拖
  setCursor(onScreen(e.clientX, e.clientY) || machine.isOnBody(e.clientX, e.clientY) ? '' : 'grab');
});
const endRigDrag = e => {
  if (panActive){
    panActive = false;
    setCursor('');
    machine.endPan();
    return;
  }
  if (!rigDragActive) return;
  rigDragActive = false;
  machine.endDrag();
};
$('stage').addEventListener('pointerup', endRigDrag);
$('stage').addEventListener('pointercancel', endRigDrag);
$('stage').addEventListener('pointerleave', e => { if (rigDragActive || panActive) endRigDrag(e); });

// 滚轮缩放
$('stage').addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 1 : -1;
  machine.zoomBy(delta);
  hideDragHint();
}, { passive: false });

// 双击复位缩放 + 角度
$('stage').addEventListener('dblclick', e => {
  if (e.target.closest('button') || e.target.closest('.key') || e.target.closest('.seat-label')) return;
  machine.zoomReset();
});

// 座位标签点击 ripple
document.querySelectorAll('.seat-label').forEach(label => {
  label.addEventListener('click', () => {
    const existing = label.querySelector('.ripple');
    if (existing) existing.remove();
    const r = document.createElement('span');
    r.className = 'ripple';
    label.appendChild(r);
    setTimeout(() => r.remove(), 650);
  });
});

// 3 秒后自动淡出拖拽提示
setTimeout(hideDragHint, 3500);


async function boot(){
  board.init();
  consolePanel.init({ refresh, mutate, renderBar: board.renderBar });
  syncTouch();
  try {
    const [config, d] = await Promise.all([api('/api/config'), api('/api/demo')]);
    S.config = config;
    S.metrics = d.metrics; S.calibration = d.calibration; S.caveat = d.caveat;
    await loadRecord(openingRecord(d.record, d.opening_step),
      '演示局：自对弈到该你出牌的一手，接着录就是你的牌局。想从头开始点「开新局」。',
      d.opening_step);
    updateStatusStrip();
  } catch (err){
    setBanner(err.message, 'error');
  }
}

boot();
