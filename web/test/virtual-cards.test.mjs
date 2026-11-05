// 展示层虚拟牌身份的单测：纯算法 + 会话内顺序（SESSION），不碰 DOM。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SUITS, rankSuits, suitOf, handCards, trickCards, isMyTrick, rankCounts,
  isRedSuit, commitPlay, resetSession,
} from '../app/virtual-cards.js';

const RANKS = ['3','4','5','6','7','8','9','T','J','Q','K','A','2'];

test('每个点数的四张牌花色互不相同', () => {
  for (const id of ['r1', 'demo-7', '']) {
    for (const rank of RANKS) {
      const four = [0, 1, 2, 3].map(k => suitOf(id, rank, k));
      assert.equal(new Set(four).size, 4, `${id}/${rank} 出现重复花色: ${four}`);
      assert.deepEqual([...four].sort(), [...SUITS].sort());
    }
  }
});

test('同一 record_id 两次算出同一套花色', () => {
  for (const rank of RANKS) {
    assert.deepEqual(rankSuits('fixed-id', rank), rankSuits('fixed-id', rank));
  }
  const a = handCards('fixed-id', ['5', '5', '5', 'K']);
  const b = handCards('fixed-id', ['5', '5', '5', 'K']);
  assert.deepEqual(a, b);
});

test('不同 record_id 会洗出不同排列（至少一个点数不同）', () => {
  const differs = RANKS.some(r => rankSuits('id-a', r).join('') !== rankSuits('id-b', r).join(''));
  assert.ok(differs, '不同 seed 应该至少有一个点数排列不同');
});

test('整局 54 张：(点数, 花色) 组合零重复，大小王各一张', () => {
  const deck = [];
  for (const rank of RANKS){
    for (let k = 0; k < 4; k++){
      deck.push(`${rank}${suitOf('full-deck', rank, k)}`);
    }
  }
  deck.push('B', 'R');                          // 大小王无花色
  assert.equal(deck.length, 54);
  const nonJoker = deck.filter(c => c !== 'B' && c !== 'R');
  assert.equal(new Set(nonJoker).size, nonJoker.length, '出现重复的 (点数, 花色)');
  assert.equal(deck.filter(c => c === 'B').length, 1);
  assert.equal(deck.filter(c => c === 'R').length, 1);
});

test('手牌 offset 让后出的重复点数不复用前面已发的花色', () => {
  const id = 'offset-case';
  const played = handCards(id, ['5', '5']);              // 打完两张 5
  const rest = handCards(id, ['5', '5'], { 5: 2 });      // 手里还剩两张 5
  const four = [...played, ...rest].map(c => c.suit);
  assert.equal(new Set(four).size, 4, `四张 5 花色应互不相同: ${four}`);
});

test('大小王没有花色，红黑判定只认红桃方片', () => {
  assert.equal(suitOf('x', 'B', 0), null);
  assert.equal(suitOf('x', 'R', 0), null);
  assert.ok(isRedSuit('H') && isRedSuit('D'));
  assert.ok(!isRedSuit('S') && !isRedSuit('C'));
});

test('rankCounts 数各点数张数', () => {
  assert.deepEqual(rankCounts(['5', '5', 'K', '5']), { 5: 3, K: 1 });
  assert.deepEqual(rankCounts(), {});
});

// 一张正面牌的样子 = 角标（点数 + 花色）。手牌和出牌区是同时看得见的两处，
// 同点数的牌在前者与后者的花色必须互不相同，这是「发牌一致性」在屏幕上的落点。
const visibleSuits = (id, hand, playedCounts, trick, mine = false) => [
  ...handCards(id, hand, playedCounts), ...trickCards(id, trick, playedCounts, mine),
];

test('手牌与出牌区里同点数的牌花色互不相同', () => {
  for (const mine of [true, false]) {
    // 最坏情况：我手里还有 5，出牌区也是两张 5（别人打的，或我刚打的）
    const counts = mine ? { 5: 2 } : {};
    const shown = visibleSuits('clash', ['5', '5', 'K'], counts, ['5', '5'], mine);
    const four = shown.filter(c => c.rank === '5').map(c => c.suit);
    assert.equal(four.length, 4);
    assert.equal(new Set(four).size, 4, `四张 5 花色应互不相同: ${four}`);
  }
});

test('手牌与出牌区的（点数, 花色）在整屏可见牌里零重复', () => {
  const hand = ['3', '3', '7', 'J', 'J', 'J', '2', 'B', 'R'];
  const trick = ['7', '7', 'J'];
  const shown = visibleSuits('screen', hand, { 7: 1, J: 1 }, trick, true);
  const key = c => `${c.rank}${c.suit ?? ''}`;
  assert.equal(new Set(shown.map(key)).size, shown.length, `可见牌重了: ${shown.map(key)}`);
  // 王不参与花色，只有一张小/大
  assert.deepEqual(shown.filter(c => c.suit === null).map(c => c.rank), ['B', 'R']);
});

