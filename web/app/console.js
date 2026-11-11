// 操作台：开局的面板 + 录一手的动作。
// 选牌现在发生在**屏幕里的牌桌上**（点/拖），这里只管把选中态拼成请求；
// 合法性仍由服务端判（ADR-0001）。

import { S, SEL, PAD, $ } from './state.js';
import { RANKS, NAME, card, countIn, actorName, identityLabel, turnText, overText } from './labels.js';
import { setBanner } from './api.js';
import { rankCounts, commitPlay as commitSessionPlay } from './virtual-cards.js';
import * as machine from './machine.js';
import { pulseDesk } from './deskbg.js';

let deps = { refresh: async () => {}, mutate: async () => false, renderBar: () => {} };
let hintIndex = -1;   // 推荐键在候选里循环

// 点候选出牌时背景也掀一圈涟漪：鼠标/触摸用真实点，键盘激活退回按钮中心
function rippleAt(el, e){
  if (e.clientX || e.clientY) return pulseDesk(e.clientX, e.clientY);
  const r = el.getBoundingClientRect();
  pulseDesk(r.left + r.width / 2, r.top + r.height / 2);
}

/** 牌池里每个点数还剩几张。数据来自后端，页面不自己数。 */
const poolCounts = () => (S.snap && S.snap.pool_counts) || {};

/** 对手回合：这一刻录的是他出的牌，牌池里凑不出来的点数不可能是他出的。
    牌池上限是页面唯一被允许施加的约束（ADR-0001），所以拦在提交之前 —— 别把
    这一手发出去、等后端回一句"这些牌已经出过了"（那多半是我自己的牌被点进来了）。
    返回「超出的牌面计数」，没有超出就是 null。 */
function beyondPool(){
  if (!S.snap || S.snap.acting === S.snap.me) return null;
  const pool = poolCounts(), over = {};
  for (const r of new Set(SEL.play)){
    const n = countIn(SEL.play, r) - (pool[r] || 0);
    if (n > 0) over[r] = n;
  }
  return Object.keys(over).length ? over : null;
}

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
  // 整副牌张数、手牌张数与合法性由服务端裁定；这里只把输入转成牌面字符。
  return {cards: out};
}
const latestView = () => S.snap.step === S.meta.total_steps;

/** 开局面板要的张数来自后端；配置未到时不许开局。 */
const openingHandSizes = () => (S.config && S.config.opening_hand_sizes) || {};
const needFor = me => openingHandSizes()[me];
const cardLimit = rank => (rank === 'B' || rank === 'R') ? 1 : 4;

/* 身份只有「地主 / 农民」；是农民时还要指定地主在我上家还是下家。
   两者合起来才是记录层的座位名 —— 出手顺序是领域知识，别在页面里推。 */
const chosenRole = () => $('new-role').querySelector('.seg.is-on').dataset.role;
const chosenPos = () => $('new-pos').querySelector('.seg.is-on').dataset.pos;
const currentMe = () => (chosenRole() === 'landlord' ? 'landlord' : chosenPos());

/* ---------- 选中的是「哪几张牌」 ----------
   SEL.play 是按点数记的序列（发给后端、画在操作台），但屏幕上的点/滑必须
   记住「具体哪一张」，否则同点数的几张牌没法各自反转 —— 滑过三张已选中的 5
   只会取消第一张。所以这里额外用下标集合记身份，再回填 SEL.play。 */
const pickedIdx = new Set();

