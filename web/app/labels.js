// 面向人的名字：点数、牌面、座位。
// 页面只做显示 —— 这里没有任何规则，也不推导任何业务数字。

export const RANKS = ['3','4','5','6','7','8','9','T','J','Q','K','A','2','B','R'];

export const NAME = {3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',T:'10',J:'J',Q:'Q',K:'K',
                     A:'A',2:'2',B:'小王',R:'大王'};

// 牌面上位置窄，"小王/大王"会撑破卡片，缩成"小/大"
const SHORT = {B:'小', R:'大'};

const SEAT = {landlord:'地主', landlord_down:'下家', landlord_up:'上家'};

export const countIn = (cards, c) => cards.filter(x => x === c).length;

export const label = seat => SEAT[seat] || seat;

export function card(c){ return `<i class="c">${SHORT[c] || NAME[c] || c}</i>`; }

export function back(){ return '<i class="bk"></i>'; }
