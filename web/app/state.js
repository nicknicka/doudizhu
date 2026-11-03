// 应用状态。页面自己不算任何业务数字 —— 这里的数字全部来自后端。

export const $ = id => document.getElementById(id);

export const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 后端取来的状态。 */
export const S = {record:null, meta:null, snap:null, point:null, metrics:null,
                  calibration:null, caveat:'', pinned:null, busy:false,
                  barMode:'count', config:null};   // 机顶条：count=记牌 / prob=概率

/** 用户正在点选的牌。开局是手牌 / 底牌，录一手是本手。 */
export const SEL = {hand:[], cards:[], play:[]};

/** 开局面板：点牌往哪儿加。 */
export const PAD = {target:'hand'};