/** 外部直接改了 SEL.play（推荐 / 十字键 / 回放 / 清空）后，把身份对齐到前几张同点数牌。 */
export function adoptPlay(){
  const hand = (S.snap && S.snap.my_hand) || [];
  const left = {};
  for (const r of SEL.play) left[r] = (left[r] || 0) + 1;
  pickedIdx.clear();
  for (let i = 0; i < hand.length; i++){
    const r = hand[i];
    if (left[r] > 0){ left[r] -= 1; pickedIdx.add(i); }
  }
}
/** 以身份集合为准重建 SEL.play（按手牌顺序，等价于按点数从小到大）。 */
function commitPlay(){
  const hand = (S.snap && S.snap.my_hand) || [];
  SEL.play = [...pickedIdx].sort((a, b) => a - b).map(i => hand[i]).filter(Boolean);
}
/** 把选中的那几张牌在 3D 里抬起来。 */
export function syncPicked(){ machine.setSelected(pickedIdx); }

/** 屏幕里点到了我的第 index 张牌：反转它的选中状态。 */
export function toggleCard(index){
  const hand = (S.snap && S.snap.my_hand) || [];
  if (!hand[index]) return;
  if (pickedIdx.has(index)) pickedIdx.delete(index);
  else pickedIdx.add(index);
  commitPlay(); syncPicked(); renderPlay();
}

/** 出牌前把「点的是哪张」记进会话：花色要跟着那张牌走进出牌区（#48）。
    返回撤回函数 —— 服务端不认这一手时把它调回来，一次失败的提交不至于带偏会话。 */
function rememberPlay(player){
  if (player !== S.snap.me || !pickedIdx.size) return () => {};
  const played = (S.snap.played || {})[S.snap.me] || [];
  return commitSessionPlay(S.record.record_id, S.snap.my_hand || [], rankCounts(played), pickedIdx);
}

const cardSuitOrder = r => RANKS.indexOf(r);
const sortPicked = () => SEL.play.slice().sort((a, b) => cardSuitOrder(a) - cardSuitOrder(b));
/* 牌片按显示顺序对应的「具体哪一张」：同点数按手牌下标排，与 sortPicked() 的稳定排序一致。
   删牌片时按它删，不能再用 adoptPlay() 按点数前几张重排 —— 那会把同点数的身份挪回第一张（#48 评审）。 */
const sortedPickedIdx = () => {
  const hand = (S.snap && S.snap.my_hand) || [];
  return [...pickedIdx].sort((a, b) =>
    cardSuitOrder(hand[a]) - cardSuitOrder(hand[b]) || a - b);
};

/* ---------- 开局面板（保留原来的牌盘） ---------- */
function renderNew(){
  $('new-pos').hidden = chosenRole() === 'landlord';
  const need = needFor(currentMe());
  $('new-count').textContent = need === undefined
    ? '手牌 ? · 底牌 ?/3'
    : `手牌 ${SEL.hand.length}/${need} · 底牌 ${SEL.cards.length}/3`;
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
    const spent = n >= cardLimit(r);
    return `<button type="button" data-key="${r}" class="${n ? 'has' : ''}${spent ? ' spent' : ''}">${NAME[r]}`
         + (n ? `<sup>${n}</sup>` : '') + '</button>';
  }).join('');
  $('tgt-hand').classList.toggle('is-on', PAD.target === 'hand');
  $('tgt-cards').classList.toggle('is-on', PAD.target === 'cards');
  const ok = need !== undefined && SEL.hand.length === need && SEL.cards.length === 3;
  $('new-go').disabled = !ok;
  $('new-hint').className = 'hint' + (ok ? '' : ' warn');
  $('new-hint').textContent = ok
    ? '可以开局了。'
    : `点下面的牌加进「${PAD.target === 'hand' ? '手牌' : '底牌'}」，或在右边粘贴牌照串后点「识别」。`;
}

/* ---------- 录一手 ---------- */
/**
 * 我的手牌在平面上的可读副本；3D 那张牌负责点选，这一份负责「逐张认得出」。
 * 宽屏挂在操作台里（#handline），窄屏挂在机身下方常驻（#handstrip）——
 * 同一份数据、同一套点击口径，两边不会各说各话。
 */
