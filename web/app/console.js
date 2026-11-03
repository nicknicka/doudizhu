// 操作台：开局的牌盘、录一手的牌盘与动作按钮。
// 它只负责"把用户点的牌收上来、拼成请求"，合法性由服务端判。

import { S, SEL, PAD, $ } from './state.js';
import { RANKS, NAME, card, countIn, actorName, identityLabel, turnText, overText } from './labels.js';
import { setBanner } from './api.js';

let deps = { refresh: async () => {}, mutate: async () => false };

/**
 * 牌盘。``capOf(点数)`` 给出这个点数最多还能选几张 —— 开局是一副牌的 4 张，
 * 录一手是牌池里还剩几张。到顶的键标成 spent，点了会说明原因。
 * 张数做成上标：点数与张数是两件事，别挤在同一行同样大小。
 */
function keypad(host, sel, capOf, disabled){
  host.innerHTML = RANKS.map(r => {
    const n = countIn(sel, r);
    const spent = capOf ? n >= capOf(r) : false;
    return `<button type="button" data-key="${r}"${disabled ? ' disabled' : ''}`
         + ` class="${n ? 'has' : ''}${spent ? ' spent' : ''}">${NAME[r]}`
         + (n ? `<sup>${n}</sup>` : '') + '</button>';
  }).join('');
}

/** 牌池里每个点数还剩几张。数据来自后端，页面不自己数。 */
const poolCounts = () => (S.snap && S.snap.pool_counts) || {};

function chips(host, sel, emptyText){
  host.innerHTML = sel.length
    ? sel.map((c,i) => `<span data-drop="${i}">${card(c)}</span>`).join('')
    : `<span class="empty">${emptyText}</span>`;
}

/* ---------- 粘贴牌串：只识别牌面，不判牌型 ---------- */
const ALIAS_2 = {'小王': 'B', '大王': 'R', '10': 'T'};
function parseCards(str){
  const out = [];
  const seq = (str || '').replace(/[\s,，、|·]/g, '');
  for (let i = 0; i < seq.length;){
    const two = seq.slice(i, i + 2);
    if (ALIAS_2[two]){ out.push(ALIAS_2[two]); i += 2; continue; }
    const ch = seq[i];
    if ('3456789'.includes(ch) || ch === '2'){ out.push(ch); i += 1; continue; }
    const up = ch.toUpperCase();
    if ('TJQKA'.includes(up)){ out.push(up); i += 1; continue; }
    if (up === 'B' || ch === '小'){ out.push('B'); i += 1; continue; }
    if (up === 'R' || ch === '大'){ out.push('R'); i += 1; continue; }
    return {error: `看不懂这个字：${ch}`};
  }
  const over = Object.entries(out.reduce((m, r) => (m[r] = (m[r] || 0) + 1, m), {}))
    .find(([, n]) => n > 4);
  if (over) return {error: `${NAME[over[0]]} 一副牌只有 4 张。`};
  return {cards: out};
}

/** 开局面板要的张数来自后端；配置未到时不许开局。 */
const openingHandSizes = () => (S.config && S.config.opening_hand_sizes) || {};
const needFor = me => openingHandSizes()[me];

function renderNew(){
  const need = needFor($('new-me').value);
  $('new-count').textContent = need === undefined
    ? '手牌 ? · 底牌 ?/3'
    : `手牌 ${SEL.hand.length}/${need} · 底牌 ${SEL.cards.length}/3`;
  // 手牌与底牌放在同一行，靠 zone 区分归属；点一张拿掉一张
  $('new-chips').innerHTML =
    (SEL.hand.length
      ? SEL.hand.map((c,i)=>`<span data-zone="hand" data-drop="${i}">${card(c)}</span>`).join('')
      : '<span class="empty">手牌还没选</span>')
    + `<span class="empty" style="margin:0 10px">│</span>`
    + (SEL.cards.length
      ? SEL.cards.map((c,i)=>`<span data-zone="cards" data-drop="${i}">${card(c)}</span>`).join('')
      : '<span class="empty">底牌还没选</span>');
  keypad($('new-keys'), SEL.hand.concat(SEL.cards), () => 4);
  $('tgt-hand').classList.toggle('is-on', PAD.target === 'hand');
  $('tgt-cards').classList.toggle('is-on', PAD.target === 'cards');
  const ok = need !== undefined && SEL.hand.length === need && SEL.cards.length === 3;
  $('new-go').disabled = !ok;
  $('new-hint').className = 'hint' + (ok ? '' : ' warn');
  $('new-hint').textContent = ok
    ? '可以开局了。'
    : `点下面的牌加进「${PAD.target === 'hand' ? '手牌' : '底牌'}」；点上面的牌可以拿掉。`;
}

