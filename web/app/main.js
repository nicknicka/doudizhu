// 启动与串联：把取数、牌桌、面板、操作台接起来。
// 这里没有业务规则 —— 上面四个模块各管一件事。

import { S, SEL, reduce, $ } from './state.js';
import { api, setBanner, idleNote } from './api.js';
import * as board from './board.js';
import * as panels from './panels.js';
import * as consolePanel from './console.js';
import * as machine from './machine.js';

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

async function loadRecord(record, note){
  const previous = S.record;
  S.record = record;
  if (!(await refresh(null, note))) S.record = previous;
}

function stepTo(delta){
  if (S.busy || !S.meta) return;
  const list = S.meta.my_steps, i = list.indexOf(S.snap.step);
  const next = list[i + delta];
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

/* ---------- 窄屏操作条：同功能、独立 id，转发到主热区 ---------- */
const touchbar = $('touchbar');
touchbar.addEventListener('click', e => {
  const b = e.target.closest('button[data-control]');
  if (!b) return;
  const main = $(b.dataset.control);
  if (main && !main.disabled) main.click();
});
const touchButtons = [...touchbar.querySelectorAll('button[data-control]')];
const syncTouch = () => {
  for (const b of touchButtons){
    const main = $(b.dataset.control);
    b.disabled = !main || main.disabled || machine.machineStatus().status !== 'ready';
  }
};
new MutationObserver(syncTouch).observe($('controls'), {
  subtree: true, attributes: true, attributeFilter: ['disabled'],
});
setInterval(syncTouch, 300);

/* ---------- 屏幕里点牌 / 拖牌 = 选牌 ---------- */
let draggingCard = false;
const cardAt = e => {
  const r = $('scene').getBoundingClientRect();
  return machine.pickCardAt(e.clientX - r.left, e.clientY - r.top);
};
$('stage').addEventListener('pointerdown', e => {
  if (e.target.closest('button')) return;
  const i = cardAt(e);
  if (i === null) return;
  draggingCard = true;
  consolePanel.toggleCard(i);
  e.preventDefault();
});
$('stage').addEventListener('pointermove', e => {
  if (!draggingCard) return;
  const i = cardAt(e);
  if (i !== null) consolePanel.addCard(i);
});
addEventListener('pointerup', () => { draggingCard = false; });
addEventListener('pointercancel', () => { draggingCard = false; });
addEventListener('keydown', e => {
  const t = document.activeElement.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') stepTo(-1);
  else if (e.key === 'ArrowRight') stepTo(1);
});

async function boot(){
  board.init();
  consolePanel.init({ refresh, mutate, renderBar: board.renderBar });
  syncTouch();
  try {
    const [config, d] = await Promise.all([api('/api/config'), api('/api/demo')]);
    S.config = config;
    S.metrics = d.metrics; S.calibration = d.calibration; S.caveat = d.caveat;
    await loadRecord(d.record, '演示局：随机自对弈的一局。点「开新局」录自己的牌局，或「打开记录」。');
  } catch (err){
    setBanner(err.message, 'error');
  }
}

boot();
