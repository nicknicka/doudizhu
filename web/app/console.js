// 操作台：开局的面板 + 录一手的动作。
// 选牌现在发生在**屏幕里的牌桌上**（点/拖），这里只管把选中态拼成请求；
// 合法性仍由服务端判（ADR-0001）。

import { S, SEL, PAD, NEED, $ } from './state.js';
import { RANKS, NAME, card, countIn, actorName, identityLabel, turnText, overText } from './labels.js';
import { setBanner } from './api.js';
import * as machine from './machine.js';

let deps = { refresh: async () => {}, mutate: async () => false, renderBar: () => {} };
let hintIndex = -1;   // 推荐键在候选里循环

/** 牌池里每个点数还剩几张。数据来自后端，页面不自己数。 */
const poolCounts = () => (S.snap && S.snap.pool_counts) || {};
const latestView = () => S.snap.step === S.meta.total_steps;

/** 把 SEL.play 同步到 3D 手牌的选中态（抬牌）。 */
export function syncPicked(){
  const counts = {};
  for (const r of SEL.play) counts[r] = (counts[r] || 0) + 1;
  machine.setSelected(counts);
}

/** 拖动经过某张牌时只加不删（避免来回滑时反复切换）。 */
export function addCard(index){
  const hand = (S.snap && S.snap.my_hand) || [];
  const rank = hand[index];
  if (!rank) return;
  const before = hand.slice(0, index).filter(r => r === rank).length;
  if (countIn(SEL.play, rank) > before) { /* 这张已经选中了 */ }
  else SEL.play.push(rank);
  syncPicked(); renderPlay();
}

/** 屏幕里点到了我的第 index 张牌：切换它的选中状态。 */
export function toggleCard(index){
  const hand = (S.snap && S.snap.my_hand) || [];
  const rank = hand[index];
  if (!rank) return;
  const before = hand.slice(0, index).filter(r => r === rank).length;
  if (countIn(SEL.play, rank) > before){
    const i = SEL.play.lastIndexOf(rank);
    if (i >= 0) SEL.play.splice(i, 1);
  } else {
    SEL.play.push(rank);
  }
  syncPicked(); renderPlay();
}

const cardSuitOrder = r => RANKS.indexOf(r);
const sortPicked = () => SEL.play.slice().sort((a, b) => cardSuitOrder(a) - cardSuitOrder(b));

function chips(host, sel, emptyText){
  host.innerHTML = sel.length
    ? sel.map((c, i) => `<span data-drop="${i}">${card(c)}</span>`).join('')
    : `<span class="empty">${emptyText}</span>`;
}

/* ---------- 开局面板（保留原来的牌盘） ---------- */
function renderNew(){
  const need = NEED[$('new-me').value];
  $('new-count').textContent = `手牌 ${SEL.hand.length}/${need} · 底牌 ${SEL.cards.length}/3`;
  $('new-chips').innerHTML =
    (SEL.hand.length
      ? SEL.hand.map((c,i)=>`<span data-zone="hand" data-drop="${i}">${card(c)}</span>`).join('')
      : '<span class="empty">手牌还没选</span>')
    + `<span class="empty" style="margin:0 10px">│</span>`
    + (SEL.cards.length
      ? SEL.cards.map((c,i)=>`<span data-zone="cards" data-drop="${i}">${card(c)}</span>`).join('')
      : '<span class="empty">底牌还没选</span>');
  $('new-keys').innerHTML = RANKS.map(r => {
    const n = countIn(SEL.hand, r) + countIn(SEL.cards, r);
    const spent = n >= 4;
    return `<button type="button" data-key="${r}" class="${n ? 'has' : ''}${spent ? ' spent' : ''}">${NAME[r]}`
         + (n ? `<sup>${n}</sup>` : '') + '</button>';
  }).join('');
  $('tgt-hand').classList.toggle('is-on', PAD.target === 'hand');
  $('tgt-cards').classList.toggle('is-on', PAD.target === 'cards');
  const ok = SEL.hand.length === need && SEL.cards.length === 3;
  $('new-go').disabled = !ok;
  $('new-hint').className = 'hint' + (ok ? '' : ' warn');
  $('new-hint').textContent = ok
    ? '可以开局了。'
    : `点下面的牌加进「${PAD.target === 'hand' ? '手牌' : '底牌'}」，或在右边粘贴牌照串后点「识别」。`;
}

