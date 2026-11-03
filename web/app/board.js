// 牌桌：三个座位、上一手、以及"我方出牌机会"的切换条。
// 今天用 HTML 画；3D 场景会在这一层里换掉它。

import { S, $ } from './state.js';
import { NAME, label, identityLabel, isMe, turnText, overText, card, back } from './labels.js';

function seat(player){
  const v = S.snap;
  const mine = isMe(player);
  const seat = S.meta.seats[player];
  const remaining = v.remaining[player];
  const played = v.played[player] || [];
  const acting = !v.finished && v.acting === player;

  let hand;
  if (mine){
    hand = (v.my_hand || []).map(card).join('');
  } else {
    const shown = Math.min(remaining, 14);
    hand = back().repeat(shown)
         + (remaining > shown ? `<i class="more">+${remaining-shown}</i>` : '');
  }
  return `<div class="seat${mine?' is-me':''}${acting?' is-acting':''}">
    <div class="seat-head"><b>${label(player)}</b>
      <span class="badge ${seat.identity}">${identityLabel(player)}</span>
      ${acting?`<span class="turn-flag">▶ ${mine?'该你出':'该他出'}</span>`:''}
      <span class="cnt">${remaining} 张</span></div>
    <div class="seat-hand">${hand}</div>
    <div class="seat-played">已出：${played.length ? played.map(x => NAME[x] || x).join(' ') : '—'}</div>
  </div>`;
}

/** 抬头：说明"现在看的是哪一手、我方是谁"。
 *  全局手数是记录里的序号，留作对齐记录用；面向人的主标识是"我的第几次出牌机会"。 */
function renderWho(){
  const m = S.meta, v = S.snap;
  const latest = v.step === m.total_steps;
  const k = m.my_steps.indexOf(v.step);
  $('who').textContent = `${m.record_id} · ${m.source} · 全局第 ${v.step}/${m.total_steps} 手`
    + (k >= 0 ? ` · 我的第 ${k + 1} 次出牌机会` : '')
    + ` · 我方是${identityLabel(m.me)}`
    + (v.finished ? ` · ${overText(v.winner)}` : '');
  $('tool-note').textContent = latest ? '' : '· 看历史局面时不能续录';
}

export function render(){
  renderWho();
  const v = S.snap, me = S.meta.me;
  const trick = v.last_move.length
    ? v.last_move.map(card).join('')
    : '<span class="lbl">自由领出</span>';
  const mine = v.acting === me;

  // 座位位置也跟着以我方为参照：两个对手在上，我在下（我的牌摊在面前）
  const others = Object.keys(S.meta.seats).filter(p => p !== me)
    .sort((a, b) => ((S.meta.seats[a].relative === 'up') ? 0 : 1)
                  - ((S.meta.seats[b].relative === 'up') ? 0 : 1));

  $('board').innerHTML =
    `<div class="seat-row">${others.map(seat).join('')}</div>`
    + `<div class="board-mid">
         <div class="trick"><span class="lbl">上一手</span>${trick}</div>
         <div class="turn${mine?'':' none'}">${v.finished ? overText(v.winner) : turnText(v.acting)}</div>
       </div>`
    + seat(me)
    + `<div class="replay"><span class="lbl">我的出牌机会</span>`
    + `<div class="steps" id="steps">${(S.meta.my_steps || []).map((st, i) =>
        `<button type="button" data-step="${st}" title="全局第 ${st} 手" `
        + `aria-current="${st === v.step}">第 ${i + 1} 次</button>`
      ).join('')}</div><span class="lbl">← → 切换</span></div>`;
}
