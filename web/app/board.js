// 牌桌：三个座位、上一手、以及"我方出牌机会"的切换条。
// 今天用 HTML 画；3D 场景会在这一层里换掉它。

import { S, $ } from './state.js';
import { NAME, label, card, back } from './labels.js';

function seat(player){
  const v = S.snap, isMe = player === S.meta.me;
  const remaining = v.remaining[player];
  const played = v.played[player] || [];
  const acting = v.acting === player;

  let hand;
  if (isMe){
    hand = (v.my_hand || []).map(card).join('');
  } else {
    const shown = Math.min(remaining, 14);
    hand = back().repeat(shown)
         + (remaining > shown ? `<i class="more">+${remaining-shown}</i>` : '');
  }
  return `<div class="seat${isMe?' is-me':''}${acting?' is-acting':''}">
    <div class="seat-head"><b>${label(player)}</b>${isMe?'<em>我</em>':''}
      ${acting?'<span class="turn-flag">▶ 该他出</span>':''}
      <span class="cnt">${remaining} 张</span></div>
    <div class="seat-hand">${hand}</div>
    <div class="seat-played">已出：${played.length ? played.map(x => NAME[x] || x).join(' ') : '—'}</div>
  </div>`;
}

/** 抬头：说明"现在看的是哪一手、我方是谁"。 */
function renderWho(){
  const m = S.meta, v = S.snap;
  const latest = v.step === m.total_steps;
  $('who').textContent = `${m.record_id} · ${m.source} · 第 ${v.step} 手`
    + `${latest ? '（最新）' : `（历史，共 ${m.total_steps} 手）`} · 我方 ${label(m.me)}`;
  $('tool-note').textContent = latest ? '' : '· 看历史局面时不能续录';
}

export function render(){
  renderWho();
  const v = S.snap;
  const trick = v.last_move.length
    ? v.last_move.map(card).join('')
    : '<span class="lbl">自由领出</span>';
  const mine = v.acting === v.me;
  $('board').innerHTML =
    seat('landlord')
    + `<div class="board-mid">
         <div class="trick"><span class="lbl">上一手</span>${trick}</div>
         <div class="turn${mine?'':' none'}">${mine ? '轮到你出牌' : `现在该 ${label(v.acting)} 出牌`}</div>
       </div>`
    + `<div class="seat-row">${seat('landlord_down')}${seat('landlord_up')}</div>`
    + `<div class="replay"><span class="lbl">我方决策点</span>`
    + `<div class="steps" id="steps">${(S.meta.my_steps || []).map(st =>
        `<button type="button" data-step="${st}" aria-current="${st === v.step}">${st}</button>`
      ).join('')}</div><span class="lbl">← → 切换</span></div>`;
}