function renderHandline(){
  const hand = (S.snap && S.snap.my_hand) || [];
  const html = `<span class="lb">我的牌（${hand.length} 张）</span>`
    + hand.map((r, i) =>
        `<i data-hand="${i}" class="${pickedIdx.has(i) ? 'is-picked' : ''}"`
        + ` title="第 ${i + 1} 张">${NAME[r] || r}</i>`).join('');
  for (const id of ['handline', 'handstrip']){
    const el = $(id);
    if (el) el.innerHTML = html;
  }
}

function renderPlay(){
  const v = S.snap, m = S.meta;
  const latest = latestView();
  const mine = v.acting === v.me;
  const over = Boolean(v.finished);          // 有人出完了：这不是"该谁出牌"，是终局
  $('play-who').textContent = over ? overText(v.winner) : turnText(v.acting);
  $('play-count').textContent = SEL.play.length ? `本手 ${SEL.play.length} 张` : '';
  chips($('play-chips'), sortPicked(), '在屏幕里点牌来选择；选中的牌会抬起来');
  renderHandline();

  $('play-go').disabled = over || !latest || !SEL.play.length;
  $('play-pass').disabled = over || !latest;
  $('play-clear').disabled = !SEL.play.length;   // 清空只管选牌，历史局面也能用
  const hasMyPoint = Boolean(mine && S.point && S.point.mine && S.point.actions.length);
  $('play-hint-btn').disabled = !hasMyPoint;
  // 出牌机会切换：操作台最左的箱子与握把上的 ←/→ 同源（都是回放）
  const steps = m.my_steps, at = steps.indexOf(v.step);
  const canPrev = steps.some(st => st < v.step), canNext = steps.some(st => st > v.step);
  $('dpad-left').disabled = !canPrev;
  $('dpad-right').disabled = !canNext;
  $('step-prev').disabled = !canPrev;
  $('step-next').disabled = !canNext;
  $('step-now').textContent = at >= 0
    ? `第 ${at + 1} / ${steps.length} 次`
    : `第 ${v.step} / ${m.total_steps} 手`;
  $('step-cell').classList.toggle('is-history', !latest);

  const picks = hasMyPoint ? S.point.actions.slice(0, 6) : [];
  $('play-picks').innerHTML = picks.map((a,i)=>
    `<button type="button" data-pick="${i}"${latest && !over ? '' : ' disabled'}>` +
    `<span>${a.label}</span>` +
    `<span class="sc">${Math.round(a.probability * 100)}%</span></button>`).join('');
  $('play-picks').dataset.json = JSON.stringify(picks);
  $('play-picks').hidden = !picks.length;

  // 录对手的牌：对手的牌是背面，只能从他还没现身的点数里点
  const oppTurn = latest && !over && !mine;
  $('opp-cell').hidden = !oppTurn;
  $('deckbar').classList.toggle('is-opp-turn', oppTurn);
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
    $('play-hint').textContent = '这些是模型动作选择概率（Q 值经 T=1 softmax，所有合法动作合计 100%）。点一下记下这一手，或在屏幕里自己点牌。';
  } else {
    $('play-hint').textContent = `${actorName(v.acting)}出的牌在屏幕里点出来；他没有出就按「不要」。`
      + (mine ? '' : '这一刻录的是他的牌：牌池里凑不出来的点数，会在「出牌」时被拦下。');
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

export function render(){ adoptPlay(); renderNew(); renderPlay(); syncPicked(); }

export function showNewPanel(){ $('newgame').classList.add('is-open'); renderNew(); }
export function hideNewPanel(){ $('newgame').classList.remove('is-open'); }
export function isNewPanelOpen(){ return $('newgame').classList.contains('is-open'); }


export function init(dependencies){
  deps = Object.assign({}, deps, dependencies);

  /* ---------- 开局 ---------- */
  $('new-role').addEventListener('click', e => {
    const b = e.target.closest('button[data-role]'); if (!b) return;
    $('new-role').querySelectorAll('.seg').forEach(el => el.classList.toggle('is-on', el === b));
    SEL.hand = []; renderNew();
  });
  $('new-pos').addEventListener('click', e => {
    const b = e.target.closest('button[data-pos]'); if (!b) return;
    $('new-pos').querySelectorAll('.seg').forEach(el => el.classList.toggle('is-on', el === b));
    renderNew();
  });
  $('tgt-hand').addEventListener('click', () => { PAD.target = 'hand'; renderNew(); });
  $('tgt-cards').addEventListener('click', () => { PAD.target = 'cards'; renderNew(); });
  $('new-clear').addEventListener('click', () => {
    SEL.hand = []; SEL.cards = []; PAD.target = 'hand'; renderNew();
  });
  $('new-keys').addEventListener('click', e => {
    const b = e.target.closest('button[data-key]'); if (!b) return;
    const r = b.dataset.key;
    const limit = cardLimit(r);
    if (countIn(SEL.hand, r) + countIn(SEL.cards, r) >= limit){
      setBanner(`${NAME[r]} 一副牌只有 ${limit} 张。`, 'error'); return;
    }
    SEL[PAD.target].push(r);
    const need = needFor(currentMe());
    if (PAD.target === 'hand' && need !== undefined && SEL.hand.length >= need) PAD.target = 'cards';
    renderNew();
  });
  $('new-chips').addEventListener('click', e => {
    const s = e.target.closest('[data-drop]'); if (!s) return;
    SEL[s.dataset.zone].splice(Number(s.dataset.drop), 1);
    renderNew();
  });
  $('new-go').addEventListener('click', async () => {
    const me = currentMe();
    const ok = await deps.mutate('/api/game/new',
      {me, my_hand: SEL.hand.join(''), landlord_cards: SEL.cards.join('')},
      `已开局：我方是${identityLabel(me)}。`);
    if (ok){ hideNewPanel(); SEL.hand = []; SEL.cards = []; }
  });

  $('new-paste-go').addEventListener('click', () => {
    const res = parseCards($('new-paste').value);
    if (res.error){ setBanner(res.error, 'error'); $('new-hint').className = 'hint warn';
      $('new-hint').textContent = res.error; return; }
    const need = PAD.target === 'hand' ? needFor(currentMe()) : 3;
    if (need === undefined || res.cards.length > need){
      const msg = `${PAD.target === 'hand' ? '手牌' : '底牌'}只需要 ${need} 张，你粘了 ${res.cards.length} 张。`;
      setBanner(msg, 'error'); $('new-hint').className = 'hint warn'; $('new-hint').textContent = msg;
      return;
    }
    SEL[PAD.target] = res.cards.slice();
    // 手牌满了就自动切到底牌，省一次点击
    if (PAD.target === 'hand' && need !== undefined && SEL.hand.length >= need) PAD.target = 'cards';
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
    SEL.play.push(r); adoptPlay(); renderPlay();
  });
  $('play-chips').addEventListener('click', e => {
    const s = e.target.closest('[data-drop]'); if (!s) return;
    const idx = sortedPickedIdx()[Number(s.dataset.drop)];
    if (idx !== undefined) pickedIdx.delete(idx);
    commitPlay(); syncPicked(); renderPlay();
  });
  $('play-clear').addEventListener('click', () => { SEL.play = []; adoptPlay(); syncPicked(); renderPlay(); });
  // 平面手牌条点一下 = 点屏幕上那张牌：宽屏副本与窄屏常驻条共用一套口径
  for (const id of ['handline', 'handstrip']){
    const el = $(id);
    if (el) el.addEventListener('click', e => {
      const chip = e.target.closest('[data-hand]');
      if (chip) toggleCard(Number(chip.dataset.hand));
    });
  }
  $('play-latest').addEventListener('click', () => deps.refresh(S.meta.total_steps));

  $('play-go').addEventListener('click', async () => {
    const player = S.snap.acting, cards = sortPicked().join('');
    const beyond = beyondPool();
    if (beyond){
      const list = Object.entries(beyond).map(([r, n]) => `${NAME[r] || r}×${n}`).join('、');
      setBanner(`${list} 不在牌池里，不可能是${actorName(player)}出的 —— 先在出牌区把它们点掉。`,
                'error');
      return;
    }
    const undo = rememberPlay(player);
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards},
                          `已录：${actorName(player)} ${cards}。`)){
      SEL.play = []; adoptPlay(); syncPicked();
    } else undo();
  });
  $('play-pass').addEventListener('click', async () => {
    const player = S.snap.acting;
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards:''},
                          `已录：${actorName(player)} 不要。`)){
      SEL.play = []; adoptPlay(); syncPicked();
    }
  });
  // 推荐键：每按一次换到下一个候选，并把那一手选到桌上。
  // 每一次按下去都要有看得见的反馈 —— 尤其是推荐「不出」时桌上什么都不变，
  // 只改提示文字会被当成"按钮坏了"。
  $('play-hint-btn').addEventListener('click', () => {
    // 推荐只对我方回合有意义：轮到对手出牌时点它，会把对手的一手记成我的
    const acts = (S.snap.acting === S.snap.me && S.point && S.point.actions) || [];
    if (!acts.length){
      const note = '现在还没有轮到我方出牌，暂时没有可推荐的出法。';
      $('play-hint').className = 'hint warn';
      $('play-hint').textContent = note;
      setBanner(note, 'error');
      return;
    }
    const n = Math.min(acts.length, 6);
    hintIndex = ((hintIndex + 1) % n + n) % n;
    const a = acts[hintIndex];
    SEL.play = a.cards.slice();
    adoptPlay(); syncPicked(); renderPlay();
    const rec = `推荐 ${hintIndex + 1}/${n}：${a.label}`
              + `（模型动作选择概率 ${Math.round(a.probability * 100)}%）`;
    $('play-hint').className = 'hint';
    $('play-hint').textContent = rec;
    setBanner(a.cards.length
      ? `${rec}。已经选到桌上，按「出牌」记下这一手。`
      : `${rec}。这一手模型建议不出，按「不要」记下。`, 'hint');
  });
  $('play-picks').addEventListener('click', async e => {
    const b = e.target.closest('button[data-pick]'); if (!b) return;
    const a = JSON.parse($('play-picks').dataset.json || '[]')[Number(b.dataset.pick)];
    if (!a) return;
    rippleAt(b, e);
    const player = S.snap.acting;
    if (await deps.mutate('/api/game/step', {record:S.record, player, cards:a.cards.join('')},
                          `已录：${actorName(player)} ${a.cards.length ? a.cards.join('') : '不要'}。`)){
      SEL.play = []; adoptPlay(); syncPicked();
    }
  });

  /* ---------- 十字键 ---------- */
  // 当前位置可能不是"我方出牌机会"（录完一手落在最新局面就是），
  // 所以按方向找最近的一个机会，而不是只认 indexOf —— 否则按钮亮着却点不动。
  const stepTo = delta => {
    const list = S.meta.my_steps, cur = S.snap.step;
    const next = delta < 0
      ? [...list].reverse().find(st => st < cur)
      : list.find(st => st > cur);
    if (next !== undefined) deps.refresh(next);
  };
  $('dpad-left').addEventListener('click', () => stepTo(-1));
  $('dpad-right').addEventListener('click', () => stepTo(1));
  $('step-prev').addEventListener('click', () => stepTo(-1));
  $('step-next').addEventListener('click', () => stepTo(1));
  const setBar = mode => { S.barMode = mode; deps.renderBar(); renderPlay(); };
  // 机身右侧实体 BackKey：点一下就换屏（记牌 ↔ 出牌概率）
  $('bar-mode').addEventListener('click', () => setBar(S.barMode === 'prob' ? 'count' : 'prob'));
}