/* ---------- 录一手 ---------- */
function renderPlay(){
  const v = S.snap, m = S.meta;
  const latest = latestView();
  const mine = v.acting === v.me;
  const over = Boolean(v.finished);          // 有人出完了：这不是"该谁出牌"，是终局
  $('play-who').textContent = over ? overText(v.winner) : turnText(v.acting);
  $('play-count').textContent = SEL.play.length ? `本手 ${SEL.play.length} 张` : '';
  chips($('play-chips'), sortPicked(), '在屏幕里点牌来选择；选中的牌会抬起来');

  $('play-go').disabled = over || !latest || !SEL.play.length;
  $('play-pass').disabled = over || !latest;
  $('play-clear').disabled = !SEL.play.length;   // 清空只管选牌，历史局面也能用
  $('play-hint-btn').disabled = !(S.point && S.point.actions.length);
  $('dpad-left').disabled = !S.meta.my_steps.some(st => st < v.step);
  $('dpad-right').disabled = !S.meta.my_steps.some(st => st > v.step);

  const picks = S.point ? S.point.actions.slice(0, 6) : [];
  $('play-picks').innerHTML = picks.map((a,i)=>
    `<button type="button" data-pick="${i}"${latest && !over ? '' : ' disabled'}>` +
    `<span>${a.label}</span>` +
    `<span class="sc">${a.score>0?'+':''}${a.score.toFixed(3)}</span></button>`).join('');
  $('play-picks').dataset.json = JSON.stringify(picks);
  $('play-picks').hidden = !picks.length;

  // 录对手的牌：对手的牌是背面，只能从他还没现身的点数里点
  const oppTurn = latest && !over && !mine;
  $('opp-cell').hidden = !oppTurn;
  if (oppTurn) keypadStub();

  $('play-latest').hidden = latest;
  $('play-hint').className = 'hint';
  if (!latest){
    $('play-hint').textContent = '你在看历史局面 —— 可以点牌试看，回到最新那一手才能录。';
    $('play-hint').className = 'hint warn';
  } else if (over){
    $('play-hint').textContent = '这局已经打完了 —— 局面还能看，录不了新的一手（要改就按「撤销」）。';
    $('play-hint').className = 'hint warn';
  } else if (mine && picks.length){
    $('play-hint').textContent = '这些是模型给所有合法动作排的序（Q 值，不是胜率）。点一下记下这一手，或在屏幕里自己点牌。';
  } else {
    $('play-hint').textContent = `${actorName(v.acting)}出的牌在屏幕里点出来；他没有出就按「不要」。`;
  }
}

function keypadStub(){
  const pool = poolCounts();
  $('play-keys').innerHTML = RANKS.map(r => {
    const n = countIn(SEL.play, r), cap = pool[r] || 0;
    const spent = n >= cap;
    return `<button type="button" data-key="${r}"${cap ? '' : ' disabled'}`
      + ` class="${n ? 'has' : ''}${spent ? ' spent' : ''}">${NAME[r]}</button>`;
  }).join('');
}

export function resetHint(){ hintIndex = -1; }

export function render(){ renderNew(); renderPlay(); syncPicked(); }

export function showNewPanel(){ $('newgame').classList.add('is-open'); renderNew(); }
export function hideNewPanel(){ $('newgame').classList.remove('is-open'); }
export function isNewPanelOpen(){ return $('newgame').classList.contains('is-open'); }

/* ---------- 粘贴牌串：直接把手牌/底牌录进来 ---------- */
const ALIAS_2 = { '小王': 'B', '大王': 'R', '10': 'T' };
function parseCards(str){
  const out = [];
  const seq = (str || '').replace(/[\s,，、|·]/g, '');
  for (let i = 0; i < seq.length; ){
    const two = seq.slice(i, i + 2);
    if (ALIAS_2[two]){ out.push(ALIAS_2[two]); i += 2; continue; }
    const ch = seq[i];
    if ('3456789'.includes(ch)){ out.push(ch); i += 1; continue; }
    if (ch === '2'){ out.push('2'); i += 1; continue; }
    const up = ch.toUpperCase();
    if ('TJQKA'.includes(up)){ out.push(up); i += 1; continue; }
    if (up === 'B' || ch === '小'){ out.push('B'); i += 1; continue; }
    if (up === 'R' || ch === '大'){ out.push('R'); i += 1; continue; }
    return { error: `看不懂这个字：${ch}` };
  }
  const over = Object.entries(out.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {}))
    .find(([, n]) => n > 4);
  if (over) return { error: `${NAME[over[0]]} 一副牌只有 4 张。` };
  return { cards: out };
}

