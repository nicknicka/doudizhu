// 展示层虚拟牌身份（ADR-0007）：牌局记录只有点数，花色在浏览器里合成。
// 花色不参与任何斗地主判断 —— 合法性仍由服务端裁定（ADR-0001）。
//
// 一张虚拟牌的身份 = (点数, 该点数在本局里的第几次出现)。
// 每点数恰好四张，四个花色各用一次，整局 54 张的 (点数, 花色) 组合天然不重复。
// 出现次序由调用方按「我已打出的牌 + 当前手牌」算好传进来。
//
// 这里全是纯函数，不碰 DOM，方便 node --test 直接验算法。

// 只有四个代号与判定，人看的字形在 labels.js（SUIT_GLYPH）。
export const SUITS = ['S', 'H', 'D', 'C'];          // 顺序只决定遍历次序，不代表大小
const RED_SUITS = new Set(['H', 'D']);

export function isRedSuit(suit){ return RED_SUITS.has(suit); }

/** 每点数四张牌的花色排列：以 record_id + 点数为种子做一次确定性洗牌。 */
export function rankSuits(recordId, rank){
  const order = SUITS.slice();
  let h = 2166136261;                                // FNV-1a：不引第三方依赖
  const key = `${recordId || ''}|${rank}`;
  for (let i = 0; i < key.length; i++){
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i = order.length - 1; i > 0; i--){        // Fisher-Yates
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;        // xorshift32，够用且确定
    const j = (h >>> 0) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * 第 k 次出现的这张牌是什么花色。k 从 0 起；同点数四张会拿到四个不同花色。
 * 大小王没有花色，返回 null。
 */
export function suitOf(recordId, rank, k){
  if (rank === 'B' || rank === 'R') return null;
  const order = rankSuits(recordId, rank);
  const i = ((k % order.length) + order.length) % order.length;
  return order[i];
}

/** 一串点数里每个点数各出现几次。 */
export function rankCounts(ranks = []){
  const counts = {};
  for (const rank of ranks) counts[rank] = (counts[rank] || 0) + 1;
  return counts;
}

/**
 * 按出现次序给手牌配花色。
 * @param ranks 手牌（保持服务器给的顺序）
 * @param playedCounts 我已打出的各点数张数 —— 手牌里的第 j 张同点数是我这一摞里的第 (playedCounts[rank] + j) 张，
 *                     这样打完靠左的几张后，手里剩下那几张的花色不会跟着跳。
 */
export function handCards(recordId, ranks = [], playedCounts = {}){
  const seen = {};
  return ranks.map(rank => {
    const at = (playedCounts[rank] || 0) + (seen[rank] || 0);
    seen[rank] = (seen[rank] || 0) + 1;
    return { rank, suit: suitOf(recordId, rank, at) };
  });
}

/**
 * 出牌区（上一手）那几张配花色。默认发该点数**最后几个**花色：出牌区留着刚打出的牌，
 * 拿尾部最省事，也和我方手牌从中段起的区间错开，两边不会撞色。
 *
 * @param playedCounts 我已打出的各点数张数（同 handCards）
 * @param mine 这一手是我打的吗 —— 是的话按我打出的那几张的序号发，
 *             手牌里那几张的花色能原样跟到出牌区。
 */
export function trickCards(recordId, ranks = [], playedCounts = {}, mine = false){
  const total = SUITS.length;
  const size = rankCounts(ranks);
  const seen = {};
  return ranks.map(rank => {
    const i = seen[rank] || 0;
    seen[rank] = i + 1;
    // 大小王没有花色，序号只是走个过场（suitOf 直接返回 null）
    const at = mine
      ? (playedCounts[rank] || 0) - size[rank] + i
      : total - size[rank] + i;
    return { rank, suit: suitOf(recordId, rank, at) };
  });
}

/** 上一手是不是我打的：我的出牌记录尾部正好是这几张。 */
export function isMyTrick(played = [], trick = []){
  if (!trick.length || trick.length > played.length) return false;
  const from = played.length - trick.length;
  return trick.every((rank, i) => played[from + i] === rank);
}
