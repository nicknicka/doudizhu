// 面向人的名字：点数、牌面、座位、身份。
// 页面只做显示 —— 这里没有任何规则，也不推导任何业务数字。
// 相对位置与身份由服务端算好（出手顺序是领域知识），这里只负责换成人话。

import { S } from './state.js';

export const RANKS = ['3','4','5','6','7','8','9','T','J','Q','K','A','2','B','R'];

export const NAME = {3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',T:'10',J:'J',Q:'Q',K:'K',
                     A:'A',2:'2',B:'小王',R:'大王'};

// 牌面上位置窄，"小王/大王"会撑破卡片，缩成"小/大"
const SHORT = {B:'小', R:'大'};

// 牌面的花色字形。算法那边只认 S/H/D/C 四个代号（见 app/virtual-cards.js），
// 人看的字形留在这一处 —— 改文案只动这里。
export const SUIT_GLYPH = {S:'♠', H:'♥', D:'♦', C:'♣'};

// 相对位置以**我方**为参照；身份是另一回事，两者不可混用
const RELATIVE = {me:'我', up:'上家', down:'下家'};
const IDENTITY = {landlord:'地主', peasant:'农民'};

export const countIn = (cards, c) => cards.filter(x => x === c).length;

export function card(c){ return `<i class="c">${SHORT[c] || NAME[c] || c}</i>`; }

const seatOf = player => (S.meta && S.meta.seats && S.meta.seats[player]) || null;

/** 这个座位在人话里叫什么（我 / 上家 / 下家）。 */
export function label(player){
  const seat = seatOf(player);
  return seat ? (RELATIVE[seat.relative] || player) : player;
}

/** 身份徽章上的字（地主 / 农民）。 */
export function identityLabel(player){
  const seat = seatOf(player);
  return seat ? (IDENTITY[seat.identity] || '') : '';
}

export function isMe(player){
  const seat = seatOf(player);
  return Boolean(seat) && seat.relative === 'me';
}

/** 说给人听时用第二人称。 */
export const actorName = player => (isMe(player) ? '你' : label(player));

/** "现在该谁出牌" —— 轮到我时说得直白一点。 */
export const turnText = acting => (isMe(acting) ? '轮到你出牌' : `现在该 ${label(acting)} 出牌`);

/** 牌局结束之后没有"该谁出牌"这回事 —— 一律用这句，别再报行动方。 */
export const overText = winner =>
  `牌局已结束${winner ? `：${actorName(winner)}先出完牌` : ''}`;