export function init(dependencies){
  deps = Object.assign({}, deps, dependencies);

  /* ---------- 开局 ---------- */
  $('new-me').addEventListener('change', () => { SEL.hand = []; renderNew(); });
  $('tgt-hand').addEventListener('click', () => { PAD.target = 'hand'; renderNew(); });
  $('tgt-cards').addEventListener('click', () => { PAD.target = 'cards'; renderNew(); });
  $('new-clear').addEventListener('click', () => {
    SEL.hand = []; SEL.cards = []; PAD.target = 'hand'; renderNew();
  });
  $('new-keys').addEventListener('click', e => {
    const b = e.target.closest('button[data-key]'); if (!b) return;
    const r = b.dataset.key;
    if (countIn(SEL.hand, r) + countIn(SEL.cards, r) >= 4){
      setBanner(`${NAME[r]} 一副牌只有 4 张。`, 'error'); return;
    }
    SEL[PAD.target].push(r);
    if (PAD.target === 'hand' && SEL.hand.length >= NEED[$('new-me').value]) PAD.target = 'cards';
    renderNew();
  });
  $('new-chips').addEventListener('click', e => {
    const s = e.target.closest('[data-drop]'); if (!s) return;
    SEL[s.dataset.zone].splice(Number(s.dataset.drop), 1);
    renderNew();
  });
  $('new-go').addEventListener('click', async () => {
    const me = $('new-me').value;
    const ok = await deps.mutate('/api/game/new',
      {me, my_hand: SEL.hand.join(''), landlord_cards: SEL.cards.join('')},
      `已开局：我方是${identityLabel(me)}。`);
    if (ok){ hideNewPanel(); SEL.hand = []; SEL.cards = []; }
  });

  $('new-paste-go').addEventListener('click', () => {
    const res = parseCards($('new-paste').value);
    if (res.error){ setBanner(res.error, 'error'); $('new-hint').className = 'hint warn';
      $('new-hint').textContent = res.error; return; }
    const need = PAD.target === 'hand' ? NEED[$('new-me').value] : 3;
    if (res.cards.length > need){
      const msg = `${PAD.target === 'hand' ? '手牌' : '底牌'}只需要 ${need} 张，你粘了 ${res.cards.length} 张。`;
      setBanner(msg, 'error'); $('new-hint').className = 'hint warn'; $('new-hint').textContent = msg;
      return;
    }
    SEL[PAD.target] = res.cards.slice();
    // 手牌满了就自动切到底牌，省一次点击
    if (PAD.target === 'hand' && SEL.hand.length >= need) PAD.target = 'cards';
    $('new-paste').value = '';
    renderNew();
  });
  $('new-paste').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('new-paste-go').click();
  });

  /* ---------- 录一手：右侧四键 + 十字键 ---------- */
  $('play-keys').addEventListener('click', e => {
    const b = e.target.closest('button[data-key]'); if (!b) return;
    const r = b.dataset.key, cap = poolCounts()[r] || 0;
    if (countIn(SEL.play, r) >= cap){
      setBanner(cap === 0
        ? `${NAME[r]} 全部现过身了，不可能再出。`
        : `牌池里 ${NAME[r]} 只剩 ${cap} 张。`, 'error');
      return;
    }
    SEL.play.push(r); renderPlay();
  });
  $('play-chips').addEventListener('click', e => {
    const s = e.target.closest('[data-drop]'); if (!s) return;
    SEL.play.splice(Number(s.dataset.drop), 1); syncPicked(); renderPlay();
  });
  $('play-clear').addEventListener('click', () => { SEL.play = []; syncPicked(); renderPlay(); });
  $('play-latest').addEventListener('click', () => deps.refresh(S.meta.total_steps));

  $('play-go').addEventListener('click', async () => {
    const player = S.snap.acting, cards = sortPicked().join('');
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards},
                          `已录：${actorName(player)} ${cards}。`)){
      SEL.play = []; syncPicked();
    }
  });
  $('play-pass').addEventListener('click', async () => {
    const player = S.snap.acting;
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards:''},
                          `已录：${actorName(player)} 不要。`)){
      SEL.play = []; syncPicked();
    }
  });
  // 推荐键：每按一次换到下一个候选，并把那一手选到桌上
  $('play-hint-btn').addEventListener('click', () => {
    const acts = (S.point && S.point.actions) || [];
    if (!acts.length) return;
    hintIndex = (hintIndex + 1) % Math.min(acts.length, 6);
    const a = acts[hintIndex];
    SEL.play = a.cards.slice();
    syncPicked(); renderPlay();
    $('play-hint').className = 'hint';
    $('play-hint').textContent =
      `推荐 ${hintIndex + 1}/${Math.min(acts.length, 6)}：${a.label}`
      + `（Q 值 ${a.score > 0 ? '+' : ''}${a.score.toFixed(3)}，不是胜率）`;
  });
  $('play-picks').addEventListener('click', async e => {
    const b = e.target.closest('button[data-pick]'); if (!b) return;
    const a = JSON.parse($('play-picks').dataset.json || '[]')[Number(b.dataset.pick)];
    if (!a) return;
    const player = S.snap.acting;
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards:a.cards.join('')},
                          `已录：${actorName(player)} ${a.cards.length ? a.cards.join('') : '不要'}。`)){
      SEL.play = []; syncPicked();
    }
  });

  /* ---------- 十字键 ---------- */
  const stepTo = delta => {
    const list = S.meta.my_steps, i = list.indexOf(S.snap.step);
    const next = list[i + delta];
    if (next !== undefined) deps.refresh(next);
  };
  $('dpad-left').addEventListener('click', () => stepTo(-1));
  $('dpad-right').addEventListener('click', () => stepTo(1));
  const setBar = mode => { S.barMode = mode; deps.renderBar(); renderPlay(); };
  $('dpad-up').addEventListener('click', () => setBar('count'));
  $('dpad-down').addEventListener('click', () => setBar('prob'));
  // 机顶那个按钮：点一下就换屏（记牌 ↔ 出牌概率）
  $('bar-mode').addEventListener('click', () => setBar(S.barMode === 'prob' ? 'count' : 'prob'));
}