function renderPlay(){
  const v = S.snap, m = S.meta;
  const latest = v.step === m.total_steps;
  const mine = v.acting === v.me;
  const over = Boolean(v.finished);
  $('play-who').textContent = over ? overText(v.winner) : turnText(v.acting);
  $('play-count').textContent = SEL.play.length ? `本手 ${SEL.play.length} 张` : '';
  chips($('play-chips'), SEL.play, '点下面的牌组成这一手；不要的话直接按「不要」');
  // 历史局面下不能续录，牌盘直接停用 —— 否则上限算的是那个旧局面的牌池
  const pool = poolCounts();
  keypad($('play-keys'), SEL.play, r => pool[r] || 0, !latest || over);
  $('play-go').disabled = over || !latest || !SEL.play.length;
  $('play-pass').disabled = over || !latest;
  $('play-clear').disabled = !latest || !SEL.play.length;

  // 轮到我方、且看的是最新局面时，把模型排好序的合法动作变成"点一下就录"
  const picks = (mine && latest && !over && S.point) ? S.point.actions.slice(0, 8) : [];
  $('play-picks').innerHTML = picks.map((a,i)=>
    `<button type="button" data-pick="${i}"><span>${a.label}</span>` +
    `<span class="sc">${a.score>0?'+':''}${a.score.toFixed(3)}</span></button>`).join('');
  $('play-picks').dataset.json = JSON.stringify(picks);
  $('play-picks').hidden = !picks.length;

  $('play-latest').hidden = latest;
  $('play-hint').className = 'hint';
  if (!latest){
    $('play-hint').textContent = '你在看历史局面 —— 回到最新那一手才能继续录。';
    $('play-hint').className = 'hint warn';
  } else if (over){
    $('play-hint').textContent = '这局已经打完了 —— 局面还能看，录不了新的一手（要改就按「撤销」）。';
    $('play-hint').className = 'hint warn';
  } else if (mine && picks.length){
    $('play-hint').textContent = '这些是模型给所有合法动作排的序（Q 值，不是胜率）。点一下就把这一手记下来，也可以自己在下面点牌。';
  } else {
    $('play-hint').textContent = `${actorName(v.acting)}出的牌从下面点出来；他没有出就按「不要」。`;
  }
}

export function render(){ renderNew(); renderPlay(); }

export function showNewPanel(){ $('pad-new').hidden = false; renderNew(); }
export function hideNewPanel(){ $('pad-new').hidden = true; }
export function isNewPanelOpen(){ return !$('pad-new').hidden; }

export function init({ refresh, mutate }){
  deps = { refresh, mutate };

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
    // 手牌满了就自动把落点切到底牌，省一次点击
    const need = needFor($('new-me').value);
    if (PAD.target === 'hand' && need !== undefined && SEL.hand.length >= need) PAD.target = 'cards';
    renderNew();
  });
  $('new-chips').addEventListener('click', e => {
    const s = e.target.closest('[data-drop]'); if (!s) return;
    SEL[s.dataset.zone].splice(Number(s.dataset.drop), 1);
    renderNew();
  });
  $('new-paste-go').addEventListener('click', () => {
    const res = parseCards($('new-paste').value);
    if (res.error){
      setBanner(res.error, 'error');
      $('new-hint').className = 'hint warn';
      $('new-hint').textContent = res.error;
      return;
    }
    const need = PAD.target === 'hand' ? needFor($('new-me').value) : 3;
    if (res.cards.length > need){
      const msg = `${PAD.target === 'hand' ? '手牌' : '底牌'}只需要 ${need} 张，你粘了 ${res.cards.length} 张。`;
      setBanner(msg, 'error');
      $('new-hint').className = 'hint warn';
      $('new-hint').textContent = msg;
      return;
    }
    SEL[PAD.target] = res.cards.slice();
    if (PAD.target === 'hand' && SEL.hand.length >= need) PAD.target = 'cards';
    $('new-paste').value = '';
    renderNew();
  });
  $('new-paste').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('new-paste-go').click();
  });
  $('new-go').addEventListener('click', async () => {
    const me = $('new-me').value;
    const ok = await deps.mutate('/api/game/new',
      {me, my_hand: SEL.hand.join(''), landlord_cards: SEL.cards.join('')},
      `已开局：我方是${identityLabel(me)}。`);
    if (ok){ hideNewPanel(); SEL.hand = []; SEL.cards = []; }
  });

  /* ---------- 录一手 ---------- */
  $('play-keys').addEventListener('click', e => {
    const b = e.target.closest('button[data-key]'); if (!b) return;
    const r = b.dataset.key;
    const cap = poolCounts()[r] || 0;
    if (countIn(SEL.play, r) >= cap){
      setBanner(cap === 0
        ? `${NAME[r]} 全部现过身了（在我手上或已经打出），不可能再出。`
        : `牌池里 ${NAME[r]} 只剩 ${cap} 张。`, 'error');
      return;
    }
    SEL.play.push(r); renderPlay();
  });
  $('play-chips').addEventListener('click', e => {
    const s = e.target.closest('[data-drop]'); if (!s) return;
    SEL.play.splice(Number(s.dataset.drop), 1); renderPlay();
  });
  $('play-clear').addEventListener('click', () => { SEL.play = []; renderPlay(); });
  $('play-latest').addEventListener('click', () => deps.refresh(S.meta.total_steps));
  $('play-go').addEventListener('click', async () => {
    const player = S.snap.acting, cards = SEL.play.join('');
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards},
                          `已录：${actorName(player)} ${cards}。`)) SEL.play = [];
  });
  $('play-pass').addEventListener('click', async () => {
    const player = S.snap.acting;
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards:''},
                          `已录：${actorName(player)} 不要。`)) SEL.play = [];
  });
  $('play-picks').addEventListener('click', async e => {
    const b = e.target.closest('button[data-pick]'); if (!b) return;
    const a = JSON.parse($('play-picks').dataset.json || '[]')[Number(b.dataset.pick)];
    if (!a) return;
    const player = S.snap.acting;
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards:a.cards.join('')},
                          `已录：${actorName(player)} ${a.cards.length ? a.cards.join('') : '不要'}。`)) SEL.play = [];
  });
}