test('不是我打的那一手拿尾部花色，不占我手牌那几张的号', () => {
  const id = 'tail-trick';
  const hand = handCards(id, ['9', '9']);
  const trick = trickCards(id, ['9', '9'], {}, false);
  assert.deepEqual(trick.map(c => c.suit), rankSuits(id, '9').slice(2));
  assert.equal(new Set([...hand, ...trick].map(c => c.suit)).size, 4);
});

test('我打出靠左的几张后，剩下手牌的花色不跳，出牌区接着那几张的花色', () => {
  const id = 'my-trick';
  const before = handCards(id, ['5', '5', '5'], {});        // 出牌前：三张 5
  const after = handCards(id, ['5'], { 5: 2 });            // 打掉靠左两张后
  assert.deepEqual(after.map(c => c.suit), [before[2].suit]);
  const trick = trickCards(id, ['5', '5'], { 5: 2 }, true);
  assert.deepEqual(trick.map(c => c.suit), [before[0].suit, before[1].suit]);
});

test('isMyTrick 只看我出牌记录的尾部', () => {
  assert.ok(isMyTrick(['3', '5', '5'], ['5', '5']));
  assert.ok(!isMyTrick(['3', '5'], ['5', '5']));
  assert.ok(!isMyTrick([], ['5']));
  assert.ok(!isMyTrick(['5'], []));
});

/* ---------- #48：同一张虚拟牌从手牌跟到出牌区 ---------- */

test('点出去的那张牌，花色跟着走进出牌区，手里的牌不跳', () => {
  const id = 'follow-my-card';
  resetSession();
  const hand = ['5', '5', '5'];
  const before = handCards(id, hand, {});                 // 出牌前三个花色各就各位
  commitPlay(id, hand, {}, new Set([1]));                 // 点的是中间那张
  const after = handCards(id, ['5', '5'], { 5: 1 });
  const trick = trickCards(id, ['5'], { 5: 1 }, true);
  assert.deepEqual(trick.map(c => c.suit), [before[1].suit], '出牌区要显示点到的那张');
  assert.deepEqual(after.map(c => c.suit), [before[0].suit, before[2].suit], '没点的牌花色不许跳');
});

test('一次点出同点数多张，花色也整组跟着走', () => {
  const id = 'follow-many';
  resetSession();
  const hand = ['5', '5', '5', '5'];
  const before = handCards(id, hand, {});
  commitPlay(id, hand, {}, new Set([0, 3]));               // 点第一张和最后一张
  const after = handCards(id, ['5', '5'], { 5: 2 });
  const trick = trickCards(id, ['5', '5'], { 5: 2 }, true);
  assert.deepEqual(trick.map(c => c.suit).sort(), [before[0].suit, before[3].suit].sort());
  assert.deepEqual(after.map(c => c.suit), [before[1].suit, before[2].suit]);
  const four = [...after, ...trick].map(c => c.suit);
  assert.equal(new Set(four).size, 4, `四张 5 的花色应互不相同: ${four}`);
});

test('点过牌以后，手牌与出牌区的（点数, 花色）仍零重复', () => {
  const id = 'no-dup-after-click';
  resetSession();
  const hand = ['7', '7', '7', 'J', 'J'];
  const before = handCards(id, hand, {});
  commitPlay(id, hand, {}, new Set([0, 2, 3]));            // 点两张 7 和一张 J
  const after = handCards(id, ['7', 'J'], { 7: 2, J: 1 });
  const trick = trickCards(id, ['7', '7', 'J'], { 7: 2, J: 1 }, true);
  const shown = [...after, ...trick];
  const key = c => `${c.rank}${c.suit}`;
  assert.equal(new Set(shown.map(key)).size, shown.length, `可见牌重了: ${shown.map(key)}`);
  assert.deepEqual(trick.filter(c => c.rank === '7').map(c => c.suit).sort(),
                   [before[0].suit, before[2].suit].sort());
});

test('提交失败能撤回：会话回到点牌之前', () => {
  const id = 'rollback';
  resetSession();
  const hand = ['9', '9'];
  const before = handCards(id, hand, {});
  const undo = commitPlay(id, hand, {}, new Set([1]));
  undo();
  assert.deepEqual(handCards(id, hand, {}).map(c => c.suit), before.map(c => c.suit));
});

test('刷新页面（会话清空）后按 record_id 确定性重推', () => {
  const id = 'refresh-redo';
  const hand = ['7', '7', 'K'];
  const fresh = handCards(id, hand, {});
  commitPlay(id, hand, {}, new Set([1]));
  resetSession();                                          // 刷新 = 模块状态没了
  assert.deepEqual(handCards(id, hand, {}).map(c => c.suit), fresh.map(c => c.suit));
});
