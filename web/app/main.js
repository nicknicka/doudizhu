// 启动与串联：把取数、牌桌、面板、操作台接起来。
// 这里没有业务规则 —— 上面四个模块各管一件事。

import { S, SEL, reduce, $ } from './state.js';
import { label } from './labels.js';
import { api, setBanner, idleNote } from './api.js';
import * as board from './board.js';
import * as panels from './panels.js';
import * as consolePanel from './console.js';

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

/* ---------- 牌桌上的切换与键盘 ---------- */
$('board').addEventListener('click', e => {
  const b = e.target.closest('button[data-step]');
  if (b) refresh(Number(b.dataset.step));
});
addEventListener('keydown', e => {
  const t = document.activeElement.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') stepTo(-1);
  else if (e.key === 'ArrowRight') stepTo(1);
});

async function boot(){
  consolePanel.init({ refresh, mutate });
  try {
    const d = await api('/api/demo');
    S.metrics = d.metrics; S.calibration = d.calibration; S.caveat = d.caveat;
    await loadRecord(d.record, '演示局：随机自对弈的一局。点「开新局」录自己的牌局，或「打开记录」。');
  } catch (err){
    setBanner(err.message, 'error');
  }
}

boot();
